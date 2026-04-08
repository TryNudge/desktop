use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_store::StoreExt;

// ── Config ─────────────────────────────────────────────────────────────────

const PLATFORM_URL: &str = match option_env!("NUDGE_PLATFORM_URL") {
    Some(url) => url,
    None => "http://localhost:3000",
};

// ── Auth state ─────────────────────────────────────────────────────────────

struct AuthToken(Mutex<Option<String>>);
struct ActiveQuery(Mutex<Option<String>>);
struct CompletedSteps(Mutex<Vec<String>>);
struct ResearchMode(Mutex<bool>);
struct SessionId(Mutex<Option<String>>);
struct PendingAnswer(Mutex<Option<AnswerPayload>>);

// ── Agent state ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentActivityEntry {
    id: String,
    #[serde(rename = "type")]
    entry_type: String,
    content: String,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_name: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentWindowTarget {
    hwnd: i64,
    title: String,
    process_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentData {
    id: String,
    name: String,
    icon: Option<String>,
    windows: Vec<AgentWindowTarget>,
    interval: u64,
    goal: String,
    mode: String,
    status: String,
    last_activity: Option<String>,
    created_at: String,
    activity_log: Vec<AgentActivityEntry>,
    has_run: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentActivityEvent {
    agent_id: String,
    entry: AgentActivityEntry,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentStatusEvent {
    agent_id: String,
    status: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentIconEvent {
    agent_id: String,
    icon: String,
}

struct AgentManager {
    agents: Mutex<HashMap<String, AgentData>>,
    cancel_senders: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

// ── Keybinds ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Keybinds {
    open_nudge: String,
    next_step: String,
    dismiss: String,
}

impl Default for Keybinds {
    fn default() -> Self {
        Self {
            open_nudge: "ctrl+shift+n".to_string(),
            next_step: "ctrl+shift+arrowright".to_string(),
            dismiss: "ctrl+shift+arrowleft".to_string(),
        }
    }
}

struct KeybindState(Mutex<Keybinds>);

// ── Sidecar management ──────────────────────────────────────────────────────

struct Sidecar(Mutex<Option<SidecarProcess>>);

struct SidecarProcess {
    child: Child,
}

impl SidecarProcess {
    fn send(&mut self, request: &serde_json::Value) -> Result<serde_json::Value, String> {
        let stdin = self.child.stdin.as_mut().ok_or("sidecar stdin closed")?;
        let stdout = self.child.stdout.as_mut().ok_or("sidecar stdout closed")?;

        let mut line = serde_json::to_string(request).map_err(|e| e.to_string())?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("write to sidecar: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("flush sidecar: {}", e))?;

        let mut reader = BufReader::new(stdout);
        let mut response_line = String::new();
        reader
            .read_line(&mut response_line)
            .map_err(|e| format!("read from sidecar: {}", e))?;

        serde_json::from_str(&response_line).map_err(|e| format!("parse sidecar response: {}", e))
    }
}

fn spawn_sidecar(app: &tauri::App) -> Result<SidecarProcess, String> {
    let current_exe = std::env::current_exe().unwrap_or_default();
    eprintln!("[nudge] current exe: {}", current_exe.display());
    let exe_dir = current_exe
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();
    eprintln!("[nudge] exe dir: {}", exe_dir.display());

    // In dev mode, always prefer Python so we pick up code changes
    #[cfg(not(dev))]
    {
        let sidecar_names = [
            "sidecar-x86_64-pc-windows-msvc.exe",
            "sidecar.exe",
        ];

        for name in &sidecar_names {
            let path = exe_dir.join(name);
            if path.exists() {
                eprintln!("[nudge] using bundled sidecar: {}", path.display());
                let child = Command::new(&path)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .creation_flags(0x08000000)
                    .spawn()
                    .map_err(|e| format!("failed to spawn bundled sidecar: {}", e))?;
                return Ok(SidecarProcess { child });
            }
        }

        if let Ok(resource_dir) = app.path().resource_dir() {
            for name in &sidecar_names {
                let path = resource_dir.join(name);
                if path.exists() {
                    eprintln!("[nudge] using resource sidecar: {}", path.display());
                    let child = Command::new(&path)
                        .stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::inherit())
                        .creation_flags(0x08000000)
                        .spawn()
                        .map_err(|e| format!("failed to spawn resource sidecar: {}", e))?;
                    return Ok(SidecarProcess { child });
                }
            }
        }
    }

    // Dev mode / fallback: use Python directly
    eprintln!("[nudge] bundled sidecar not found, falling back to Python");
    let project_root = find_project_root_dev()?;
    let sidecar_path = project_root.join("sidecar").join("server.py");

    let venv_python = project_root.join("venv").join("Scripts").join("python.exe");
    let python = if venv_python.exists() {
        venv_python.to_string_lossy().to_string()
    } else {
        "python".to_string()
    };

    eprintln!("[nudge] using python: {}, script: {}", python, sidecar_path.display());

    let child = Command::new(&python)
        .arg(&sidecar_path)
        .current_dir(&project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn python sidecar: {}", e))?;

    Ok(SidecarProcess { child })
}

fn find_project_root_dev() -> Result<std::path::PathBuf, String> {
    let candidates = [
        std::env::current_dir().unwrap_or_default(),
        std::env::current_dir().unwrap_or_default().join(".."),
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join("..")
            .join("..")
            .join(".."),
    ];

    for candidate in &candidates {
        let root = candidate.canonicalize().unwrap_or(candidate.clone());
        if root.join("sidecar").join("server.py").exists() {
            return Ok(root);
        }
    }

    Err("could not find project root for dev mode".to_string())
}

// ── Data types ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
struct StepTarget {
    description: String,
    element_name: String,
    x: f64,
    y: f64,
    bbox: Option<BBox>,
    confidence: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct BBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Step {
    step_number: i32,
    instruction: String,
    target: StepTarget,
    action_type: String,
    action_detail: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct StepPlan {
    app_context: String,
    steps: Vec<Step>,
    scale_factor: f64,
    monitor_offset_x: i32,
    monitor_offset_y: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct AnswerPayload {
    title: String,
    content: String,
    copyable_text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct NudgeResponse {
    response_type: String,
    app_context: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<AnswerPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    steps: Option<Vec<Step>>,
    #[serde(default)]
    session_id: String,
    #[serde(default = "default_scale")]
    scale_factor: f64,
    #[serde(default)]
    monitor_offset_x: i32,
    #[serde(default)]
    monitor_offset_y: i32,
}

fn default_scale() -> f64 { 1.0 }

#[derive(Serialize, Deserialize, Debug, Clone)]
struct AuthState {
    authenticated: bool,
    email: Option<String>,
    plan: Option<String>,
}

// ── Auth commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn login() -> Result<String, String> {
    let url = format!("{}/auth/desktop-login", PLATFORM_URL);
    eprintln!("[nudge] opening browser for login: {}", url);
    open::that(&url).map_err(|e| format!("failed to open browser: {}", e))?;
    Ok(url)
}

#[tauri::command]
async fn logout(app_handle: AppHandle, token_state: State<'_, AuthToken>) -> Result<(), String> {
    let token = {
        let guard = token_state.0.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    if let Some(token) = token {
        // Revoke token on backend (best-effort)
        let url = format!("{}/api/v1/auth/logout", PLATFORM_URL);
        let client = reqwest::Client::new();
        let _ = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await;
    }

    // Clear in-memory token
    {
        let mut guard = token_state.0.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    // Clear persistent store
    if let Ok(store) = app_handle.store("auth.json") {
        store.delete("api_token");
        let _ = store.save();
    }

    // Hide settings, show splash
    if let Some(settings) = app_handle.get_webview_window("settings") {
        let _ = settings.hide();
    }
    if let Some(splash) = app_handle.get_webview_window("splash") {
        let _ = splash.center();
        let _ = splash.show();
        let _ = splash.set_focus();
    }

    eprintln!("[nudge] logged out — token cleared from memory and store");
    Ok(())
}

#[tauri::command]
async fn get_auth_state(app_handle: AppHandle, token_state: State<'_, AuthToken>) -> Result<AuthState, String> {
    let token = {
        let guard = token_state.0.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let token = match token {
        Some(t) => t,
        None => {
            return Ok(AuthState {
                authenticated: false,
                email: None,
                plan: None,
            });
        }
    };

    // Validate token with backend
    let url = format!("{}/api/v1/auth/me", PLATFORM_URL);
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    if !response.status().is_success() {
        // Token is invalid, clear it from memory and persistent store
        let mut guard = token_state.0.lock().map_err(|e| e.to_string())?;
        *guard = None;
        drop(guard);
        if let Ok(store) = app_handle.store("auth.json") {
            store.delete("api_token");
            let _ = store.save();
        }
        eprintln!("[nudge] auth token invalid — cleared from store");
        return Ok(AuthState {
            authenticated: false,
            email: None,
            plan: None,
        });
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("parse error: {}", e))?;

    Ok(AuthState {
        authenticated: true,
        email: data.get("email").and_then(|v| v.as_str()).map(String::from),
        plan: data.get("plan").and_then(|v| v.as_str()).map(String::from),
    })
}

#[tauri::command]
async fn set_auth_token(token: String, token_state: State<'_, AuthToken>) -> Result<(), String> {
    let mut guard = token_state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(token);
    eprintln!("[nudge] auth token set");
    Ok(())
}

#[tauri::command]
async fn show_input(app_handle: AppHandle) -> Result<(), String> {
    if let Some(input_win) = app_handle.get_webview_window("input") {
        let _ = input_win.center();
        let _ = input_win.show();
        let _ = input_win.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn show_dashboard(app_handle: AppHandle) -> Result<(), String> {
    if let Some(win) = app_handle.get_webview_window("dashboard") {
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_focus();
    }
    Ok(())
}

// ── Agent commands ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
struct WindowEntry {
    hwnd: i64,
    title: String,
    process_name: String,
    icon_b64: Option<String>,
    rect: serde_json::Value,
}

#[tauri::command]
async fn enumerate_windows(sidecar: State<'_, Sidecar>) -> Result<Vec<WindowEntry>, String> {
    let request = serde_json::json!({"method": "enumerate_windows", "params": {}});
    let response = {
        let mut guard = sidecar.0.lock().map_err(|e| e.to_string())?;
        let proc = guard.as_mut().ok_or("sidecar not running")?;
        proc.send(&request)?
    };
    // Check for sidecar error
    if let Some(err) = response.get("error") {
        return Err(format!("sidecar error: {}", err));
    }
    let result = response.get("result")
        .ok_or_else(|| format!("no result from sidecar, got: {}", response))?;
    let arr = result.as_array()
        .ok_or_else(|| format!("result is not an array: {}", result))?;
    let windows: Vec<WindowEntry> = arr
        .iter()
        .filter_map(|v| {
            serde_json::from_value(v.clone()).map_err(|e| {
                eprintln!("[nudge] failed to parse window entry: {} — {:?}", e, v);
                e
            }).ok()
        })
        .collect();
    eprintln!("[nudge] enumerate_windows: {} windows found", windows.len());
    Ok(windows)
}

#[tauri::command]
async fn create_agent(
    app_handle: AppHandle,
    token_state: State<'_, AuthToken>,
    agent_mgr: State<'_, AgentManager>,
    name: String,
    windows: Vec<AgentWindowTarget>,
    interval: u64,
    goal: String,
    mode: String,
) -> Result<AgentData, String> {
    let token = token_state.0.lock().map_err(|e| e.to_string())?
        .clone().ok_or("not authenticated")?;

    // Create agent via NudgePlatform API
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "name": name,
        "windows": windows.iter().map(|w| serde_json::json!({"title": w.title, "processName": w.process_name})).collect::<Vec<_>>(),
        "interval": interval,
        "goal": goal,
        "mode": mode,
    });

    let resp = client
        .post(format!("{}/api/v1/agents", PLATFORM_URL))
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API error: {}", text));
    }

    let api_agent: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let id = api_agent["id"].as_str().unwrap_or("unknown").to_string();

    let now = chrono_now();
    let agent = AgentData {
        id: id.clone(),
        name,
        icon: None,
        windows,
        interval,
        goal,
        mode,
        status: "idle".to_string(),
        last_activity: None,
        created_at: now,
        activity_log: vec![],
        has_run: false,
    };

    agent_mgr.agents.lock().map_err(|e| e.to_string())?.insert(id, agent.clone());
    let _ = app_handle.emit("agent-created", &agent);
    Ok(agent)
}

#[tauri::command]
async fn get_agents(
    token_state: State<'_, AuthToken>,
    agent_mgr: State<'_, AgentManager>,
) -> Result<Vec<AgentData>, String> {
    let token = token_state.0.lock().map_err(|e| e.to_string())?
        .clone().ok_or("not authenticated")?;

    // Fetch from platform API
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/api/v1/agents", PLATFORM_URL))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    if !resp.status().is_success() {
        // Fall back to local cache
        let agents = agent_mgr.agents.lock().map_err(|e| e.to_string())?;
        return Ok(agents.values().cloned().collect());
    }

    let api_agents: Vec<serde_json::Value> = resp.json().await.map_err(|e| e.to_string())?;
    let mut cache = agent_mgr.agents.lock().map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for a in api_agents {
        let id = a["id"].as_str().unwrap_or("").to_string();
        if let Some(existing) = cache.get(&id) {
            // Keep local state (status, activity_log) but sync config from server
            let mut merged = existing.clone();
            merged.name = a["name"].as_str().unwrap_or(&merged.name).to_string();
            merged.icon = a["icon"].as_str().map(|s| s.to_string()).or(merged.icon.clone());
            merged.goal = a["goal"].as_str().unwrap_or(&merged.goal).to_string();
            merged.mode = a["mode"].as_str().unwrap_or(&merged.mode).to_string();
            merged.interval = a["interval"].as_u64().unwrap_or(merged.interval);
            cache.insert(id, merged.clone());
            result.push(merged);
        } else {
            // New agent from server
            let windows: Vec<AgentWindowTarget> = a["windows"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|w| {
                    Some(AgentWindowTarget {
                        hwnd: 0, // will be re-resolved on this PC
                        title: w["title"].as_str()?.to_string(),
                        process_name: w["processName"].as_str().unwrap_or("").to_string(),
                    })
                }).collect())
                .unwrap_or_default();

            // Build activity log from server activities
            let activities: Vec<AgentActivityEntry> = a["activities"]
                .as_array()
                .map(|arr| arr.iter().filter_map(|act| {
                    Some(AgentActivityEntry {
                        id: act["id"].as_str()?.to_string(),
                        entry_type: act["type"].as_str()?.to_string(),
                        content: act["content"].as_str()?.to_string(),
                        timestamp: act["createdAt"].as_str()?.to_string(),
                        duration_ms: act["durationMs"].as_u64(),
                        details: act["details"].as_str().map(|s| s.to_string()),
                        window_name: act["windowName"].as_str().map(|s| s.to_string()),
                    })
                }).collect())
                .unwrap_or_default();

            let agent = AgentData {
                id: id.clone(),
                name: a["name"].as_str().unwrap_or("").to_string(),
                icon: a["icon"].as_str().map(|s| s.to_string()),
                windows,
                interval: a["interval"].as_u64().unwrap_or(10),
                goal: a["goal"].as_str().unwrap_or("").to_string(),
                mode: a["mode"].as_str().unwrap_or("guide").to_string(),
                status: "idle".to_string(),
                last_activity: None,
                created_at: a["createdAt"].as_str().unwrap_or("").to_string(),
                activity_log: activities,
                has_run: a["icon"].as_str().is_some(), // if icon exists, it has run before
            };
            cache.insert(id, agent.clone());
            result.push(agent);
        }
    }

    Ok(result)
}

#[tauri::command]
async fn delete_agent(
    app_handle: AppHandle,
    token_state: State<'_, AuthToken>,
    agent_mgr: State<'_, AgentManager>,
    id: String,
) -> Result<(), String> {
    // Stop if running
    {
        let senders = agent_mgr.cancel_senders.lock().map_err(|e| e.to_string())?;
        if let Some(sender) = senders.get(&id) {
            let _ = sender.send(true);
        }
    }

    // Delete from platform
    let token = token_state.0.lock().map_err(|e| e.to_string())?
        .clone().ok_or("not authenticated")?;
    let client = reqwest::Client::new();
    let _ = client
        .delete(format!("{}/api/v1/agents/{}", PLATFORM_URL, id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await;

    // Remove from local cache
    agent_mgr.agents.lock().map_err(|e| e.to_string())?.remove(&id);
    agent_mgr.cancel_senders.lock().map_err(|e| e.to_string())?.remove(&id);

    let _ = app_handle.emit("agent-deleted", &id);
    Ok(())
}

#[tauri::command]
async fn update_agent(
    token_state: State<'_, AuthToken>,
    agent_mgr: State<'_, AgentManager>,
    id: String,
    name: Option<String>,
    windows: Option<Vec<AgentWindowTarget>>,
    interval: Option<u64>,
    goal: Option<String>,
    mode: Option<String>,
) -> Result<AgentData, String> {
    let token = token_state.0.lock().map_err(|e| e.to_string())?
        .clone().ok_or("not authenticated")?;

    let mut body = serde_json::Map::new();
    if let Some(v) = &name { body.insert("name".into(), serde_json::json!(v)); }
    if let Some(v) = &windows {
        body.insert("windows".into(), serde_json::json!(v.iter().map(|w| serde_json::json!({"title": w.title, "processName": w.process_name})).collect::<Vec<_>>()));
    }
    if let Some(v) = interval { body.insert("interval".into(), serde_json::json!(v)); }
    if let Some(v) = &goal { body.insert("goal".into(), serde_json::json!(v)); }
    if let Some(v) = &mode { body.insert("mode".into(), serde_json::json!(v)); }

    let client = reqwest::Client::new();
    let _ = client
        .patch(format!("{}/api/v1/agents/{}", PLATFORM_URL, id))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::Value::Object(body))
        .send()
        .await;

    // Update local cache
    let mut cache = agent_mgr.agents.lock().map_err(|e| e.to_string())?;
    let agent = cache.get_mut(&id).ok_or("agent not found")?;
    if let Some(v) = name { agent.name = v; }
    if let Some(v) = windows { agent.windows = v; }
    if let Some(v) = interval { agent.interval = v; }
    if let Some(v) = goal { agent.goal = v; }
    if let Some(v) = mode { agent.mode = v; }

    Ok(agent.clone())
}

#[tauri::command]
async fn start_agent(
    app_handle: AppHandle,
    token_state: State<'_, AuthToken>,
    sidecar: State<'_, Sidecar>,
    agent_mgr: State<'_, AgentManager>,
    id: String,
) -> Result<(), String> {
    let token = token_state.0.lock().map_err(|e| e.to_string())?
        .clone().ok_or("not authenticated")?;

    // Read agent config
    let agent = {
        let cache = agent_mgr.agents.lock().map_err(|e| e.to_string())?;
        cache.get(&id).cloned().ok_or("agent not found")?
    };

    // Create cancellation channel
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut senders = agent_mgr.cancel_senders.lock().map_err(|e| e.to_string())?;
        senders.insert(id.clone(), cancel_tx);
    }

    // Set status to running
    {
        let mut cache = agent_mgr.agents.lock().map_err(|e| e.to_string())?;
        if let Some(a) = cache.get_mut(&id) {
            a.status = "running".to_string();
        }
    }

    let _ = app_handle.emit("agent-status-changed", AgentStatusEvent {
        agent_id: id.clone(),
        status: "running".to_string(),
    });

    // Emit system entry
    let sys_entry = AgentActivityEntry {
        id: format!("e-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
        entry_type: "system".to_string(),
        content: format!("Agent started. Monitoring {} window(s) every {}s.", agent.windows.len(), agent.interval),
        timestamp: chrono_now(),
        duration_ms: None, details: None, window_name: None,
    };
    {
        let mut cache = agent_mgr.agents.lock().map_err(|e| e.to_string())?;
        if let Some(a) = cache.get_mut(&id) {
            a.activity_log.push(sys_entry.clone());
        }
    }
    let _ = app_handle.emit("agent-activity", AgentActivityEvent { agent_id: id.clone(), entry: sys_entry });

    // Spawn the async runner
    let app = app_handle.clone();
    let agent_id = id.clone();
    let is_first_run = !agent.has_run;
    tauri::async_runtime::spawn(async move {
        run_agent_loop(app, agent_id, token, agent, cancel_rx, is_first_run).await;
    });

    Ok(())
}

async fn run_agent_loop(
    app: AppHandle,
    agent_id: String,
    token: String,
    agent: AgentData,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
    mut is_first_run: bool,
) {
    let interval_secs = agent.interval;
    let windows = agent.windows.clone();

    loop {
        if *cancel_rx.borrow() { break; }

        // 1. Re-resolve HWNDs by enumerating current windows and matching by title
        let resolved_windows = {
            let enum_request = serde_json::json!({"method": "enumerate_windows", "params": {}});
            let enum_result = {
                let sidecar_state = app.state::<Sidecar>();
                let mut guard = match sidecar_state.0.lock() {
                    Ok(g) => g,
                    Err(_) => { eprintln!("[nudge] agent {}: sidecar lock failed", agent_id); continue; },
                };
                match guard.as_mut() {
                    Some(proc) => proc.send(&enum_request).ok(),
                    None => None,
                }
            };

            let mut resolved = Vec::new();
            if let Some(resp) = enum_result {
                if let Some(arr) = resp.get("result").and_then(|v| v.as_array()) {
                    for target in &windows {
                        // Match by title substring or process name
                        for w in arr {
                            let title = w["title"].as_str().unwrap_or("");
                            let proc = w["process_name"].as_str().unwrap_or("");
                            let hwnd = w["hwnd"].as_i64().unwrap_or(0);
                            if hwnd > 0 && (title == target.title || proc == target.process_name) {
                                resolved.push((hwnd, target.title.clone()));
                                break;
                            }
                        }
                    }
                }
            }
            resolved
        };

        // 2. Capture screenshots
        let mut screenshots = Vec::new();
        for (hwnd, title) in &resolved_windows {
            let request = serde_json::json!({
                "method": "capture_window",
                "params": {"hwnd": hwnd}
            });

            let capture_result = {
                let sidecar_state = app.state::<Sidecar>();
                let mut guard = match sidecar_state.0.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                match guard.as_mut() {
                    Some(proc) => proc.send(&request),
                    None => continue,
                }
            };

            match capture_result {
                Ok(resp) => {
                    if let Some(err) = resp.get("error") {
                        eprintln!("[nudge] agent {}: capture_window error for '{}' (hwnd {}): {}", agent_id, title, hwnd, err);
                        emit_dev_log(&app, "sidecar", "warn", &format!("capture_window failed for '{}' (hwnd {}): {}", title, hwnd, err));
                    } else if let Some(result) = resp.get("result") {
                        screenshots.push(serde_json::json!({
                            "window_title": title,
                            "screenshot_b64": result.get("screenshot_b64").and_then(|v| v.as_str()).unwrap_or(""),
                            "dimensions": result.get("screenshot_dimensions"),
                        }));
                    } else {
                        eprintln!("[nudge] agent {}: unexpected sidecar response for '{}': {}", agent_id, title, resp);
                    }
                }
                Err(e) => {
                    eprintln!("[nudge] agent {}: sidecar call failed for '{}': {}", agent_id, title, e);
                }
            }
        }

        if screenshots.is_empty() {
            eprintln!("[nudge] agent {}: no screenshots captured, skipping", agent_id);
            emit_dev_log(&app, "agent", "warn", &format!("agent {}: no screenshots captured, skipping", agent_id));
        } else {
            // 2. Call platform /api/v1/agents/:id/run
            eprintln!("[nudge] agent {}: sending {} screenshots to platform", agent_id, screenshots.len());
            emit_dev_log(&app, "agent", "info", &format!("agent {}: sending {} screenshots to platform", agent_id, screenshots.len()));
            let client = reqwest::Client::new();
            let body = serde_json::json!({
                "screenshots": screenshots,
                "is_first_run": is_first_run,
            });

            let start = std::time::Instant::now();
            let result = client
                .post(format!("{}/api/v1/agents/{}/run", PLATFORM_URL, agent_id))
                .header("Authorization", format!("Bearer {}", token))
                .json(&body)
                .send()
                .await;

            let duration_ms = start.elapsed().as_millis() as u64;

            match result {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(data) = resp.json::<serde_json::Value>().await {
                        let observation = data["observation"].as_str().unwrap_or("No observation").to_string();
                        let details = data["details"].as_str().map(|s| s.to_string());
                        let window_name = data["window_name"].as_str().map(|s| s.to_string());

                        let entry = AgentActivityEntry {
                            id: format!("e-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
                            entry_type: "observation".to_string(),
                            content: observation,
                            timestamp: chrono_now(),
                            duration_ms: Some(duration_ms),
                            details,
                            window_name,
                        };

                        // Update local cache
                        {
                            let mgr = app.state::<AgentManager>();
                            let mut cache = mgr.agents.lock().unwrap_or_else(|e| e.into_inner());
                            if let Some(a) = cache.get_mut(&agent_id) {
                                a.activity_log.push(entry.clone());
                                a.last_activity = Some(chrono_now());
                                if is_first_run {
                                    a.has_run = true;
                                }
                            }
                        }

                        let _ = app.emit("agent-activity", AgentActivityEvent { agent_id: agent_id.clone(), entry });
                        emit_dev_log(&app, "agent", "info", &format!("agent {} observation ({}ms): {}", agent_id, duration_ms, data["observation"].as_str().unwrap_or("")));
                        emit_dev_log(&app, "platform", "debug", &format!("raw response: {}", serde_json::to_string(&data).unwrap_or_default()));

                        // Handle icon from first run
                        if is_first_run {
                            if let Some(icon) = data["icon"].as_str() {
                                let mgr = app.state::<AgentManager>();
                                let mut cache = mgr.agents.lock().unwrap_or_else(|e| e.into_inner());
                                if let Some(a) = cache.get_mut(&agent_id) {
                                    a.icon = Some(icon.to_string());
                                }
                                let _ = app.emit("agent-icon-updated", AgentIconEvent {
                                    agent_id: agent_id.clone(),
                                    icon: icon.to_string(),
                                });
                            }
                            is_first_run = false;
                        }
                    }
                }
                Ok(resp) => {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    eprintln!("[nudge] agent {} run failed: {} {}", agent_id, status, text);
                    emit_dev_log(&app, "agent", "error", &format!("agent {} run failed: {} {}", agent_id, status, text));
                    let entry = AgentActivityEntry {
                        id: format!("e-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
                        entry_type: "system".to_string(),
                        content: format!("Error: API returned {}", status),
                        timestamp: chrono_now(),
                        duration_ms: Some(duration_ms), details: Some(text), window_name: None,
                    };
                    let _ = app.emit("agent-activity", AgentActivityEvent { agent_id: agent_id.clone(), entry });
                }
                Err(e) => {
                    eprintln!("[nudge] agent {} network error: {}", agent_id, e);
                    emit_dev_log(&app, "agent", "error", &format!("agent {} network error: {}", agent_id, e));
                    let entry = AgentActivityEntry {
                        id: format!("e-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
                        entry_type: "system".to_string(),
                        content: format!("Network error: {}", e),
                        timestamp: chrono_now(),
                        duration_ms: None, details: None, window_name: None,
                    };
                    let _ = app.emit("agent-activity", AgentActivityEvent { agent_id: agent_id.clone(), entry });
                }
            }
        }

        // 3. Sleep for interval, interruptible by cancel
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(interval_secs)) => {},
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() { break; }
            }
        }
    }

    // Cleanup: set status to idle
    {
        let mgr = app.state::<AgentManager>();
        let mut cache = mgr.agents.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(a) = cache.get_mut(&agent_id) {
            a.status = "idle".to_string();
        }
    }
    let stop_entry = AgentActivityEntry {
        id: format!("e-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
        entry_type: "system".to_string(),
        content: "Agent stopped.".to_string(),
        timestamp: chrono_now(),
        duration_ms: None, details: None, window_name: None,
    };
    let _ = app.emit("agent-activity", AgentActivityEvent { agent_id: agent_id.clone(), entry: stop_entry });
    let _ = app.emit("agent-status-changed", AgentStatusEvent { agent_id, status: "idle".to_string() });
}

#[tauri::command]
async fn stop_agent(
    app_handle: AppHandle,
    agent_mgr: State<'_, AgentManager>,
    id: String,
) -> Result<(), String> {
    {
        let senders = agent_mgr.cancel_senders.lock().map_err(|e| e.to_string())?;
        if let Some(sender) = senders.get(&id) {
            let _ = sender.send(true);
        }
    }

    let mut cache = agent_mgr.agents.lock().map_err(|e| e.to_string())?;
    if let Some(agent) = cache.get_mut(&id) {
        agent.status = "idle".to_string();
    }

    let _ = app_handle.emit("agent-status-changed", AgentStatusEvent {
        agent_id: id.clone(),
        status: "idle".to_string(),
    });

    Ok(())
}

#[tauri::command]
async fn send_agent_message(
    app_handle: AppHandle,
    token_state: State<'_, AuthToken>,
    agent_mgr: State<'_, AgentManager>,
    id: String,
    content: String,
) -> Result<(), String> {
    let token = token_state.0.lock().map_err(|e| e.to_string())?
        .clone().ok_or("not authenticated")?;

    // Send to platform API
    let client = reqwest::Client::new();
    let _ = client
        .post(format!("{}/api/v1/agents/{}/message", PLATFORM_URL, id))
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"content": content}))
        .send()
        .await;

    let now = chrono_now();
    let entry = AgentActivityEntry {
        id: format!("e-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
        entry_type: "user".to_string(),
        content: content.clone(),
        timestamp: now,
        duration_ms: None,
        details: None,
        window_name: None,
    };

    // Add to local cache
    {
        let mut cache = agent_mgr.agents.lock().map_err(|e| e.to_string())?;
        if let Some(agent) = cache.get_mut(&id) {
            agent.activity_log.push(entry.clone());
        }
    }

    let _ = app_handle.emit("agent-activity", AgentActivityEvent {
        agent_id: id,
        entry,
    });

    Ok(())
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}", now)
}

#[derive(Serialize, Clone)]
struct DevLogEvent {
    source: String,
    level: String,
    message: String,
    timestamp: String,
}

fn emit_dev_log(app: &AppHandle, source: &str, level: &str, msg: &str) {
    let _ = app.emit("dev-log", DevLogEvent {
        source: source.to_string(),
        level: level.to_string(),
        message: msg.to_string(),
        timestamp: chrono_now(),
    });
}

// ── Keybind commands ───────────────────────────────────────────────────────

#[tauri::command]
async fn pause_shortcuts(app_handle: AppHandle, keybind_state: State<'_, KeybindState>) -> Result<(), String> {
    let kb = keybind_state.0.lock().map_err(|e| e.to_string())?.clone();
    let gs = app_handle.global_shortcut();
    for key in [&kb.open_nudge, &kb.next_step, &kb.dismiss] {
        if let Ok(s) = key.parse::<tauri_plugin_global_shortcut::Shortcut>() {
            let _ = gs.unregister(s);
        }
    }
    eprintln!("[nudge] global shortcuts paused for recording");
    Ok(())
}

#[tauri::command]
async fn resume_shortcuts(app_handle: AppHandle, keybind_state: State<'_, KeybindState>) -> Result<(), String> {
    let kb = keybind_state.0.lock().map_err(|e| e.to_string())?.clone();
    let empty = Keybinds { open_nudge: String::new(), next_step: String::new(), dismiss: String::new() };
    reregister_hotkeys(&app_handle, &empty, &kb).map_err(|e| e.to_string())?;
    eprintln!("[nudge] global shortcuts resumed");
    Ok(())
}

#[tauri::command]
async fn get_keybinds(keybind_state: State<'_, KeybindState>) -> Result<Keybinds, String> {
    let guard = keybind_state.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
async fn set_keybind(
    action: String,
    shortcut: String,
    app_handle: AppHandle,
    keybind_state: State<'_, KeybindState>,
) -> Result<Keybinds, String> {
    // Validate the shortcut parses
    shortcut.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("Invalid shortcut '{}': {}", shortcut, e))?;

    let old_keybinds;
    let new_keybinds;
    {
        let mut guard = keybind_state.0.lock().map_err(|e| e.to_string())?;
        old_keybinds = guard.clone();
        match action.as_str() {
            "open_nudge" => guard.open_nudge = shortcut.clone(),
            "next_step" => guard.next_step = shortcut.clone(),
            "dismiss" => guard.dismiss = shortcut.clone(),
            _ => return Err(format!("Unknown action: {}", action)),
        }
        new_keybinds = guard.clone();
    }

    // Re-register all hotkeys
    if let Err(e) = reregister_hotkeys(&app_handle, &old_keybinds, &new_keybinds) {
        // Rollback on failure
        let mut guard = keybind_state.0.lock().map_err(|e| e.to_string())?;
        *guard = old_keybinds;
        return Err(format!("Failed to register shortcut: {}", e));
    }

    // Persist to store
    if let Ok(store) = app_handle.store("settings.json") {
        store.set("keybinds", serde_json::to_value(&new_keybinds).unwrap());
        let _ = store.save();
    }

    eprintln!("[nudge] keybind updated: {} = {}", action, shortcut);
    Ok(new_keybinds)
}

fn reregister_hotkeys(app: &AppHandle, old: &Keybinds, new: &Keybinds) -> Result<(), String> {
    let gs = app.global_shortcut();

    // Unregister old shortcuts (ignore errors — they might not be registered)
    for old_key in [&old.open_nudge, &old.next_step, &old.dismiss] {
        if let Ok(s) = old_key.parse::<tauri_plugin_global_shortcut::Shortcut>() {
            let _ = gs.unregister(s);
        }
    }

    // Register new shortcuts
    let open_shortcut = new.open_nudge.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("Invalid open_nudge shortcut: {}", e))?;
    let next_shortcut = new.next_step.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("Invalid next_step shortcut: {}", e))?;
    let dismiss_shortcut = new.dismiss.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("Invalid dismiss shortcut: {}", e))?;

    gs.on_shortcut(open_shortcut, move |app: &AppHandle, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            if let Some(input_win) = app.get_webview_window("input") {
                let _ = input_win.center();
                let _ = input_win.show();
                let _ = input_win.set_focus();
            }
        }
    }).map_err(|e| e.to_string())?;

    gs.on_shortcut(next_shortcut, move |app: &AppHandle, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = app.emit("global-next-step", ());
        }
    }).map_err(|e| e.to_string())?;

    gs.on_shortcut(dismiss_shortcut, move |app: &AppHandle, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = app.emit("global-dismiss", ());
        }
    }).map_err(|e| e.to_string())?;

    Ok(())
}

