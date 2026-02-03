const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const {
  waitForCompletion,
  isGenerating,
  isResponseComplete,
  ResponseStalledError,
  ResponseFailedError,
  ResponseTimeoutError,
} = require('../dist/browser/chatgpt.js');

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
 * Build HTML with controllable assistant response states.
 * Structure matches real ChatGPT:
 *   div[data-testid="conversation-turn-N"]    (outer wrapper)
 *     div[data-message-author-role="role"]     (role marker)
 *       article                                (content)
 *     [copy button added/removed dynamically]
 *
 * Copy button is NOT in the DOM initially — added via setCopyVisible(true),
 * removed via setCopyVisible(false), matching real ChatGPT behavior.
 */
function buildRecoveryHtml() {
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

    window.setGenerating = function(on) {
      stopBtn.style.display = on ? 'inline-block' : 'none';
    };
    window.setCopyVisible = function(on) {
      if (on) {
        if (!assistantTurn.querySelector('[data-testid="copy-turn-action-button"]')) {
          const turnActions = document.createElement('div');
          turnActions.className = 'turn-actions';
          const copyBtn = document.createElement('button');
          copyBtn.setAttribute('data-testid', 'copy-turn-action-button');
          copyBtn.setAttribute('aria-label', 'Copy');
          copyBtn.textContent = 'Copy';
          turnActions.appendChild(copyBtn);
          assistantTurn.appendChild(turnActions);
        }
      } else {
        const existing = assistantTurn.querySelector('.turn-actions');
        if (existing) existing.remove();
      }
    };
    window.setAssistantText = function(text) {
      assistantMsg.innerText = text;
    };
    window.getState = function() {
      return {
        generating: stopBtn.style.display !== 'none',
        copyVisible: Boolean(assistantTurn.querySelector('[data-testid="copy-turn-action-button"]')),
        text: assistantMsg.innerText,
      };
    };
  </script>
</body>
</html>`;
}

test('isGenerating detects stop button visibility', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildRecoveryHtml(), { waitUntil: 'domcontentloaded' });

    assert.equal(await isGenerating(page), false, 'Should not be generating initially');

    await page.evaluate(() => window.setGenerating(true));
    assert.equal(await isGenerating(page), true, 'Should detect generating when stop visible');

    await page.evaluate(() => window.setGenerating(false));
    assert.equal(await isGenerating(page), false, 'Should not be generating after stop hidden');
  } finally {
    await page.close();
  }
});

test('isResponseComplete detects copy button in DOM', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildRecoveryHtml(), { waitUntil: 'domcontentloaded' });

    assert.equal(await isResponseComplete(page), false, 'Should not be complete initially');

    await page.evaluate(() => window.setCopyVisible(true));
    assert.equal(await isResponseComplete(page), true, 'Should detect complete when copy in DOM');

    await page.evaluate(() => window.setCopyVisible(false));
    assert.equal(await isResponseComplete(page), false, 'Should not be complete after copy removed');
  } finally {
    await page.close();
  }
});

test('completion requires both copy button and content', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildRecoveryHtml(), { waitUntil: 'domcontentloaded' });

    // Add copy button but no content — should timeout
    await page.evaluate(() => window.setCopyVisible(true));

    await assert.rejects(
      () => waitForCompletion(page, { timeoutMs: 4000, pollMs: 500 }),
      (err) => {
        assert.ok(
          err instanceof ResponseTimeoutError,
          `Expected ResponseTimeoutError when copy visible but no content, got ${err.constructor.name}`,
        );
        return true;
      },
    );
  } finally {
    await page.close();
  }
});

test('state transition: generating → complete triggers proper detection', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildRecoveryHtml(), { waitUntil: 'domcontentloaded' });

    // Start generating
    await page.evaluate(() => {
      window.setGenerating(true);
      window.setAssistantText('Generating...');
    });

    // Schedule completion after 2s
    setTimeout(async () => {
      try {
        await page.evaluate(() => {
          window.setGenerating(false);
          window.setCopyVisible(true);
          window.setAssistantText('Final response content');
        });
      } catch { /* page may be closed */ }
    }, 2000);

    const result = await waitForCompletion(page, {
      timeoutMs: 15_000,
      pollMs: 500,
    });

    assert.ok(result.content.includes('Final response content'), 'Should get final content');
  } finally {
    await page.close();
  }
});

test('state transition: generating → failed (no copy) triggers ResponseFailedError', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildRecoveryHtml(), { waitUntil: 'domcontentloaded' });

    // Start generating
    await page.evaluate(() => {
      window.setGenerating(true);
      window.setAssistantText('Partial content...');
    });

    // After 1s, end generation without completing (hide stop, don't add copy)
    setTimeout(async () => {
      try {
        await page.evaluate(() => {
          window.setGenerating(false);
        });
      } catch { /* page may be closed */ }
    }, 1000);

    // ResponseFailedError fires 30s after generation ends without copy button
    await assert.rejects(
      () => waitForCompletion(page, { timeoutMs: 45_000, pollMs: 500 }),
      (err) => {
        assert.ok(
          err instanceof ResponseFailedError,
          `Expected ResponseFailedError, got ${err.constructor.name}`,
        );
        return true;
      },
    );
  } finally {
    await page.close();
  }
});

test('content changes reset stall timer', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(buildRecoveryHtml(), { waitUntil: 'domcontentloaded' });

    // Start generating with content updates every 500ms
    await page.evaluate(() => {
      window.setGenerating(true);
      let count = 0;
      const timer = setInterval(() => {
        count++;
        window.setAssistantText('Content update ' + count);
        if (count >= 8) {
          clearInterval(timer);
          window.setGenerating(false);
          window.setCopyVisible(true);
          window.setAssistantText('Final content after updates');
        }
      }, 500);
    });

    const result = await waitForCompletion(page, {
      timeoutMs: 20_000,
      pollMs: 500,
    });

    assert.ok(result.content.includes('Final content'), 'Should get final content after updates');
  } finally {
    await page.close();
  }
});
