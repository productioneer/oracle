#!/usr/bin/env node
const http = require('http');
const { URL } = require('url');

const args = process.argv.slice(2);
const port = getArgValue(args, '--port') ? Number(getArgValue(args, '--port')) : 7777;
const once = args.includes('--once');

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname !== '/') {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const html = buildHtml();
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
  if (once) {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`Mock ChatGPT listening on http://127.0.0.1:${port}`);
});

function buildHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mock ChatGPT</title>
  <style>
    body { font-family: ui-sans-serif, system-ui; margin: 20px; }
    .messages { max-width: 800px; margin-bottom: 20px; }
    .msg { padding: 12px; border-radius: 8px; margin: 8px 0; }
    .user { background: #f0f4ff; }
    .assistant { background: #f7f7f7; }
    .controls { display: flex; gap: 8px; align-items: flex-start; }
    textarea { width: 100%; height: 80px; }
    button { padding: 8px 12px; }
    .actions { margin-top: 8px; display: flex; gap: 8px; }
    .thinking { border: 1px solid #ddd; padding: 10px; border-radius: 8px; margin-top: 16px; max-width: 800px; }
    .thinking-header { font-weight: 600; cursor: pointer; }
    .thinking-content { margin-top: 8px; }
    .thinking-content.collapsed { display: none; }
    .composer-footer { margin-top: 8px; }
    .menu { border: 1px solid #ddd; padding: 6px; border-radius: 6px; display: none; margin-top: 4px; }
    .menu button { display: block; width: 100%; text-align: left; }
  </style>
</head>
<body>
  <main class="messages" id="messages"></main>

  <div class="actions">
    <button id="action-good" data-testid="good-response-turn-action-button" style="display:none;">👍</button>
    <button id="action-bad" data-testid="bad-response-turn-action-button" style="display:none;">👎</button>
  </div>

  <div class="controls">
    <textarea id="prompt-textarea" placeholder="Message ChatGPT"></textarea>
    <button id="send" data-testid="send-button" aria-label="Send">Send</button>
    <button id="stop" aria-label="Stop" style="display:none;">Stop</button>
  </div>

  <div class="composer-footer" data-testid="composer-footer-actions">
    <button id="thinking-toggle">Extended thinking</button>
    <div id="thinking-menu" class="menu">
      <button role="menuitemradio" data-value="standard">Standard</button>
      <button role="menuitemradio" data-value="extended">Extended</button>
    </div>
  </div>

  <div class="thinking" id="thinking-panel">
    <div id="thought-header" class="thinking-header">Thought for 12 seconds</div>
    <div id="thinking-content" class="thinking-content collapsed">
      <section id="pro-thinking-section">
        <div id="pro-thinking-header">Pro thinking</div>
        <div id="pro-thinking-body"></div>
      </section>
      <section id="sources-section">
        <div data-testid="bar-search-sources-header" id="sources-header">Sources</div>
        <div id="sources-body">example.com</div>
      </section>
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
    const proThinkingBody = document.getElementById('pro-thinking-body');

    send.addEventListener('click', () => startRun());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        startRun();
      }
    });

    thinkingToggle.addEventListener('click', () => {
      thinkingMenu.style.display = thinkingMenu.style.display === 'block' ? 'none' : 'block';
    });

    thinkingMenu.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const value = target.getAttribute('data-value');
      if (value === 'extended') {
        thinkingToggle.textContent = 'Extended thinking';
      } else {
        thinkingToggle.textContent = 'Pro';
      }
      thinkingMenu.style.display = 'none';
    });

    thoughtHeader.addEventListener('click', () => {
      thinkingContent.classList.toggle('collapsed');
    });

    function startRun() {
      const prompt = input.value.trim();
      if (!prompt) return;
      appendMessage('user', prompt);
      input.value = '';
      simulateStreaming(prompt);
    }

    let messageIndex = 0;
    function appendMessage(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.setAttribute('data-message-author-role', role);
      const article = document.createElement('article');
      messageIndex += 1;
      article.setAttribute('data-testid', 'conversation-turn-' + messageIndex);
      article.innerText = text;
      div.appendChild(article);
      messages.appendChild(div);
      div.scrollIntoView();
      return article;
    }

    function simulateStreaming(prompt) {
      const params = new URLSearchParams(location.search);
      const durationMs = Number(params.get('durationMs') || 0);
      const delayMsParam = Number(params.get('delayMs') || 50);
      const stall = params.get('stall') === '1';
      const response = 'Echo: ' + prompt + '\\n\\nThis is a mocked streaming response.';
      const delay = durationMs ? Math.max(10, Math.floor(durationMs / response.length)) : delayMsParam;
      const article = appendMessage('assistant', '');
      stop.style.display = 'inline-block';
      actionGood.style.display = 'none';
      actionBad.style.display = 'none';
      let idx = 0;
      const timer = setInterval(() => {
        if (stall) return;
        idx += 1;
        const chunk = response.slice(0, idx);
        article.innerText = chunk;
        proThinkingBody.innerText = 'Pro thinking\\n' + chunk;
        if (idx >= response.length) {
          clearInterval(timer);
          stop.style.display = 'none';
          actionGood.style.display = 'inline-block';
          actionBad.style.display = 'inline-block';
        }
      }, delay);
    }
  </script>
</body>
</html>`;
}

function getArgValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1];
}