// ── Update commands ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
struct UpdateInfo {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

#[tauri::command]
async fn check_for_update(app_handle: AppHandle) -> Result<UpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app_handle.updater().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => {
            eprintln!("[nudge] update available: v{}", update.version);
            Ok(UpdateInfo {
                available: true,
                version: Some(update.version.clone()),
                notes: update.body.clone(),
            })
        }
        Ok(None) => {
            eprintln!("[nudge] no update available");
            Ok(UpdateInfo {
                available: false,
                version: None,
                notes: None,
            })
        }
        Err(e) => {
            eprintln!("[nudge] update check failed: {}", e);
            Ok(UpdateInfo {
                available: false,
                version: None,
                notes: None,
            })
        }
    }
}

#[tauri::command]
async fn install_update(app_handle: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app_handle.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    if let Some(update) = update {
        eprintln!("[nudge] downloading update v{}...", update.version);
        let mut downloaded = 0;
        update
            .download_and_install(
                |chunk_length, content_length| {
                    downloaded += chunk_length;
                    eprintln!(
                        "[nudge] downloaded {} / {}",
                        downloaded,
                        content_length.unwrap_or(0)
                    );
                },
                || {
                    eprintln!("[nudge] download complete, installing...");
                },
            )
            .await
            .map_err(|e| format!("Update install failed: {}", e))?;

        eprintln!("[nudge] update installed, restarting...");
        app_handle.restart();
    }

    Ok(())
}

