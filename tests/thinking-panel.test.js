const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { waitForThinkingPanel } = require('../dist/browser/chatgpt.js');

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) {
    await browser.close();
  }
});

test('waitForThinkingPanel requires pro thinking and close button', async () => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
  <html>
    <body>
      <div>Pro thinking</div>
      <button data-testid="close-button">Close</button>
    </body>
  </html>`);

  const ok = await waitForThinkingPanel(page);
  await page.close();
  assert.equal(ok, true);
});
