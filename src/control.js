  const { invoke } = window.__TAURI__.core;
  const { getCurrentWindow } = window.__TAURI__.window;
  const { listen, emit } = window.__TAURI__.event;

  getCurrentWindow().setBackgroundColor({ r: 0, g: 0, b: 0, a: 0 }).catch(() => {});

  const counter = document.getElementById('counter');
  const btnNext = document.getElementById('btn-next');
  const btnDismiss = document.getElementById('btn-dismiss');
  const stepDot = document.getElementById('step-dot');

  let stepCount = 0;
  let currentInstruction = '';
  let loading = false;
  let nextHint = '';
  let dismissHint = '';

  const DISPLAY = {
    'ctrl': 'Ctrl', 'shift': 'Shift', 'alt': 'Alt', 'super': 'Super',
    'arrowright': '\u2192', 'arrowleft': '\u2190', 'arrowup': '\u2191', 'arrowdown': '\u2193',
    'enter': '\u21B5', 'escape': 'Esc', 'space': 'Space',
  };
  function fmtShortcut(s) { return s.split('+').map(p => DISPLAY[p] || p.toUpperCase()).join('+'); }

  invoke('get_keybinds').then(kb => {
    nextHint = fmtShortcut(kb.next_step);
    dismissHint = fmtShortcut(kb.dismiss);
    document.getElementById('hint-next').textContent = nextHint;
    document.getElementById('hint-dismiss').textContent = dismissHint;
  }).catch(() => {
    nextHint = 'Ctrl+Shift+\u2192';
    dismissHint = 'Ctrl+Shift+\u2190';
    document.getElementById('hint-next').textContent = nextHint;
    document.getElementById('hint-dismiss').textContent = dismissHint;
  });

  listen('show-plan', async (event) => {
    const plan = event.payload;
    stepCount++;
    currentInstruction = plan.steps[0]?.instruction || '';
    counter.textContent = `Step ${stepCount}`;
    btnNext.innerHTML = `Next step<span class="kbd">${nextHint}</span>`;
    btnNext.disabled = false;
    stepDot.classList.remove('loading');
    loading = false;
    await positionSelf();
  });

  async function positionSelf() {
    const win = getCurrentWindow();
    const monitor = await window.__TAURI__.window.currentMonitor();
    if (monitor) {
      const sf = monitor.scaleFactor || 1;
      const mx = monitor.position.x / sf;
      const my = monitor.position.y / sf;
      const mw = monitor.size.width / sf;
      const mh = monitor.size.height / sf;
      // 480px window width + 20px padding from edge, 60px from bottom
      await win.setPosition(new window.__TAURI__.window.LogicalPosition(mx + mw - 500, my + mh - 100));
    }
    await win.show();
  }

  async function nextStep() {
    if (loading) return;
    loading = true;
    btnNext.disabled = true;
    btnNext.innerHTML = 'Analyzing...<span class="kbd">&hookleftarrow;</span>';
    stepDot.classList.add('loading');

    emit('dismiss', {});
    await new Promise(r => setTimeout(r, 400));
    emit('show-loading');

    try {
      const plan = await invoke('next_step', {
        completedInstruction: currentInstruction,
      });
      stepCount++;
      currentInstruction = plan.steps[0]?.instruction || '';
      counter.textContent = `Step ${stepCount}`;
      btnNext.innerHTML = `Next step<span class="kbd">${nextHint}</span>`;
      btnNext.disabled = false;
      stepDot.classList.remove('loading');
      loading = false;
      emit('show-plan', plan);
    } catch (err) {
      console.error('next_step failed:', err);
      emit('dismiss');
      btnNext.innerHTML = 'Retry<span class="kbd">&crarr;</span>';
      btnNext.disabled = false;
      stepDot.classList.remove('loading');
      loading = false;
    }
  }

  function dismiss() {
    emit('dismiss', {});
    stepCount = 0;
    getCurrentWindow().hide();
  }

  btnNext.addEventListener('click', nextStep);
  btnDismiss.addEventListener('click', dismiss);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nextStep();
    if (e.key === 'Escape') dismiss();
  });

  // Global hotkeys (work even when another app is focused)
  listen('global-next-step', () => nextStep());
  listen('global-dismiss', () => dismiss());