// ── Query commands (cloud mode uses backend, local mode uses sidecar) ──────

#[tauri::command]
async fn submit_query(
    app: AppHandle,
    query: String,
    research_mode: Option<bool>,
    token_state: State<'_, AuthToken>,
    active_query: State<'_, ActiveQuery>,
    completed_steps: State<'_, CompletedSteps>,
    research_state: State<'_, ResearchMode>,
    session_state: State<'_, SessionId>,
    sidecar: State<'_, Sidecar>,
) -> Result<NudgeResponse, String> {
    let research = research_mode.unwrap_or(false);
    eprintln!("[nudge] submit_query called: {:?} (research={})", query, research);

    // Store query, reset completed steps, store research mode
    {
        let mut q = active_query.0.lock().map_err(|e| e.to_string())?;
        *q = Some(query.clone());
        let mut s = completed_steps.0.lock().map_err(|e| e.to_string())?;
        s.clear();
        let mut r = research_state.0.lock().map_err(|e| e.to_string())?;
        *r = research;
    }

    let token = {
        let guard = token_state.0.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("Not signed in. Please sign in first.")?
    };

    let capture = capture_only(&sidecar)?;
    let backend_resp = call_backend_query(&token, &query, &capture, research).await?;

    // Parse the response to determine type
    let response_type = backend_resp
        .get("response_type")
        .and_then(|v| v.as_str())
        .unwrap_or("steps")
        .to_string();

    // Store session ID
    if let Some(sid) = backend_resp.get("session_id").and_then(|v| v.as_str()) {
        let mut s = session_state.0.lock().map_err(|e| e.to_string())?;
        *s = Some(sid.to_string());
    }

    let session_id = backend_resp
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let scale_factor = backend_resp
        .get("scale_factor")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let monitor_offset_x = backend_resp
        .get("monitor_offset_x")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    let monitor_offset_y = backend_resp
        .get("monitor_offset_y")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    // Parse answer payload if present
    let answer: Option<AnswerPayload> = backend_resp
        .get("answer")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    // Parse and ground steps if present
    let steps: Option<Vec<Step>> = if response_type == "steps" || response_type == "hybrid" {
        // Build a StepPlan for grounding
        let steps_val = backend_resp.get("steps").cloned().unwrap_or(serde_json::json!([]));
        let app_context = backend_resp
            .get("app_context")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let step_plan_json = serde_json::json!({
            "app_context": app_context,
            "steps": steps_val,
            "scale_factor": scale_factor,
            "monitor_offset_x": monitor_offset_x,
            "monitor_offset_y": monitor_offset_y,
        });

        let grounded = ground_plan_sidecar(&sidecar, &step_plan_json, &capture)?;
        Some(grounded.steps)
    } else {
        None
    };

    let result = NudgeResponse {
        response_type: response_type.clone(),
        app_context: backend_resp
            .get("app_context")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        answer,
        steps,
        session_id,
        scale_factor,
        monitor_offset_x,
        monitor_offset_y,
    };

    eprintln!("[nudge] submit_query returning response_type={}, has_answer={}, has_steps={}",
        result.response_type,
        result.answer.is_some(),
        result.steps.is_some()
    );

    // For answer/hybrid responses, store answer in state and show the window
    if result.response_type == "answer" || result.response_type == "hybrid" {
        // Dismiss the overlay loading
        let _ = app.emit("dismiss", serde_json::Value::Null);

        // Store the answer so the window can pull it via get_pending_answer
        if let Some(ref answer_payload) = result.answer {
            if let Some(state) = app.try_state::<PendingAnswer>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(answer_payload.clone());
                }
            }
        }

        if let Some(answer_win) = app.get_webview_window("answer") {
            let _ = answer_win.center();
            let _ = answer_win.show();
            let _ = answer_win.set_focus();
            eprintln!("[nudge] answer window shown from Rust");
        } else {
            eprintln!("[nudge] ERROR: could not find answer window");
        }
    }

    Ok(result)
}

