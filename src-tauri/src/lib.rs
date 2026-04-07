use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};

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

fn find_project_root() -> Result<std::path::PathBuf, String> {
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
            eprintln!("[nudge] project root: {}", root.display());
            return Ok(root);
        }
    }

    Err(format!(
        "could not find project root (tried: {:?})",
        candidates
            .iter()
            .map(|c| c.display().to_string())
            .collect::<Vec<_>>()
    ))
}

fn spawn_sidecar() -> Result<SidecarProcess, String> {
    let project_root = find_project_root()?;
    let sidecar_path = project_root.join("sidecar").join("server.py");

    let venv_python = project_root.join("venv").join("Scripts").join("python.exe");
    let python = if venv_python.exists() {
        eprintln!("[nudge] using venv python: {}", venv_python.display());
        venv_python.to_string_lossy().to_string()
    } else {
        eprintln!("[nudge] using system python");
        "python".to_string()
    };

    eprintln!("[nudge] sidecar script: {}", sidecar_path.display());

    let child = Command::new(&python)
        .arg(&sidecar_path)
        .current_dir(&project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar ({}): {}", python, e))?;

    Ok(SidecarProcess { child })
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
struct AuthState {
    authenticated: bool,
    email: Option<String>,
    plan: Option<String>,
}

// ── Auth commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn login() -> Result<(), String> {
    let url = format!("{}/auth/desktop-login", PLATFORM_URL);
    eprintln!("[nudge] opening browser for login: {}", url);
    open::that(&url).map_err(|e| format!("failed to open browser: {}", e))?;
    Ok(())
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

    // Show splash screen
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
    query: String,
    token_state: State<'_, AuthToken>,
    active_query: State<'_, ActiveQuery>,
    completed_steps: State<'_, CompletedSteps>,
    sidecar: State<'_, Sidecar>,
) -> Result<StepPlan, String> {
    eprintln!("[nudge] submit_query called: {:?}", query);

    // Store query and reset completed steps
    {
        let mut q = active_query.0.lock().map_err(|e| e.to_string())?;
        *q = Some(query.clone());
        let mut s = completed_steps.0.lock().map_err(|e| e.to_string())?;
        s.clear();
    }

    let token = {
        let guard = token_state.0.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("Not signed in. Please sign in first.")?
    };

    // Step 1: Capture screenshot + UIA data locally
    let capture = capture_only(&sidecar)?;

    // Step 2: Send to backend API
    let plan = call_backend_query(&token, &query, &capture).await?;

    // Step 3: Ground the plan locally using sidecar
    let grounded = ground_plan_sidecar(&sidecar, &plan, &capture)?;

    Ok(grounded)
}

#[tauri::command]
async fn next_step(
    completed_instruction: String,
    token_state: State<'_, AuthToken>,
    active_query: State<'_, ActiveQuery>,
    completed_steps_state: State<'_, CompletedSteps>,
    sidecar: State<'_, Sidecar>,
) -> Result<StepPlan, String> {
    eprintln!(
        "[nudge] next_step called, completed: {:?}",
        completed_instruction
    );

    // Track completed step
    let (original_query, steps_so_far) = {
        let mut steps = completed_steps_state.0.lock().map_err(|e| e.to_string())?;
        steps.push(completed_instruction.clone());
        let q = active_query.0.lock().map_err(|e| e.to_string())?;
        (q.clone().unwrap_or_default(), steps.clone())
    };

    let token = {
        let guard = token_state.0.lock().map_err(|e| e.to_string())?;
        guard.clone().ok_or("Not signed in. Please sign in first.")?
    };

    let capture = capture_only(&sidecar)?;
    let plan =
        call_backend_next_step(&token, &original_query, &steps_so_far, &capture).await?;
    let grounded = ground_plan_sidecar(&sidecar, &plan, &capture)?;

    Ok(grounded)
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
            let sidecar = match spawn_sidecar() {
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
                    eprintln!("[nudge] auth token found — skipping splash");
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
            login,
            logout,
            get_auth_state,
            set_auth_token,
            show_input,
            get_keybinds,
            set_keybind,
            pause_shortcuts,
            resume_shortcuts,
            check_for_update,
            install_update,
            set_grounding,
        ])
        .on_window_event(|window, event| {
            if window.label() == "input" {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error running nudge");
}
