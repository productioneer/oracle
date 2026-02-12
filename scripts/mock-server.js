#!/usr/bin/env node
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const args = process.argv.slice(2);
const port = getArgValue(args, "--port")
  ? Number(getArgValue(args, "--port"))
  : 7777;
const once = args.includes("--once");

// In-memory conversation store for follow-up support
const conversations = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // API endpoint: store conversation state from client-side JS
  if (url.pathname.startsWith("/api/conversation/") && req.method === "POST") {
    const convId = url.pathname.slice("/api/conversation/".length);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        conversations.set(convId, data);
      } catch { /* ignore parse errors */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    return;
  }

  // Accept root, /c/* (conversation URLs), and /?scenario=* paths
  if (url.pathname !== "/" && !url.pathname.startsWith("/c/")) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  // Extract conversation ID from /c/<id> paths
  const conversationId = url.pathname.startsWith("/c/")
    ? url.pathname.slice(3).split("?")[0]
    : null;

  // Load existing conversation state for follow-up rendering
  const convState = conversationId
    ? conversations.get(conversationId) || null
    : null;
  const existingMessages = convState?.messages || [];

  const html = buildHtml(url.searchParams, existingMessages, conversationId, convState);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
  if (once) {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`Mock ChatGPT listening on http://127.0.0.1:${port}`);
});