#[tauri::command]
async fn next_step(
    completed_instruction: String,
    token_state: State<'_, AuthToken>,
    active_query: State<'_, ActiveQuery>,
    completed_steps_state: State<'_, CompletedSteps>,
    research_state: State<'_, ResearchMode>,
    sidecar: State<'_, Sidecar>,
) -> Result<StepPlan, String> {
    eprintln!(
        "[nudge] next_step called, completed: {:?}",
        completed_instruction
    );

    let (original_query, steps_so_far, research) = {
        let mut steps = completed_steps_state.0.lock().map_err(|e| e.to_string())?;
        steps.push(completed_instruction.clone());
        let q = active_query.0.lock().map_err(|e| e.to_string())?;
        let r = research_state.0.lock().map_err(|e| e.to_string())?;
        (q.clone().unwrap_or_default(), steps.clone(), *r)
    };

    let token = {
        let guard = token_state.0.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("Not signed in. Please sign in first.")?
    };

    let capture = capture_only(&sidecar)?;
    let plan =
        call_backend_next_step(&token, &original_query, &steps_so_far, &capture, research).await?;
    let grounded = ground_plan_sidecar(&sidecar, &plan, &capture)?;

    Ok(grounded)
}

#[tauri::command]
async fn submit_followup(
    query: String,
    token_state: State<'_, AuthToken>,
    session_state: State<'_, SessionId>,
    research_state: State<'_, ResearchMode>,
    sidecar: State<'_, Sidecar>,
) -> Result<NudgeResponse, String> {
    eprintln!("[nudge] submit_followup called: {:?}", query);

    let token = {
        let guard = token_state.0.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("Not signed in. Please sign in first.")?
    };

    let session_id = {
        let guard = session_state.0.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("No active session")?
    };

    let research = {
        let r = research_state.0.lock().map_err(|e| e.to_string())?;
        *r
    };

    let capture = capture_only(&sidecar)?;
    let backend_resp =
        call_backend_followup(&token, &session_id, &query, &capture, research).await?;

    let response_type = backend_resp
        .get("response_type")
        .and_then(|v| v.as_str())
        .unwrap_or("answer")
        .to_string();

    let scale_factor = backend_resp
        .get("scale_factor")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let monitor_offset_x = backend_resp
        .get("monitor_offset_x")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    let monitor_offset_y = backend_resp
        .get("monitor_offset_y")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    let answer: Option<AnswerPayload> = backend_resp
        .get("answer")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    let steps: Option<Vec<Step>> = if response_type == "steps" || response_type == "hybrid" {
        let steps_val = backend_resp.get("steps").cloned().unwrap_or(serde_json::json!([]));
        let app_context = backend_resp
            .get("app_context")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let step_plan_json = serde_json::json!({
            "app_context": app_context,
            "steps": steps_val,
            "scale_factor": scale_factor,
            "monitor_offset_x": monitor_offset_x,
            "monitor_offset_y": monitor_offset_y,
        });

        let grounded = ground_plan_sidecar(&sidecar, &step_plan_json, &capture)?;
        Some(grounded.steps)
    } else {
        None
    };

    Ok(NudgeResponse {
        response_type,
        app_context: backend_resp
            .get("app_context")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        answer,
        steps,
        session_id: backend_resp
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        scale_factor,
        monitor_offset_x,
        monitor_offset_y,
    })
}

