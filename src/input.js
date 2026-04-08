  const { invoke } = window.__TAURI__.core;
  const { getCurrentWindow } = window.__TAURI__.window;
  const { emit, listen } = window.__TAURI__.event;

  // Force WebView2 transparent background via JS API
  getCurrentWindow().setBackgroundColor({ r: 0, g: 0, b: 0, a: 0 }).catch(() => {});

  const input = document.getElementById('query');
  const spinner = document.getElementById('spinner');
  const hint = document.getElementById('hint');
  const researchToggle = document.getElementById('research-toggle');
  let isAuthenticated = false;
  let researchMode = false;

  researchToggle.addEventListener('change', () => {
    researchMode = researchToggle.checked;
  });

  // Check auth state on load and when window is focused
  async function checkAuth() {
    try {
      const state = await invoke('get_auth_state');
      isAuthenticated = state.authenticated;
      if (!isAuthenticated) {
        input.placeholder = 'Sign in first (open Settings)';
      } else {
        input.placeholder = 'Ask Nudge anything...';
      }
    } catch (e) {
      console.error('auth check error:', e);
    }
  }

  checkAuth();
  listen('auth-success', () => checkAuth());

  getCurrentWindow().listen('tauri://focus', () => {
    input.value = '';
    input.focus();
    checkAuth();
  });

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      getCurrentWindow().hide();
      return;
    }

    if (e.key === 'Enter' && input.value.trim()) {
      const query = input.value.trim();

      if (!isAuthenticated) {
        input.value = '';
        input.placeholder = 'Sign in first (Ctrl+Shift+N → Settings)';
        return;
      }

      spinner.classList.add('active');
      hint.classList.add('hidden');
      input.disabled = true;
      let failed = false;

      try {
        await getCurrentWindow().hide();
        await new Promise(r => setTimeout(r, 500));
        emit('show-loading');
        const response = await invoke('submit_query', { query, researchMode });

        console.log('[input] response_type:', response.response_type);

        if (response.response_type === 'answer') {
          // Rust already showed the answer window and emitted events
        } else if (response.response_type === 'hybrid') {
          // Rust already showed the answer window; we just need to show the overlay steps
          await emit('show-plan', {
            app_context: response.app_context,
            steps: response.steps || [],
            scale_factor: response.scale_factor,
            monitor_offset_x: response.monitor_offset_x,
            monitor_offset_y: response.monitor_offset_y,
          });
        } else {
          // Steps only — existing overlay flow
          await emit('show-plan', {
            app_context: response.app_context,
            steps: response.steps || [],
            scale_factor: response.scale_factor,
            monitor_offset_x: response.monitor_offset_x,
            monitor_offset_y: response.monitor_offset_y,
          });
        }
      } catch (err) {
        failed = true;
        await emit('dismiss');
        await getCurrentWindow().show();
        input.value = '';
        input.placeholder = `Error: ${err}`;
      }

      spinner.classList.remove('active');
      hint.classList.remove('hidden');
      input.disabled = false;
      if (!failed) {
        input.value = '';
        input.placeholder = 'Ask Nudge anything...';
      }
    }
  });