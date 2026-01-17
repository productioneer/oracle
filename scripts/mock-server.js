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
    .controls { display: flex; gap: 8px; }
    textarea { width: 100%; height: 80px; }
    button { padding: 8px 12px; }
  </style>
</head>
<body>
  <main class="messages" id="messages"></main>
  <div class="controls">
    <textarea id="prompt-textarea" placeholder="Message ChatGPT"></textarea>
    <button id="send" aria-label="Send prompt">Send</button>
    <button id="stop" aria-label="Stop generating" style="display:none;">Stop generating</button>
  </div>

  <script>
    const messages = document.getElementById('messages');
    const send = document.getElementById('send');
    const stop = document.getElementById('stop');
    const input = document.getElementById('prompt-textarea');

    send.addEventListener('click', () => startRun());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        startRun();
      }
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
      let idx = 0;
      const timer = setInterval(() => {
        if (stall) return;
        idx += 1;
        article.innerText = response.slice(0, idx);
        if (idx >= response.length) {
          clearInterval(timer);
          stop.style.display = 'none';
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