#[tauri::command]
async fn get_pending_answer(
    pending: State<'_, PendingAnswer>,
) -> Result<Option<AnswerPayload>, String> {
    let guard = pending.0.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

// ── Local mode fallback (Ollama, no auth needed) ───────────────────────────

// ── Sidecar helpers ────────────────────────────────────────────────────────

fn capture_only(sidecar: &State<Sidecar>) -> Result<serde_json::Value, String> {
    let mut guard = sidecar.0.lock().map_err(|e| e.to_string())?;
    let proc = guard.as_mut().ok_or("sidecar not running")?;

    let request = serde_json::json!({
        "method": "capture_only",
        "params": {}
    });

    let response = proc.send(&request)?;
    if let Some(error) = response.get("error") {
        return Err(error.to_string());
    }

    response
        .get("result")
        .cloned()
        .ok_or("no result from capture_only".to_string())
}

fn ground_plan_sidecar(
    sidecar: &State<Sidecar>,
    plan: &serde_json::Value,
    _capture: &serde_json::Value,
) -> Result<StepPlan, String> {
    let mut guard = sidecar.0.lock().map_err(|e| e.to_string())?;
    let proc = guard.as_mut().ok_or("sidecar not running")?;

    let request = serde_json::json!({
        "method": "ground_plan",
        "params": { "plan": plan }
    });

    let response = proc.send(&request)?;
    if let Some(error) = response.get("error") {
        return Err(error.to_string());
    }

    let result = response.get("result").ok_or("no result from ground_plan")?;
    serde_json::from_value(result.clone()).map_err(|e| format!("parse grounded plan: {}", e))
}


// ── Backend API calls ──────────────────────────────────────────────────────

async fn call_backend_query(
    token: &str,
    query: &str,
    capture: &serde_json::Value,
    research_mode: bool,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/v1/query", PLATFORM_URL);
    let client = reqwest::Client::new();

    // Extract screenshot base64 and convert to bytes for multipart
    let screenshot_b64 = capture
        .get("screenshot_b64")
        .and_then(|v| v.as_str())
        .ok_or("no screenshot_b64 in capture")?;

    use base64::Engine;
    let screenshot_bytes = base64::engine::general_purpose::STANDARD
        .decode(screenshot_b64)
        .map_err(|e| format!("base64 decode: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("query", query.to_string())
        .text("research_mode", research_mode.to_string())
        .part(
            "screenshot",
            reqwest::multipart::Part::bytes(screenshot_bytes)
                .file_name("screenshot.png")
                .mime_str("image/png")
                .map_err(|e| e.to_string())?,
        )
        .text(
            "screenshot_dimensions",
            capture
                .get("screenshot_dimensions")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
        )
        .text(
            "original_dimensions",
            capture
                .get("original_dimensions")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
        )
        .text(
            "scale_factor",
            capture
                .get("scale_factor")
                .and_then(|v| v.as_f64())
                .map(|v| v.to_string())
                .unwrap_or_else(|| "1".to_string()),
        )
        .text(
            "monitor_offset",
            capture
                .get("monitor_offset")
                .map(|v| v.to_string())
                .unwrap_or_else(|| r#"{"x":0,"y":0}"#.to_string()),
        )
        .text(
            "uia_tree",
            capture
                .get("uia_tree")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string()),
        )
        .text(
            "foreground_window",
            capture
                .get("foreground_window")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string()),
        );

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Backend error ({}): {}", status, body));
    }

    response
        .json()
        .await
        .map_err(|e| format!("parse backend response: {}", e))
}

async fn call_backend_next_step(
    token: &str,
    original_query: &str,
    completed_steps: &[String],
    capture: &serde_json::Value,
    research_mode: bool,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/v1/next-step", PLATFORM_URL);
    let client = reqwest::Client::new();

    let screenshot_b64 = capture
        .get("screenshot_b64")
        .and_then(|v| v.as_str())
        .ok_or("no screenshot_b64 in capture")?;

    use base64::Engine;
    let screenshot_bytes = base64::engine::general_purpose::STANDARD
        .decode(screenshot_b64)
        .map_err(|e| format!("base64 decode: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("original_query", original_query.to_string())
        .text("research_mode", research_mode.to_string())
        .text(
            "completed_steps",
            serde_json::to_string(completed_steps).unwrap_or_else(|_| "[]".to_string()),
        )
        .part(
            "screenshot",
            reqwest::multipart::Part::bytes(screenshot_bytes)
                .file_name("screenshot.png")
                .mime_str("image/png")
                .map_err(|e| e.to_string())?,
        )
        .text(
            "screenshot_dimensions",
            capture
                .get("screenshot_dimensions")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
        )
        .text(
            "original_dimensions",
            capture
                .get("original_dimensions")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
        )
        .text(
            "scale_factor",
            capture
                .get("scale_factor")
                .and_then(|v| v.as_f64())
                .map(|v| v.to_string())
                .unwrap_or_else(|| "1".to_string()),
        )
        .text(
            "monitor_offset",
            capture
                .get("monitor_offset")
                .map(|v| v.to_string())
                .unwrap_or_else(|| r#"{"x":0,"y":0}"#.to_string()),
        )
        .text(
            "uia_tree",
            capture
                .get("uia_tree")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string()),
        )
        .text(
            "foreground_window",
            capture
                .get("foreground_window")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string()),
        );

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Backend error ({}): {}", status, body));
    }

    response
        .json()
        .await
        .map_err(|e| format!("parse backend response: {}", e))
}

async fn call_backend_followup(
    token: &str,
    session_id: &str,
    query: &str,
    capture: &serde_json::Value,
    research_mode: bool,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/v1/followup", PLATFORM_URL);
    let client = reqwest::Client::new();

    let screenshot_b64 = capture
        .get("screenshot_b64")
        .and_then(|v| v.as_str())
        .ok_or("no screenshot_b64 in capture")?;

    use base64::Engine;
    let screenshot_bytes = base64::engine::general_purpose::STANDARD
        .decode(screenshot_b64)
        .map_err(|e| format!("base64 decode: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("session_id", session_id.to_string())
        .text("query", query.to_string())
        .text("research_mode", research_mode.to_string())
        .part(
            "screenshot",
            reqwest::multipart::Part::bytes(screenshot_bytes)
                .file_name("screenshot.png")
                .mime_str("image/png")
                .map_err(|e| e.to_string())?,
        )
        .text(
            "screenshot_dimensions",
            capture
                .get("screenshot_dimensions")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
        )
        .text(
            "original_dimensions",
            capture
                .get("original_dimensions")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "{}".to_string()),
        )
        .text(
            "scale_factor",
            capture
                .get("scale_factor")
                .and_then(|v| v.as_f64())
                .map(|v| v.to_string())
                .unwrap_or_else(|| "1".to_string()),
        )
        .text(
            "monitor_offset",
            capture
                .get("monitor_offset")
                .map(|v| v.to_string())
                .unwrap_or_else(|| r#"{"x":0,"y":0}"#.to_string()),
        )
        .text(
            "uia_tree",
            capture
                .get("uia_tree")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string()),
        )
        .text(
            "foreground_window",
            capture
                .get("foreground_window")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string()),
        );

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Backend error ({}): {}", status, body));
    }

    response
        .json()
        .await
        .map_err(|e| format!("parse backend response: {}", e))
}

