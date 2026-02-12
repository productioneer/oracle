const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { getThinkingContent } = require("../dist/browser/chatgpt.js");

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) {
    await browser.close();
  }
});

test("extracts thinking content from sidebar", async () => {
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
  assert.match(content, /sidebar thinking content/i);
});

test("clicks latest thinking header when multiple are present", async () => {
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

test("extracts thinking content via fallback sections", async () => {
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
  // Should extract the body text, not the "Pro thinking" header
  assert.match(content, /alpha line/i);
  // Sources section should NOT be included — it's not thinking content
  assert.doesNotMatch(content, /sources/i);
  assert.doesNotMatch(content, /example\.com/i);
});

test("strips Pro thinking prefix from body text", async () => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
  <html>
    <body>
      <section>
        <div>Pro thinking</div>
        <div>Pro thinking\nActual reasoning about the problem</div>
      </section>
    </body>
  </html>`);

  const content = await getThinkingContent(page);
  await page.close();
  assert.match(content, /actual reasoning/i);
  // The "Pro thinking" prefix in the body should be stripped
  assert.ok(!content.startsWith("Pro thinking"));
});

test("excludes Close button text from output", async () => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
  <html>
    <body>
      <section>
        <div>Pro thinking</div>
        <button>Close</button>
        <div>Deep analysis of the problem</div>
      </section>
    </body>
  </html>`);

  const content = await getThinkingContent(page);
  await page.close();
  assert.match(content, /deep analysis/i);
  assert.doesNotMatch(content, /^close$/im);
});