function buildHtml(params, existingMessages, conversationId, convState) {
  // Scenario-based behavior via query params:
  //   ?scenario=fail          — response generation fails (no copy button)
  //   ?scenario=stall         — response stalls forever (stop button stays)
  //   ?scenario=slow_start    — 5s delay before prompt input is ready
  //   ?scenario=error_text    — response contains error message from ChatGPT
  //   ?durationMs=N           — control total response duration
  //   ?delayMs=N              — control per-character delay (default 50ms)
  //
  // All scenarios support conversation continuation (follow-up messages).

  const messagesHtml = existingMessages
    .map(
      (m, i) =>
        `<div data-testid="conversation-turn-${i + 1}" class="msg ${m.role}">` +
        `<div data-message-author-role="${m.role}">` +
        `<article>${escapeHtml(m.text)}</article>` +
        `</div>` +
        (m.role === "assistant"
          ? `<div class="turn-actions"><button data-testid="copy-turn-action-button" aria-label="Copy">Copy</button></div>`
          : "") +
        `</div>`,
    )
    .join("\n    ");

  const startIndex = existingMessages.length;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mock ChatGPT</title>
  <style>
    body { font-family: ui-sans-serif, system-ui; margin: 0; padding: 0; }
    #page-header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid #eee; }
    #page-header span { font-weight: 600; }
    .model-dropdown { display: none; border: 1px solid #ddd; padding: 6px; border-radius: 6px; position: absolute; background: #fff; z-index: 10; }
    .model-dropdown button { display: block; width: 100%; text-align: left; padding: 6px 8px; }
    .content { padding: 20px; }
    .messages { max-width: 800px; margin-bottom: 20px; }
    .msg { padding: 12px; border-radius: 8px; margin: 8px 0; }
    .user { background: #f0f4ff; }
    .assistant { background: #f7f7f7; }
    .turn-actions { margin-top: 4px; display: flex; gap: 4px; }
    .turn-actions button { font-size: 12px; padding: 2px 6px; }
    .controls { display: flex; gap: 8px; align-items: flex-start; }
    textarea { width: 100%; height: 80px; }
    button { padding: 8px 12px; cursor: pointer; }
    .actions { margin-top: 8px; display: flex; gap: 8px; }
    .thinking { border: 1px solid #ddd; padding: 10px; border-radius: 8px; margin-top: 16px; max-width: 800px; }
    .thinking-header { font-weight: 600; cursor: pointer; }
    .thinking-content { margin-top: 8px; }
    .thinking-content.collapsed { display: none; }
    .composer-footer { margin-top: 8px; }
    .menu { border: 1px solid #ddd; padding: 6px; border-radius: 6px; display: none; margin-top: 4px; }
    .menu button { display: block; width: 100%; text-align: left; }
    .attachment-area { margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .file-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: #f0f0f0; border-radius: 4px; font-size: 13px; }
    .file-chip svg { width: 16px; height: 16px; }
    .upload-input { display: none; }
  </style>
</head>
<body>
  <div id="page-header">
    <a data-testid="create-new-chat-button" href="/">New chat</a>
    <div style="position: relative;">
      <button data-testid="model-switcher-dropdown-button" aria-label="Model selector">
        <span>5.2 Pro</span>
      </button>
      <div id="model-dropdown" class="model-dropdown">
        <button data-testid="model-switcher-gpt-5-2-pro">5.2 Pro</button>
      </div>
    </div>
  </div>

  <div class="content">
    <main class="messages" id="messages">${messagesHtml}</main>

    <div class="actions">
      <button id="action-good" data-testid="good-response-turn-action-button" style="display:none;">👍</button>
      <button id="action-bad" data-testid="bad-response-turn-action-button" style="display:none;">👎</button>
    </div>

    <div id="thread-bottom-container">
      <div class="attachment-area" id="attachment-area"></div>
      <div class="controls">
        <button data-testid="composer-plus-btn" aria-label="Add files" id="plus-btn">+</button>
        <input type="file" id="file-input" class="upload-input" multiple />
        <textarea id="prompt-textarea" placeholder="Message ChatGPT"></textarea>
        <button id="send" data-testid="send-button" aria-label="Send">Send</button>
        <button id="stop" aria-label="Stop" style="display:none;">Stop</button>
      </div>
    </div>

    <div class="composer-footer" data-testid="composer-footer-actions">
      <button id="thinking-toggle" aria-label="Extended thinking">Extended thinking</button>
      <div id="thinking-menu" class="menu">
        <button role="menuitemradio" data-value="standard">Standard</button>
        <button role="menuitemradio" data-value="extended">Extended</button>
      </div>
    </div>

    <div class="thinking" id="thinking-panel">
      <div id="thought-header" class="thinking-header">Thought for 12 seconds</div>
      <button data-testid="close-button" id="thinking-close" style="float:right;font-size:12px;">Close</button>
      <div id="thinking-content" class="thinking-content${convState?.thinkingBody ? '' : ' collapsed'}">
        <section id="pro-thinking-section">
          <div id="pro-thinking-header">Pro thinking</div>
          <div id="pro-thinking-body">${convState?.thinkingBody ? escapeHtml(convState.thinkingBody) : ''}</div>
        </section>
      </div>
    </div>
  </div>

  <script>
    const messages = document.getElementById('messages');
    const send = document.getElementById('send');
    const stop = document.getElementById('stop');
    const input = document.getElementById('prompt-textarea');
    const actionGood = document.getElementById('action-good');
    const actionBad = document.getElementById('action-bad');
    const thinkingToggle = document.getElementById('thinking-toggle');
    const thinkingMenu = document.getElementById('thinking-menu');
    const thoughtHeader = document.getElementById('thought-header');
    const thinkingContent = document.getElementById('thinking-content');
    const thinkingClose = document.getElementById('thinking-close');
    const proThinkingBody = document.getElementById('pro-thinking-body');
    const modelSwitcher = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
    const modelDropdown = document.getElementById('model-dropdown');
    const plusBtn = document.getElementById('plus-btn');
    const fileInput = document.getElementById('file-input');
    const attachmentArea = document.getElementById('attachment-area');

    // Configuration from query params (carried through page lifecycle)
    const pageParams = new URLSearchParams(window.location.search);
    const scenario = pageParams.get('scenario') || '';

    // Slow start: hide prompt input briefly to simulate page loading
    if (scenario === 'slow_start') {
      input.style.display = 'none';
      send.style.display = 'none';
      setTimeout(() => {
        input.style.display = '';
        send.style.display = '';
      }, 5000);
    }

    send.addEventListener('click', () => startRun());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        startRun();
      }
    });

    // Model switcher
    modelSwitcher.addEventListener('click', () => {
      modelDropdown.style.display = modelDropdown.style.display === 'block' ? 'none' : 'block';
    });
    modelDropdown.addEventListener('click', (event) => {
      if (event.target.hasAttribute('data-testid')) {
        modelSwitcher.querySelector('span').textContent = event.target.textContent;
        modelDropdown.style.display = 'none';
      }
    });

    // Thinking toggle
    thinkingToggle.addEventListener('click', () => {
      thinkingMenu.style.display = thinkingMenu.style.display === 'block' ? 'none' : 'block';
    });

    thinkingMenu.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const value = target.getAttribute('data-value');
      if (value === 'extended') {
        thinkingToggle.textContent = 'Extended thinking';
        thinkingToggle.setAttribute('aria-label', 'Extended thinking');
      } else {
        thinkingToggle.textContent = 'Pro';
        thinkingToggle.setAttribute('aria-label', 'Pro');
      }
      thinkingMenu.style.display = 'none';
    });

    // Thinking panel
    thoughtHeader.addEventListener('click', () => {
      thinkingContent.classList.toggle('collapsed');
    });
    thinkingClose.addEventListener('click', () => {
      thinkingContent.classList.add('collapsed');
    });

    // File attachments
    plusBtn.addEventListener('click', () => {
      fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      for (const file of fileInput.files) {
        addFileChip(file.name);
      }
      fileInput.value = '';
    });

    function addFileChip(filename) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      chip.innerHTML =
        '<svg><use href="https://cdn.example.com/sprite.svg#file-icon"></use></svg>' +
        '<span>' + filename + '</span>';
      const removeBtn = document.createElement('button');
      removeBtn.setAttribute('aria-label', 'Remove file');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = 'border:none;background:none;cursor:pointer;padding:0 2px;';
      removeBtn.addEventListener('click', () => chip.remove());
      chip.appendChild(removeBtn);
      attachmentArea.appendChild(chip);
    }

    function startRun() {
      const prompt = input.value.trim();
      if (!prompt) return;
      appendMessage('user', prompt);
      input.value = '';

      // Navigate to conversation URL (like real ChatGPT)
      if (!window.location.pathname.startsWith('/c/')) {
        const convId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const newUrl = '/c/' + convId + window.location.search;
        window.history.pushState({}, '', newUrl);
      }

      simulateStreaming(prompt);
    }

    let messageIndex = ${startIndex};
    function appendMessage(role, text) {
      // Structure matches real ChatGPT: conversation-turn wrapper > role div > article
      messageIndex += 1;
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-testid', 'conversation-turn-' + messageIndex);
      wrapper.className = 'msg ' + role;
      const roleDiv = document.createElement('div');
      roleDiv.setAttribute('data-message-author-role', role);
      const article = document.createElement('article');
      article.innerText = text;
      roleDiv.appendChild(article);
      wrapper.appendChild(roleDiv);
      messages.appendChild(wrapper);
      wrapper.scrollIntoView();
      return { container: wrapper, article };
    }

    function simulateStreaming(prompt) {
      const durationMs = Number(pageParams.get('durationMs') || 0);
      const delayMsParam = Number(pageParams.get('delayMs') || 50);

      // Expand thinking panel (simulates ChatGPT auto-opening the sidebar)
      thinkingContent.classList.remove('collapsed');

      // Scenario: stall — never complete
      if (scenario === 'stall') {
        const { article } = appendMessage('assistant', '');
        stop.style.display = 'inline-block';
        actionGood.style.display = 'none';
        actionBad.style.display = 'none';
        let idx = 0;
        const partial = 'Thinking about this...';
        const stallTimer = setInterval(() => {
          idx += 1;
          if (idx <= partial.length) {
            article.innerText = partial.slice(0, idx);
          }
          // Never adds copy button, stop stays visible
        }, delayMsParam);
        return;
      }

      // Scenario: error_text — ChatGPT returns an error message
      if (scenario === 'error_text') {
        const errorResponse = 'An error occurred while generating a response. Please try again.';
        const { container, article } = appendMessage('assistant', '');
        stop.style.display = 'inline-block';
        let idx = 0;
        const errTimer = setInterval(() => {
          idx += 1;
          article.innerText = errorResponse.slice(0, idx);
          if (idx >= errorResponse.length) {
            clearInterval(errTimer);
            stop.style.display = 'none';
            // Still adds copy button (ChatGPT does this even for error responses)
            const turnActions = document.createElement('div');
            turnActions.className = 'turn-actions';
            const copyBtn = document.createElement('button');
            copyBtn.setAttribute('data-testid', 'copy-turn-action-button');
            copyBtn.setAttribute('aria-label', 'Copy');
            copyBtn.textContent = 'Copy';
            turnActions.appendChild(copyBtn);
            container.appendChild(turnActions);
          }
        }, 20);
        return;
      }

      // Scenario: fail — response fails (stop disappears but no copy button = ResponseFailedError)
      if (scenario === 'fail') {
        const { article } = appendMessage('assistant', '');
        stop.style.display = 'inline-block';
        actionGood.style.display = 'none';
        actionBad.style.display = 'none';
        let idx = 0;
        const partial = 'I was working on this but...';
        const failDelay = durationMs ? Math.max(10, Math.floor(durationMs / partial.length)) : delayMsParam;
        const failTimer = setInterval(() => {
          idx += 1;
          article.innerText = partial.slice(0, idx);
          if (idx >= partial.length) {
            clearInterval(failTimer);
            // Stop disappears but NO copy button — this triggers ResponseFailedError
            stop.style.display = 'none';
          }
        }, failDelay);
        return;
      }

      // Default: happy path — echo prompt + stream response
      const response = 'Echo: ' + prompt + '\\n\\nThis is a mocked streaming response.';
      const delay = durationMs ? Math.max(10, Math.floor(durationMs / response.length)) : delayMsParam;
      const { container, article } = appendMessage('assistant', '');
      stop.style.display = 'inline-block';
      actionGood.style.display = 'none';
      actionBad.style.display = 'none';
      let idx = 0;
      const timer = setInterval(() => {
        idx += 1;
        const chunk = response.slice(0, idx);
        article.innerText = chunk;
        proThinkingBody.innerText = chunk;
        if (idx >= response.length) {
          clearInterval(timer);
          stop.style.display = 'none';
          actionGood.style.display = 'inline-block';
          actionBad.style.display = 'inline-block';
          // Add copy button (completion signal)
          const turnActions = document.createElement('div');
          turnActions.className = 'turn-actions';
          const copyBtn = document.createElement('button');
          copyBtn.setAttribute('data-testid', 'copy-turn-action-button');
          copyBtn.setAttribute('aria-label', 'Copy');
          copyBtn.textContent = 'Copy';
          turnActions.appendChild(copyBtn);
          container.appendChild(turnActions);

          // Persist conversation state so page reloads show the same content
          saveConversation(prompt, response);
        }
      }, delay);
    }

    function saveConversation(prompt, response) {
      const convMatch = window.location.pathname.match(/^\\/c\\/(.+)/);
      if (!convMatch) return;
      const convId = convMatch[1];
      const msgs = [];
      document.querySelectorAll('[data-message-author-role]').forEach(el => {
        msgs.push({ role: el.getAttribute('data-message-author-role'), text: el.querySelector('article')?.innerText || '' });
      });
      fetch('/api/conversation/' + convId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs, thinkingBody: proThinkingBody.innerText || '' })
      }).catch(() => {});
    }
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getArgValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1];
}