// ── Sidecar grounding settings ──────────────────────────────────────────────

#[tauri::command]
async fn set_grounding(
    settings: String,
    sidecar: State<'_, Sidecar>,
) -> Result<serde_json::Value, String> {
    eprintln!("[nudge] set_grounding: {}", settings);
    let parsed: serde_json::Value =
        serde_json::from_str(&settings).map_err(|e| e.to_string())?;

    let mut guard = sidecar.0.lock().map_err(|e| e.to_string())?;
    let proc = guard.as_mut().ok_or("sidecar not running")?;

    let request = serde_json::json!({
        "method": "set_grounding",
        "params": parsed
    });
    let response = proc.send(&request)?;
    response
        .get("result")
        .cloned()
        .ok_or("no result".to_string())
}

// ── Window setup ────────────────────────────────────────────────────────────

fn setup_windows(app: &AppHandle) {
    let _ = app;

    for (label, radius) in &[("input", 18), ("control", 14)] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_shadow(false);
            apply_rounded_corners(&win, *radius);
        }
    }

    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_ignore_cursor_events(true);
        let _ = overlay.set_shadow(false);
    }

    if let Some(settings) = app.get_webview_window("settings") {
        let _ = settings.set_shadow(false);
        apply_rounded_corners(&settings, 16);
    }

    if let Some(dashboard) = app.get_webview_window("dashboard") {
        let _ = dashboard.set_shadow(false);
    }

    // Answer popup: interactive (NOT click-through), rounded corners
    if let Some(answer) = app.get_webview_window("answer") {
        let _ = answer.set_shadow(false);
        apply_rounded_corners(&answer, 16);
    }

    // Splash: rounded corners
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.set_shadow(false);
        apply_rounded_corners(&splash, 20);
    }
}

