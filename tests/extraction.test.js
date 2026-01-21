const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { getLastAssistantMessage } = require('../dist/browser/chatgpt.js');

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) {
    await browser.close();
  }
});

test('extracts structured JSON output', async () => {
  const json = '{\n  "status": "ok",\n  "items": [1, 2, 3]\n}';
  const result = await extractAssistant(json, 'Return JSON only.');
  assert.deepEqual(JSON.parse(result), { status: 'ok', items: [1, 2, 3] });
});

test('extracts structured XML output', async () => {
  const xml = '<response><status>ok</status></response>';
  const result = await extractAssistant(xml, 'Return XML only.');
  assert.equal(result, xml);
});

test('extracts exact string output', async () => {
  const exact = 'OK-EXACT-STRING-123';
  const result = await extractAssistant(exact, 'Return exact string only.');
  assert.equal(result, exact);
});

async function extractAssistant(assistantText, prompt) {
  const page = await browser.newPage();
  await page.setContent(buildConversationHtml(prompt), { waitUntil: 'domcontentloaded' });
  await page.evaluate((text) => {
    const el = document.getElementById('assistant-message');
    if (el) el.innerText = text;
  }, assistantText);
  const result = await getLastAssistantMessage(page, prompt);
  await page.close();
  return result.text;
}

function buildConversationHtml(prompt) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <main>
      <div class="msg user" data-message-author-role="user">
        <article data-testid="conversation-turn-1">${escapeHtml(prompt)}</article>
      </div>
      <div class="msg assistant" data-message-author-role="assistant">
        <article id="assistant-message" data-testid="conversation-turn-2"></article>
      </div>
    </main>
  </body>
</html>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
