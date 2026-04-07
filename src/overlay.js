  const { getCurrentWindow } = window.__TAURI__.window;
  const { listen, emit } = window.__TAURI__.event;

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const cursorImg = document.getElementById('cursor-img');
  const captionEl = document.getElementById('caption');
  const captionStep = document.getElementById('caption-step');
  const captionText = document.getElementById('caption-text');
  const loadingEl = document.getElementById('loading');

  let plan = null;
  let currentStepIdx = 0;
  let cursorX = 0, cursorY = 0;
  let startX = 0, startY = 0;
  let animProgress = 0;
  let animating = false;
  let windowOffsetX = 0, windowOffsetY = 0;
  let cursorLoaded = false;
  let globalTime = 0;

  // Image may have already loaded before external JS runs
  if (cursorImg.complete && cursorImg.naturalWidth > 0) {
    cursorLoaded = true;
  } else {
    cursorImg.onload = () => { cursorLoaded = true; };
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // ── Drawing ──────────────────────────────────────────

  const CURSOR_SIZE = 48;

  function drawCursor(x, y, scale, alpha) {
    if (!cursorLoaded) return;
    const s = scale || 1;
    const a = alpha !== undefined ? alpha : 1;

    // Gentle hover float
    const floatY = animating ? 0 : Math.sin(globalTime * 1.8) * 3;

    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(x, y + floatY);
    ctx.scale(s, s);

    // Shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 4;

    ctx.drawImage(cursorImg, -CURSOR_SIZE * 0.15, -CURSOR_SIZE * 0.1, CURSOR_SIZE, CURSOR_SIZE);
    ctx.restore();
  }

  function drawTargetIndicator(x, y, phase) {
    // Subtle sonar ping — single soft expanding ring
    const t = (phase % 1);
    const r = 4 + t * 18;
    const alpha = 0.18 * (1 - t);

    ctx.beginPath();
    ctx.arc(x + CURSOR_SIZE * 0.25, y + CURSOR_SIZE * 0.3, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(43, 43, 43, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ── Animation ────────────────────────────────────────

  let pulsePhase = 0;
  let lastTime = 0;
  let cursorScale = 0;

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) { const c = 1.5; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  function bezierPoint(t, p0, cp, p1) { const u = 1 - t; return u*u*p0 + 2*u*t*cp + t*t*p1; }

  function animate(timestamp) {
    if (!plan) return;

    const dt = lastTime ? (timestamp - lastTime) / 1000 : 0;
    lastTime = timestamp;
    globalTime += dt;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const step = plan.steps[currentStepIdx];
    if (!step) return;

    const sf = plan.scale_factor;
    const ox = plan.monitor_offset_x - windowOffsetX;
    const oy = plan.monitor_offset_y - windowOffsetY;
    const tx = step.target.x * sf + ox;
    const ty = step.target.y * sf + oy;

    if (animating) {
      animProgress = Math.min(animProgress + dt * 2.2, 1);
      const t = easeOutCubic(animProgress);
      const cpX = (startX + tx) / 2;
      const cpY = Math.min(startY, ty) - 60;
      cursorX = bezierPoint(t, startX, cpX, tx);
      cursorY = bezierPoint(t, startY, cpY, ty);
      cursorScale = easeOutBack(Math.min(animProgress * 3.5, 1));

      if (animProgress >= 1) {
        animating = false;
        cursorX = tx; cursorY = ty; cursorScale = 1;
      }
    }

    if (!animating) {
      pulsePhase += dt * 0.7;
      drawTargetIndicator(cursorX, cursorY, pulsePhase);
    }

    drawCursor(cursorX, cursorY, cursorScale, animating ? Math.min(animProgress * 2, 1) : 1);
    requestAnimationFrame(animate);
  }

  // ── Caption ──────────────────────────────────────────

  function positionCaption(step) {
    const sf = plan.scale_factor;
    const ox = plan.monitor_offset_x - windowOffsetX;
    const oy = plan.monitor_offset_y - windowOffsetY;
    const tx = step.target.x * sf + ox;
    const ty = step.target.y * sf + oy;

    captionEl.style.visibility = 'hidden';
    captionEl.style.left = '0px';
    captionEl.style.top = '0px';
    captionEl.classList.add('visible');

    const rect = captionEl.getBoundingClientRect();
    const pad = 24;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const zone = 65;

    const candidates = [
      { cx: tx + zone + 16, cy: ty - rect.height / 2 },
      { cx: tx - rect.width - zone - 16, cy: ty - rect.height / 2 },
      { cx: tx - rect.width / 2, cy: ty - rect.height - zone - 16 },
      { cx: tx - rect.width / 2, cy: ty + zone + 40 },
    ];

    let best = candidates[0];
    let bestScore = -Infinity;
    for (const pos of candidates) {
      let score = 0;
      const cx = Math.max(pad, Math.min(pos.cx, W - rect.width - pad));
      const cy = Math.max(pad, Math.min(pos.cy, H - rect.height - pad));
      pos.cx = cx; pos.cy = cy;
      const overlapX = tx >= cx && tx <= cx + rect.width;
      const overlapY = ty >= cy && ty <= cy + rect.height;
      if (overlapX && overlapY) score -= 1000;
      if (pos === candidates[0]) score += 10;
      if (score > bestScore) { bestScore = score; best = pos; }
    }

    captionEl.style.left = `${best.cx}px`;
    captionEl.style.top = `${best.cy}px`;
    captionEl.style.visibility = 'visible';
  }

  function showStep(idx) {
    if (!plan || idx >= plan.steps.length) return;
    currentStepIdx = idx;
    const step = plan.steps[idx];

    captionStep.textContent = `Step ${step.step_number}`;
    captionText.textContent = step.instruction;

    startX = cursorX || canvas.width / 2;
    startY = cursorY || canvas.height / 2;
    animating = true;
    animProgress = 0;
    cursorScale = 0;

    captionEl.classList.remove('visible');
    setTimeout(() => requestAnimationFrame(() => positionCaption(step)), 350);

    lastTime = 0;
    requestAnimationFrame(animate);
    emit('step-update', { current: idx + 1, total: plan.steps.length, instruction: step.instruction });
  }

  // ── Events ───────────────────────────────────────────

  listen('show-loading', async () => {
    const win = getCurrentWindow();
    const monitors = await window.__TAURI__.window.availableMonitors();
    if (monitors.length > 0) {
      const mon = monitors[0];
      const sf = mon.scaleFactor || 1;
      windowOffsetX = mon.position.x; windowOffsetY = mon.position.y;
      await win.setPosition(new window.__TAURI__.window.LogicalPosition(mon.position.x / sf, mon.position.y / sf));
      await win.setSize(new window.__TAURI__.window.LogicalSize(mon.size.width / sf, mon.size.height / sf));
    }
    resizeCanvas(); ctx.clearRect(0, 0, canvas.width, canvas.height);
    captionEl.classList.remove('visible'); loadingEl.classList.add('active');
    await win.show();
  });

  listen('show-plan', async (event) => {
    loadingEl.classList.remove('active');
    plan = event.payload;
    const win = getCurrentWindow();
    const monitors = await window.__TAURI__.window.availableMonitors();
    if (monitors.length > 0) {
      let targetMon = monitors[0];
      for (const mon of monitors) {
        if (mon.position.x === plan.monitor_offset_x && mon.position.y === plan.monitor_offset_y) { targetMon = mon; break; }
      }
      const sf = targetMon.scaleFactor || 1;
      windowOffsetX = targetMon.position.x; windowOffsetY = targetMon.position.y;
      await win.setPosition(new window.__TAURI__.window.LogicalPosition(targetMon.position.x / sf, targetMon.position.y / sf));
      await win.setSize(new window.__TAURI__.window.LogicalSize(targetMon.size.width / sf, targetMon.size.height / sf));
    }
    resizeCanvas(); cursorX = canvas.width / 2; cursorY = canvas.height / 2;
    await win.show(); showStep(0);
  });

  listen('next-step', () => { if (plan && currentStepIdx < plan.steps.length - 1) showStep(currentStepIdx + 1); });
  listen('dismiss', () => {
    plan = null; ctx.clearRect(0, 0, canvas.width, canvas.height);
    captionEl.classList.remove('visible'); loadingEl.classList.remove('active');
    getCurrentWindow().hide();
  });