fn apply_rounded_corners(win: &tauri::WebviewWindow, radius: i32) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};

    if let Ok(raw) = win.hwnd() {
        let hwnd = HWND(raw.0);
        unsafe {
            let mut rect = windows::Win32::Foundation::RECT::default();
            let _ =
                windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect);
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;

            let rgn = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius, radius);
            if !rgn.is_invalid() {
                SetWindowRgn(hwnd, rgn, true);
            }
        }
    }
}

// ── Deep link handler ──────────────────────────────────────────────────────

fn handle_deep_link(app: &AppHandle, urls: Vec<url::Url>) {
    for url in urls {
        eprintln!("[nudge] deep link received: {}", url);

        if url.scheme() == "nudge" && url.host_str() == Some("auth") && url.path() == "/callback" {
            // Extract token from query params
            if let Some(token) = url.query_pairs().find(|(k, _)| k == "token").map(|(_, v)| v.to_string()) {
                eprintln!("[nudge] auth token received from deep link");

                // Store token in state
                if let Some(token_state) = app.try_state::<AuthToken>() {
                    if let Ok(mut guard) = token_state.0.lock() {
                        *guard = Some(token);
                    }
                }

                // Emit auth-success event to all windows
                let _ = app.emit("auth-success", ());
            }
        }
    }
}

