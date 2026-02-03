/**
 * Integration test: verifies that Oracle's browser operations never steal focus
 * and keep Chrome windows hidden/offscreen throughout the full lifecycle:
 * launch → navigate → submit prompt → wait for response → extract.
 *
 * Uses the FocusMonitor and WindowObserver as external observers while
 * running against a mock ChatGPT server.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { FocusMonitor } = require('../dist/monitor/focus-monitor.js');
const { WindowObserver } = require('../dist/monitor/window-observer.js');
const { Telemetry, readTelemetryLog } = require('../dist/monitor/telemetry.js');
const { launchChrome, createHiddenPage } = require('../dist/browser/chrome.js');
const { submitPrompt, waitForCompletion, waitForPromptInput, ensureWideViewport } = require('../dist/browser/chatgpt.js');

const TEMP_PROFILE = path.join(os.tmpdir(), `oracle-monitor-integ-${Date.now()}`);
const TELEMETRY_PATH = path.join(os.tmpdir(), `oracle-monitor-integ-${Date.now()}.jsonl`);

function startMockServer() {
  const html = buildMockHtml();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

function buildMockHtml() {
  // Minimal mock ChatGPT with prompt input, send button, streaming response,
  // and copy button inside the conversation turn (Oracle's completion signal).
  // Oracle detects completion via [data-testid="copy-turn-action-button"] inside
  // the conversation-turn wrapper, and detects streaming via visible Stop button.
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Mock ChatGPT</title></head>
<body>
  <main id="messages"></main>
  <div>
    <textarea id="prompt-textarea" placeholder="Message ChatGPT"></textarea>
    <button id="send" data-testid="send-button" aria-label="Send">Send</button>
    <button id="stop" aria-label="Stop" style="display:none;">Stop</button>
  </div>
  <script>
    const messages = document.getElementById('messages');
    const send = document.getElementById('send');
    const stop = document.getElementById('stop');
    const input = document.getElementById('prompt-textarea');

    send.addEventListener('click', () => startRun());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startRun(); }
    });

    let turnIndex = 0;
    function appendMessage(role, text) {
      turnIndex += 1;
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-testid', 'conversation-turn-' + turnIndex);
      const div = document.createElement('div');
      div.setAttribute('data-message-author-role', role);
      div.innerText = text;
      wrapper.appendChild(div);
      messages.appendChild(wrapper);
      return { wrapper, div };
    }

    function startRun() {
      const prompt = input.value.trim();
      if (!prompt) return;
      appendMessage('user', prompt);
      input.value = '';
      const response = 'Echo: ' + prompt;
      const { wrapper, div: article } = appendMessage('assistant', '');
      stop.style.display = 'inline-block';
      let idx = 0;
      const timer = setInterval(() => {
        idx += 2;
        article.innerText = response.slice(0, idx);
        if (idx >= response.length) {
          clearInterval(timer);
          stop.style.display = 'none';
          // Add copy button inside the assistant's turn wrapper (Oracle's completion signal)
          const copyBtn = document.createElement('button');
          copyBtn.setAttribute('data-testid', 'copy-turn-action-button');
          copyBtn.textContent = 'Copy';
          wrapper.appendChild(copyBtn);
        }
      }, 30);
    }
  </script>
</body>
</html>`;
}

test('full lifecycle: no focus theft and window stays hidden', async () => {
  if (process.platform !== 'darwin') {
    return;
  }

  let browser;
  let browserPid;
  let mockServer;

  const telemetry = new Telemetry(TELEMETRY_PATH, { flushIntervalMs: 100 });
  await telemetry.open();

  const focusMonitor = new FocusMonitor({
    intervalMs: 200,
    oracleUserDataDir: TEMP_PROFILE,
    telemetry,
  });
  const windowObserver = new WindowObserver({ intervalMs: 300, telemetry });

  try {
    // 1. Start mock server
    const mock = await startMockServer();
    mockServer = mock.server;

    // 2. Start focus monitor (before any Chrome interaction)
    focusMonitor.start();

    // 3. Launch Chrome (hidden)
    const connection = await launchChrome({
      userDataDir: TEMP_PROFILE,
      allowVisible: false,
    });
    browser = connection.browser;
    browserPid = connection.browserPid;

    // 4. Create hidden page (this triggers ensureChromeWindowHidden)
    const page = await createHiddenPage(browser, 'monitor-integ-test', {
      allowVisible: false,
    });

    // 5. Start window observer after hiding is complete. Note: Chrome may be
    //    briefly at non-hidden coordinates during startup (before createHiddenPage
    //    calls ensureChromeWindowHidden), but the -g launch flag keeps it in
    //    background so it's not user-visible. This tests steady-state behavior.
    await windowObserver.start(browser);

    // 6. Navigate to mock ChatGPT
    await page.goto(mock.url, { waitUntil: 'domcontentloaded' });
    await ensureWideViewport(page);

    // 7. Wait for prompt input to be ready
    await waitForPromptInput(page, 10000);

    // 8. Submit a prompt
    const prompt = 'Hello, this is a test query from Oracle monitor integration test.';
    await submitPrompt(page, prompt);

    // 9. Wait for response to complete
    const completion = await waitForCompletion(page, {
      timeoutMs: 30000,
      pollMs: 200,
      prompt,
    });

    // Verify we got a response
    assert.ok(completion.content, 'Should have received response content');
    assert.ok(completion.content.includes('Echo:'), `Response should echo prompt, got: ${completion.content.slice(0, 100)}`);

    // 10. Let monitors collect a bit more data
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 11. Stop monitors and get reports
    const focusReport = focusMonitor.stop();
    const windowReport = await windowObserver.stop();

    // === ASSERTIONS ===

    // Focus: Oracle's Chrome should NEVER have been the frontmost app
    assert.equal(focusReport.violations.length, 0,
      `Focus was stolen ${focusReport.violations.length} times during full lifecycle: ` +
      JSON.stringify(focusReport.violations.map(v => ({ app: v.app, pid: v.pid, ts: v.timestamp }))));

    // Window: Chrome window should NEVER have been visible (onscreen + not minimized)
    assert.equal(windowReport.violations.length, 0,
      `Window was visible ${windowReport.violations.length} times during full lifecycle: ` +
      JSON.stringify(windowReport.violations.map(v => ({
        windowId: v.windowId,
        state: v.windowState,
        left: v.left,
        top: v.top,
        ts: v.timestamp,
      }))));

    // Sanity: monitors actually ran and collected data
    assert.ok(focusReport.totalEvents >= 1,
      `Focus monitor should have recorded events, got ${focusReport.totalEvents}`);
    assert.ok(windowReport.totalEvents >= 1,
      `Window observer should have recorded events, got ${windowReport.totalEvents}`);

  } finally {
    // Cleanup
    focusMonitor.stop();
    try { await windowObserver.stop(); } catch { /* already stopped */ }
    await telemetry.close();

    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    if (browserPid) {
      try { process.kill(browserPid, 'SIGTERM'); } catch { /* already dead */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try { process.kill(browserPid, 'SIGKILL'); } catch { /* already dead */ }
    }
    if (mockServer) {
      await new Promise((resolve) => mockServer.close(resolve));
    }
    fs.rmSync(TEMP_PROFILE, { recursive: true, force: true });
    try { fs.unlinkSync(TELEMETRY_PATH); } catch { /* ignore */ }
  }
});
