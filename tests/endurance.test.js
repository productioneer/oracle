const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { waitForCompletion, ResponseStalledError, ResponseFailedError, ResponseTimeoutError } = require('../dist/browser/chatgpt.js');

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) {
    await browser.close();
  }
});

/**
 * Build controllable mock HTML for testing waitForCompletion.
 * Structure matches real ChatGPT:
 *   div[data-testid="conversation-turn-N"]    (outer wrapper)
 *     div[data-message-author-role="assistant"] (role marker)
 *       article                                 (content)
 *     [copy button added dynamically on completion]
 *
 * Copy button is NOT in the DOM initially — it's added dynamically
 * by completeResponse(), matching real ChatGPT behavior where the
 * copy button only appears after response completion.
 */
function buildMockHtml(options = {}) {
  const { streamChars = 50, streamDelayMs = 50, autoComplete = true } = options;
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body>
  <main>
    <div data-testid="conversation-turn-1">
      <div data-message-author-role="user">
        <article>User prompt</article>
      </div>
    </div>
    <div id="assistant-turn" data-testid="conversation-turn-2">
      <div data-message-author-role="assistant">
        <article id="assistant-msg"></article>
      </div>
    </div>
  </main>
  <button id="stop-btn" aria-label="Stop" style="display:none;">Stop</button>
  <script>
    const assistantMsg = document.getElementById('assistant-msg');
    const assistantTurn = document.getElementById('assistant-turn');
    const stopBtn = document.getElementById('stop-btn');
    const response = 'A'.repeat(${streamChars});
    let streamIdx = 0;
    let streamTimer = null;

    window.__mockState = { streaming: false, completed: false, stalled: false, failed: false };

    window.startStreaming = function() {
      window.__mockState.streaming = true;
      stopBtn.style.display = 'inline-block';
      removeCopyButton();
      streamIdx = 0;
      streamTimer = setInterval(() => {
        if (window.__mockState.stalled) return;
        streamIdx++;
        assistantMsg.innerText = response.slice(0, streamIdx);
        if (streamIdx >= response.length) {
          clearInterval(streamTimer);
          if (${autoComplete}) {
            window.completeResponse();
          }
        }
      }, ${streamDelayMs});
    };

    window.completeResponse = function() {
      if (streamTimer) clearInterval(streamTimer);
      window.__mockState.streaming = false;
      window.__mockState.completed = true;
      stopBtn.style.display = 'none';
      if (!assistantMsg.innerText) {
        assistantMsg.innerText = response;
      }
      addCopyButton();
    };

    window.stallResponse = function() {
      window.__mockState.stalled = true;
      // Stop button stays visible — generating state persists
    };

    window.failResponse = function() {
      if (streamTimer) clearInterval(streamTimer);
      window.__mockState.streaming = false;
      window.__mockState.failed = true;
      // Hide stop button but DON'T add copy button — simulates failed generation
      stopBtn.style.display = 'none';
      removeCopyButton();
    };

    window.setAssistantText = function(text) {
      assistantMsg.innerText = text;
    };

    function addCopyButton() {
      if (assistantTurn.querySelector('[data-testid="copy-turn-action-button"]')) return;
      const turnActions = document.createElement('div');
      turnActions.className = 'turn-actions';
      const copyBtn = document.createElement('button');
      copyBtn.setAttribute('data-testid', 'copy-turn-action-button');
      copyBtn.setAttribute('aria-label', 'Copy');
      copyBtn.textContent = 'Copy';
      turnActions.appendChild(copyBtn);
      assistantTurn.appendChild(turnActions);
    }

    function removeCopyButton() {
      const existing = assistantTurn.querySelector('.turn-actions');
      if (existing) existing.remove();
    }
  </script>
</body>
</html>`;
}

test('waitForCompletion detects completion after slow streaming', async () => {
  const page = await browser.newPage();
  try {
    // Stream 30 chars at 100ms each = ~3s streaming + 2s stability = ~5s total
    await page.setContent(buildMockHtml({ streamChars: 30, streamDelayMs: 100 }), {
      waitUntil: 'domcontentloaded',
    });
    await page.evaluate(() => window.startStreaming());

    const start = Date.now();
    const result = await waitForCompletion(page, {
      timeoutMs: 30_000,
      pollMs: 500,
    });
    const elapsed = Date.now() - start;

    assert.ok(result.content.length > 0, 'Should have content');
    assert.ok(result.content.includes('A'), 'Content should be from mock');
    // Should take at least 3s (streaming) + 2s (stability) = 5s
    assert.ok(elapsed >= 4000, `Should take at least 4s, took ${elapsed}ms`);
    assert.ok(elapsed < 25000, `Should complete well before timeout, took ${elapsed}ms`);
  } finally {
    await page.close();
  }
});

test('waitForCompletion detects completion with pre-completed response', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildMockHtml({ streamChars: 10, streamDelayMs: 10 }), {
      waitUntil: 'domcontentloaded',
    });
    // Complete response immediately
    await page.evaluate(() => {
      window.setAssistantText('Pre-completed response');
      window.completeResponse();
    });

    const result = await waitForCompletion(page, {
      timeoutMs: 15_000,
      pollMs: 500,
    });

    assert.ok(result.content.includes('Pre-completed response'));
  } finally {
    await page.close();
  }
});

test('waitForCompletion throws ResponseTimeoutError when response never comes', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildMockHtml({ autoComplete: false }), {
      waitUntil: 'domcontentloaded',
    });
    // Don't start streaming — no generating, no copy button, no content

    await assert.rejects(
      () => waitForCompletion(page, { timeoutMs: 3000, pollMs: 500 }),
      (err) => {
        assert.ok(err instanceof ResponseTimeoutError, `Expected ResponseTimeoutError, got ${err.constructor.name}`);
        return true;
      },
    );
  } finally {
    await page.close();
  }
});

test('waitForCompletion throws ResponseStalledError when stop button persists at timeout', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildMockHtml({ streamChars: 1000, streamDelayMs: 200, autoComplete: false }), {
      waitUntil: 'domcontentloaded',
    });
    // Start streaming — stop button visible (generating=true)
    await page.evaluate(() => window.startStreaming());
    // Stall it so it never completes
    await page.evaluate(() => window.stallResponse());

    await assert.rejects(
      () => waitForCompletion(page, { timeoutMs: 4000, pollMs: 500 }),
      (err) => {
        assert.ok(err instanceof ResponseStalledError, `Expected ResponseStalledError, got ${err.constructor.name}`);
        return true;
      },
    );
  } finally {
    await page.close();
  }
});

test('waitForCompletion throws ResponseFailedError when generation ends without copy button', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildMockHtml({ streamChars: 5, streamDelayMs: 50, autoComplete: false }), {
      waitUntil: 'domcontentloaded',
    });
    // Start streaming so sawGenerating becomes true during polling
    await page.evaluate(() => window.startStreaming());

    // Schedule failure 1.5s in — stop button hides without copy button appearing.
    // waitForCompletion must be polling while stop is visible (sawGenerating=true),
    // then see generation end (stop hidden), then wait 30s for copy that never comes.
    setTimeout(async () => {
      try { await page.evaluate(() => window.failResponse()); } catch { /* page may close */ }
    }, 1500);

    // ResponseFailedError fires after 30s of no copy button post-generation end
    await assert.rejects(
      () => waitForCompletion(page, { timeoutMs: 45_000, pollMs: 500 }),
      (err) => {
        assert.ok(err instanceof ResponseFailedError, `Expected ResponseFailedError, got ${err.constructor.name}`);
        return true;
      },
    );
  } finally {
    await page.close();
  }
});

test('waitForCompletion logs during long wait', async () => {
  const page = await browser.newPage();
  try {
    // Stream slowly — takes ~5s
    await page.setContent(buildMockHtml({ streamChars: 50, streamDelayMs: 100 }), {
      waitUntil: 'domcontentloaded',
    });
    await page.evaluate(() => window.startStreaming());

    const logs = [];
    const logger = (msg) => logs.push(msg);

    const result = await waitForCompletion(page, {
      timeoutMs: 30_000,
      pollMs: 500,
      logger,
    });

    assert.ok(result.content.length > 0);
    // Should have some debug logs about response updates
    const updateLogs = logs.filter(l => l.includes('response update') || l.includes('response state'));
    assert.ok(updateLogs.length > 0, `Should have response update logs, got: ${logs.join('; ')}`);
  } finally {
    await page.close();
  }
});

test('waitForCompletion handles rapid completion correctly', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildMockHtml({ streamChars: 3, streamDelayMs: 10 }), {
      waitUntil: 'domcontentloaded',
    });
    await page.evaluate(() => window.startStreaming());

    const result = await waitForCompletion(page, {
      timeoutMs: 15_000,
      pollMs: 500,
    });

    assert.ok(result.content.length > 0, 'Should detect rapid completion');
  } finally {
    await page.close();
  }
});
