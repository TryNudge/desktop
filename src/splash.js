  const { invoke } = window.__TAURI__.core;
  const { getCurrentWindow } = window.__TAURI__.window;
  const { listen } = window.__TAURI__.event;
  const { getVersion } = window.__TAURI__.app;

  getVersion().then(v => {
    document.getElementById('splash-version').textContent = `v${v}`;
  });

  getCurrentWindow().setBackgroundColor({ r: 0, g: 0, b: 0, a: 0 }).catch(() => {});

  const slides = document.querySelectorAll('.slide');
  const btnBack = document.getElementById('btn-back');
  const btnNext = document.getElementById('btn-next');
  let currentSlide = 0;
  const LAST_SLIDE = 5;

  function goTo(index) {
    currentSlide = index;
    slides.forEach(s => s.classList.remove('active'));
    document.querySelector(`[data-slide="${index}"]`).classList.add('active');

    // Nav visibility
    if (index === 0) {
      // Sign-in slide: hide nav buttons
      btnBack.style.display = 'none';
      btnNext.style.display = 'none';
    } else if (index === LAST_SLIDE) {
      btnBack.classList.remove('hidden');
      btnBack.style.display = '';
      btnNext.style.display = '';
      btnNext.textContent = 'Get Started';
    } else {
      btnBack.classList.remove('hidden');
      btnBack.style.display = '';
      btnNext.style.display = '';
      btnNext.textContent = 'Next';
    }

    if (index === 1) {
      btnBack.classList.add('hidden');
    }
  }

  btnNext.addEventListener('click', () => {
    if (currentSlide === LAST_SLIDE) {
      getCurrentWindow().hide();
      invoke('show_input').catch(console.error);
    } else {
      goTo(currentSlide + 1);
    }
  });

  btnBack.addEventListener('click', () => {
    if (currentSlide > 1) goTo(currentSlide - 1);
  });

  // Sign-in actions
  document.getElementById('btn-signin').addEventListener('click', async () => {
    try {
      const url = await invoke('login');
      document.getElementById('signin-default').style.display = 'none';
      document.getElementById('signin-waiting').style.display = '';
      document.getElementById('signin-link').href = url;
    } catch (e) {
      console.error(e);
    }
  });

  // Auth success: jump to welcome slide
  listen('auth-success', () => {
    goTo(1);
  });

  // Load keybinds into onboarding slides
  const DISPLAY = {
    'ctrl': 'Ctrl', 'shift': 'Shift', 'alt': 'Alt', 'super': 'Super',
    'arrowright': '\u2192', 'arrowleft': '\u2190', 'arrowup': '\u2191', 'arrowdown': '\u2193',
    'enter': '\u21B5', 'escape': 'Esc', 'space': 'Space',
  };
  function renderKbd(container, shortcut) {
    container.innerHTML = shortcut.split('+')
      .map(p => `<kbd>${DISPLAY[p] || p.toUpperCase()}</kbd>`)
      .join('');
  }
  invoke('get_keybinds').then(kb => {
    renderKbd(document.getElementById('splash-kb-open'), kb.open_nudge);
    renderKbd(document.getElementById('splash-kb-next'), kb.next_step);
    renderKbd(document.getElementById('splash-kb-dismiss'), kb.dismiss);
  }).catch(() => {
    renderKbd(document.getElementById('splash-kb-open'), 'ctrl+shift+n');
    renderKbd(document.getElementById('splash-kb-next'), 'ctrl+shift+arrowright');
    renderKbd(document.getElementById('splash-kb-dismiss'), 'ctrl+shift+arrowleft');
  });

  // On load: check if already authenticated
  invoke('get_auth_state').then(state => {
    if (state.authenticated) {
      getCurrentWindow().hide();
    }
  }).catch(() => {});