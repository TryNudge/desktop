  console.log('[answer] answer.js loaded');
  const { invoke } = window.__TAURI__.core;
  const { getCurrentWindow } = window.__TAURI__.window;
  const { emit, listen } = window.__TAURI__.event;

  // Force WebView2 transparent background
  getCurrentWindow().setBackgroundColor({ r: 0, g: 0, b: 0, a: 0 }).catch(() => {});

  const titleEl = document.getElementById('answer-title');
  const contentEl = document.getElementById('answer-content');
  const btnCopy = document.getElementById('btn-copy');
  const copyLabel = document.getElementById('copy-label');
  const btnClose = document.getElementById('btn-close');
  const btnSteps = document.getElementById('btn-steps');
  const followupInput = document.getElementById('followup-input');
  const followupHint = document.getElementById('followup-hint');
  const followupSpinner = document.getElementById('followup-spinner');

  let currentCopyText = '';
  let hasSteps = false;

  // ── Simple markdown renderer ──────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';
    let html = text;

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code>${escaped.trimEnd()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Unordered lists
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

    // Paragraphs (double newlines)
    html = html.replace(/\n\n+/g, '</p><p>');
    // Single newlines within paragraphs
    html = html.replace(/([^>])\n([^<])/g, '$1<br>$2');

    // Wrap in paragraph if not starting with a block element
    if (!html.match(/^<(h[1-3]|pre|ul|ol|blockquote|p)/)) {
      html = '<p>' + html + '</p>';
    }

    return html;
  }

  // ── Show answer ───────────────────────────────────────────
  function showAnswer(payload) {
    titleEl.textContent = payload.title || 'Answer';
    contentEl.innerHTML = renderMarkdown(payload.content || '');
    currentCopyText = payload.copyable_text || payload.content || '';

    // Reset copy button
    copyLabel.textContent = 'Copy';
    btnCopy.classList.remove('copied');

    // Show/hide steps button
    hasSteps = payload._has_steps || false;
    btnSteps.style.display = hasSteps ? 'block' : 'none';

    // Clear follow-up input
    followupInput.value = '';
    followupInput.disabled = false;
    followupSpinner.classList.remove('active');
    followupHint.classList.remove('hidden');
  }

  // Pull answer from Rust state (reliable — works even on first show)
  async function loadPendingAnswer() {
    try {
      const answer = await invoke('get_pending_answer');
      console.log('[answer] got pending answer:', answer);
      if (answer) {
        showAnswer(answer);
      }
    } catch (e) {
      console.error('[answer] failed to get pending answer:', e);
    }
  }

  // Also listen for event (for follow-ups and subsequent answers)
  listen('show-answer', async (event) => {
    console.log('[answer] show-answer event received');
    showAnswer(event.payload);
  });

  // ── Copy ──────────────────────────────────────────────────
  btnCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(currentCopyText);
      copyLabel.textContent = 'Copied!';
      btnCopy.classList.add('copied');
      setTimeout(() => {
        copyLabel.textContent = 'Copy';
        btnCopy.classList.remove('copied');
      }, 2000);
    } catch (e) {
      console.error('copy failed:', e);
    }
  });

  // ── Close ─────────────────────────────────────────────────
  btnClose.addEventListener('click', () => {
    emit('dismiss-answer');
  });

  // ── Show Steps (hybrid mode) ──────────────────────────────
  btnSteps.addEventListener('click', () => {
    getCurrentWindow().hide();
    // Overlay is already showing behind, just hide the answer popup
  });

  // ── Follow-up ─────────────────────────────────────────────
  followupInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      getCurrentWindow().hide();
      return;
    }

    if (e.key === 'Enter' && followupInput.value.trim()) {
      const query = followupInput.value.trim();
      followupInput.value = '';
      followupInput.disabled = true;
      followupSpinner.classList.add('active');
      followupHint.classList.add('hidden');

      // Show loading in content area
      contentEl.innerHTML = '<p style="color: rgba(255,255,255,0.3)">Thinking...</p>';

      try {
        const response = await invoke('submit_followup', { query });

        if (response.response_type === 'answer' || response.response_type === 'hybrid') {
          // Update answer content in-place
          const answerData = response.answer || {};
          answerData._has_steps = response.response_type === 'hybrid' && response.steps && response.steps.length > 0;
          showAnswer(answerData);

          if (response.response_type === 'hybrid' && response.steps && response.steps.length > 0) {
            // Also show the overlay for steps
            await emit('show-plan', {
              app_context: response.app_context,
              steps: response.steps,
              scale_factor: response.scale_factor,
              monitor_offset_x: response.monitor_offset_x,
              monitor_offset_y: response.monitor_offset_y,
            });
          }
        } else if (response.response_type === 'steps') {
          // Switch to overlay mode
          await getCurrentWindow().hide();
          await emit('show-plan', {
            app_context: response.app_context,
            steps: response.steps,
            scale_factor: response.scale_factor,
            monitor_offset_x: response.monitor_offset_x,
            monitor_offset_y: response.monitor_offset_y,
          });
        }
      } catch (err) {
        contentEl.innerHTML = `<p style="color: rgba(255,100,100,0.8)">Error: ${err}</p>`;
      }

      followupInput.disabled = false;
      followupSpinner.classList.remove('active');
      followupHint.classList.remove('hidden');
      followupInput.focus();
    }
  });

  // ── Dismiss event (only hide if explicitly targeting answer window) ──
  listen('dismiss-answer', () => {
    getCurrentWindow().hide();
  });

  // When window gains focus, load pending answer and focus input
  getCurrentWindow().listen('tauri://focus', () => {
    loadPendingAnswer();
    followupInput.focus();
  });