// ── App entry point ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // When a second instance is launched (e.g., from deep link),
            // forward the URL to the running instance
            eprintln!("[nudge] single-instance: argv = {:?}", argv);
            for arg in &argv {
                if let Ok(url) = url::Url::parse(arg) {
                    if url.scheme() == "nudge" {
                        handle_deep_link(app, vec![url]);

                        // Save token to persistent store
                        if let Some(token_state) = app.try_state::<AuthToken>() {
                            if let Ok(guard) = token_state.0.lock() {
                                if let Some(token) = guard.as_ref() {
                                    if let Ok(store) = app.store("auth.json") {
                                        let val: serde_json::Value = serde_json::json!(token);
                                        store.set("api_token", val);
                                        let _ = store.save();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Spawn Python sidecar
            let sidecar = match spawn_sidecar(app) {
                Ok(s) => {
                    eprintln!("[nudge] sidecar started");
                    Some(s)
                }
                Err(e) => {
                    eprintln!("[nudge] failed to start sidecar: {}", e);
                    None
                }
            };
            app.manage(Sidecar(Mutex::new(sidecar)));

            // Auth token state (initially empty — will be populated from deep link or stored token)
            app.manage(AuthToken(Mutex::new(None)));
            app.manage(ActiveQuery(Mutex::new(None)));
            app.manage(CompletedSteps(Mutex::new(Vec::new())));
            app.manage(ResearchMode(Mutex::new(false)));
            app.manage(SessionId(Mutex::new(None)));
            app.manage(PendingAnswer(Mutex::new(None)));
            app.manage(AgentManager {
                agents: Mutex::new(HashMap::new()),
                cancel_senders: Mutex::new(HashMap::new()),
            });

            // Try to load saved token from store
            match app.store("auth.json") {
                Ok(store) => {
                    if let Some(token_val) = store.get("api_token") {
                        if let Some(token_str) = token_val.as_str() {
                            eprintln!("[nudge] loaded saved auth token from store");
                            if let Some(token_state) = app.try_state::<AuthToken>() {
                                if let Ok(mut guard) = token_state.0.lock() {
                                    *guard = Some(token_str.to_string());
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[nudge] could not open auth store: {}", e);
                }
            }

            // Register deep link protocol (needed for dev mode on Windows)
            #[cfg(debug_assertions)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register("nudge") {
                    eprintln!("[nudge] failed to register deep link: {}", e);
                } else {
                    eprintln!("[nudge] registered nudge:// protocol handler");
                }
            }

            // Deep link handler
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event: tauri::Event| {
                if let Ok(urls) = serde_json::from_str::<Vec<url::Url>>(event.payload()) {
                    handle_deep_link(&handle, urls);

                    // Save token to persistent store
                    if let Some(token_state) = handle.try_state::<AuthToken>() {
                        if let Ok(guard) = token_state.0.lock() {
                            if let Some(token) = guard.as_ref() {
                                if let Ok(store) = handle.store("auth.json") {
                                    let val: serde_json::Value = serde_json::json!(token);
                                    store.set("api_token", val);
                                    let _ = store.save();
                                }
                            }
                        }
                    }
                }
            });

            // Setup transparent backgrounds + overlay click-through
            setup_windows(app.handle());

            // Show splash screen if not signed in
            {
                let is_signed_in = if let Some(state) = app.try_state::<AuthToken>() {
                    state.0.lock().map(|g| g.is_some()).unwrap_or(false)
                } else {
                    false
                };

                if !is_signed_in {
                    if let Some(splash) = app.get_webview_window("splash") {
                        eprintln!("[nudge] no auth token — showing splash screen");
                        let _ = splash.center();
                        let _ = splash.show();
                        let _ = splash.set_focus();
                    }
                } else {
                    eprintln!("[nudge] auth token found — showing dashboard");
                    if let Some(dashboard) = app.get_webview_window("dashboard") {
                        let _ = dashboard.center();
                        let _ = dashboard.show();
                        let _ = dashboard.set_focus();
                    }
                }
            }

            // System tray
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Nudge", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .expect("no default icon set in tauri.conf.json bundle.icon");
            TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("Nudge — Ctrl+Shift+N")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "settings" => {
                        if let Some(win) = app.get_webview_window("settings") {
                            let _ = win.center();
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            // Load keybinds from store or use defaults
            let keybinds = {
                let mut kb = Keybinds::default();
                if let Ok(store) = app.store("settings.json") {
                    if let Some(val) = store.get("keybinds") {
                        if let Ok(saved) = serde_json::from_value::<Keybinds>(val.clone()) {
                            eprintln!("[nudge] loaded saved keybinds: {:?}", saved);
                            kb = saved;
                        }
                    }
                }
                kb
            };

            // Register hotkeys using saved/default keybinds
            let empty = Keybinds {
                open_nudge: String::new(),
                next_step: String::new(),
                dismiss: String::new(),
            };
            reregister_hotkeys(app.handle(), &empty, &keybinds)
                .map_err(|e| -> Box<dyn std::error::Error> { format!("Failed to register hotkeys: {}", e).into() })?;

            app.manage(KeybindState(Mutex::new(keybinds)));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            submit_query,
            next_step,
            submit_followup,
            get_pending_answer,
            login,
            logout,
            get_auth_state,
            set_auth_token,
            show_input,
            show_dashboard,
            get_keybinds,
            set_keybind,
            pause_shortcuts,
            resume_shortcuts,
            check_for_update,
            install_update,
            set_grounding,
            enumerate_windows,
            create_agent,
            get_agents,
            delete_agent,
            update_agent,
            start_agent,
            stop_agent,
            send_agent_message,
        ])
        .on_window_event(|window, event| {
            if window.label() == "input" {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
            // Reapply rounded corners on resize for resizable frameless windows
            if let WindowEvent::Resized(_) = event {
                let label = window.label().to_string();
                if label == "answer" {
                    if let Some(wv) = window.app_handle().get_webview_window(&label) {
                        apply_rounded_corners(&wv, 16);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error running nudge");
}
