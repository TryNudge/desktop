  const { invoke } = window.__TAURI__.core;
  const { getCurrentWindow } = window.__TAURI__.window;
  const { listen } = window.__TAURI__.event;

  const toggleUia = document.getElementById('toggle-uia');
  const toggleOcr = document.getElementById('toggle-ocr');
  const saveStatus = document.getElementById('save-status');

  // Auth elements
  const authLoggedOut = document.getElementById('auth-logged-out');
  const authLoggedIn = document.getElementById('auth-logged-in');
  const userEmail = document.getElementById('user-email');
  const usageInfo = document.getElementById('usage-info');
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');

  // Close
  document.getElementById('close-btn').addEventListener('click', () => getCurrentWindow().hide());

  // Auth state
  async function updateAuthUI() {
    try {
      const state = await invoke('get_auth_state');
      if (state.authenticated) {
        authLoggedOut.style.display = 'none';
        authLoggedIn.style.display = 'block';
        userEmail.textContent = state.email || 'Signed in';
        usageInfo.textContent = state.plan === 'pro' ? 'Pro plan' : 'Free plan';
      } else {
        authLoggedOut.style.display = 'block';
        authLoggedIn.style.display = 'none';
      }
    } catch (e) {
      console.error('auth state error:', e);
    }
  }

  btnLogin.addEventListener('click', () => invoke('login').catch(console.error));
  btnLogout.addEventListener('click', async () => {
    await invoke('logout').catch(console.error);
    updateAuthUI();
  });

  // Listen for auth-success from deep link
  listen('auth-success', () => updateAuthUI());

  // Check auth on load
  updateAuthUI();

  // Grounding toggles
  function updateGrounding() {
    invoke('set_grounding', {
      settings: JSON.stringify({
        uia: toggleUia.checked,
        ocr: toggleOcr.checked,
      })
    }).catch(console.error);
    showSaved();
  }
  toggleUia.addEventListener('change', updateGrounding);
  toggleOcr.addEventListener('change', updateGrounding);

  function showSaved() {
    saveStatus.textContent = 'Saved';
    saveStatus.classList.add('saved');
    setTimeout(() => {
      saveStatus.textContent = 'Settings auto-save';
      saveStatus.classList.remove('saved');
    }, 1500);
  }

  // ── Keybind recording ──
  const KEY_MAP = {
    'Control': 'ctrl', 'Shift': 'shift', 'Alt': 'alt', 'Meta': 'super',
    'ArrowRight': 'arrowright', 'ArrowLeft': 'arrowleft',
    'ArrowUp': 'arrowup', 'ArrowDown': 'arrowdown',
    'Enter': 'enter', 'Escape': 'escape', 'Backspace': 'backspace',
    'Delete': 'delete', 'Tab': 'tab', 'Space': 'space',
    ' ': 'space',
  };

  const DISPLAY_MAP = {
    'ctrl': 'Ctrl', 'shift': 'Shift', 'alt': 'Alt', 'super': 'Super',
    'arrowright': '\u2192', 'arrowleft': '\u2190',
    'arrowup': '\u2191', 'arrowdown': '\u2193',
    'enter': '\u21B5', 'escape': 'Esc', 'backspace': '\u232B',
    'delete': 'Del', 'tab': 'Tab', 'space': 'Space',
  };

  function shortcutToDisplay(shortcut) {
    return shortcut.split('+').map(p => DISPLAY_MAP[p] || p.toUpperCase()).join('+');
  }

  let recordingBtn = null;

  let recordingAction = null;

  async function startRecording(btn) {
    if (recordingAction) {
      // Cancel previous recording
      document.querySelectorAll('.keybind-btn').forEach(b => b.classList.remove('recording'));
      try { await invoke('resume_shortcuts'); } catch(e) {}
    }
    recordingAction = btn.dataset.action;
    btn.classList.add('recording');
    btn.textContent = 'Press keys...';
    // Blur the button so keydown goes to document
    btn.blur();
    // Pause all global shortcuts so they don't intercept our keypresses
    try { await invoke('pause_shortcuts'); } catch(e) { console.error(e); }
  }

  document.querySelectorAll('.keybind-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      startRecording(btn);
    });
  });

  window.addEventListener('keydown', async (e) => {
    if (!recordingAction) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Ignore lone modifier keys
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    const action = recordingAction;
    const btn = document.querySelector(`.keybind-btn[data-action="${action}"]`);

    // Escape cancels recording
    if (e.key === 'Escape') {
      recordingAction = null;
      btn.classList.remove('recording');
      loadKeybinds();
      try { await invoke('resume_shortcuts'); } catch(ex) {}
      return;
    }

    // Require at least one modifier
    if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return;

    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');
    if (e.metaKey) parts.push('super');

    const key = KEY_MAP[e.key] || e.key.toLowerCase();
    parts.push(key);

    const shortcut = parts.join('+');

    try {
      await invoke('set_keybind', { action, shortcut });
      btn.classList.remove('recording');
      btn.textContent = shortcutToDisplay(shortcut);
      recordingAction = null;
      try { await invoke('resume_shortcuts'); } catch(ex) {}
      showSaved();
    } catch (err) {
      btn.textContent = String(err).slice(0, 30);
      btn.classList.remove('recording');
      recordingAction = null;
      setTimeout(() => loadKeybinds(), 1500);
      try { await invoke('resume_shortcuts'); } catch(ex) {}
    }
  }, true);

  async function loadKeybinds() {
    try {
      const kb = await invoke('get_keybinds');
      document.getElementById('kb-open-nudge').textContent = shortcutToDisplay(kb.open_nudge);
      document.getElementById('kb-next-step').textContent = shortcutToDisplay(kb.next_step);
      document.getElementById('kb-dismiss').textContent = shortcutToDisplay(kb.dismiss);
    } catch (e) {
      console.error('load keybinds error:', e);
    }
  }
  loadKeybinds();

  // ── Update check ──
  const updateLabel = document.getElementById('update-label');
  const updateDesc = document.getElementById('update-desc');
  const btnUpdate = document.getElementById('btn-update');

  async function checkUpdate() {
    try {
      const info = await invoke('check_for_update');
      if (info.available) {
        updateLabel.textContent = `v${info.version} available`;
        updateDesc.textContent = info.notes || 'A new version is ready to install.';
        btnUpdate.style.display = '';
      } else {
        updateLabel.textContent = 'v0.1.0';
        updateDesc.textContent = 'You\u2019re on the latest version.';
      }
    } catch (e) {
      updateDesc.textContent = 'Could not check for updates.';
    }
  }

  btnUpdate.addEventListener('click', async () => {
    btnUpdate.disabled = true;
    btnUpdate.textContent = 'Updating...';
    updateDesc.textContent = 'Downloading update...';
    try {
      await invoke('install_update');
    } catch (e) {
      updateDesc.textContent = `Update failed: ${e}`;
      btnUpdate.textContent = 'Retry';
      btnUpdate.disabled = false;
    }
  });

  checkUpdate();