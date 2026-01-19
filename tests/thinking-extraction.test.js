const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { getThinkingContent } = require('../dist/browser/chatgpt.js');

let browser;

before(async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
});

after(async () => {
  if (browser) {
    await browser.close();
  }
});

test('extracts thinking content from sidebar', async () => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
  <html>
    <body>
      <div class="bg-token-sidebar-surface-primary">
        <div>Activity</div>
        <div>Pro thinking</div>
        <div>Sidebar thinking content here</div>
      </div>
    </body>
  </html>`);

  const content = await getThinkingContent(page);
  await page.close();
  assert.match(content, /activity/i);
  assert.match(content, /pro thinking/i);
  assert.match(content, /sidebar thinking content/i);
});

test('clicks latest thinking header when multiple are present', async () => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
  <html>
    <body>
      <span class="thought-label">Thought for 12 seconds</span>
      <span class="thought-label">Thought for 18 seconds</span>
      <div id="sidebar" class="bg-token-sidebar-surface-primary"></div>
      <script>
        const labels = Array.from(document.querySelectorAll('.thought-label'));
        const sidebar = document.getElementById('sidebar');
        labels[0].addEventListener('click', () => {
          sidebar.innerHTML =
            '<div>Activity</div><div>Pro thinking</div><div>FIRST content with extra words to exceed length threshold</div>';
        });
        labels[1].addEventListener('click', () => {
          sidebar.innerHTML =
            '<div>Activity</div><div>Pro thinking</div><div>SECOND content with extra words to exceed length threshold</div>';
        });
      </script>
    </body>
  </html>`);

  const content = await getThinkingContent(page);
  await page.close();
  assert.match(content, /second/i);
  assert.doesNotMatch(content, /first/i);
});

test('excludes chat history sidebar', async () => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
  <html>
    <body>
      <div class="bg-token-sidebar-surface-primary">
        <div>Your chats</div>
        <div>Chat 1</div>
        <div>Chat 2</div>
      </div>
      <section>
        <div>Pro thinking</div>
        <div>Fallback content here</div>
      </section>
    </body>
  </html>`);

  const content = await getThinkingContent(page);
  await page.close();
  // Should NOT get "Your chats" content, should fall back to Pro thinking section
  assert.doesNotMatch(content, /your chats/i);
  assert.match(content, /pro thinking/i);
  assert.match(content, /fallback content/i);
});

test('extracts thinking content via fallback sections', async () => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
  <html>
    <body>
      <div>Thought for 12 seconds</div>
      <section>
        <div>Pro thinking</div>
        <div>Alpha line</div>
      </section>
      <section>
        <div data-testid="bar-search-sources-header">Sources</div>
        <div>example.com</div>
      </section>
    </body>
  </html>`);

  const content = await getThinkingContent(page);
  await page.close();
  assert.match(content, /pro thinking/i);
  assert.match(content, /alpha line/i);
  assert.match(content, /sources/i);
  assert.match(content, /example\.com/i);
});
