const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const puppeteer = require('puppeteer');
const { submitPrompt } = require('../dist/browser/chatgpt.js');

function startServer(html) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

test('submitPrompt types multiline content with text and newlines', async () => {
  const html = `<!doctype html>
  <html>
    <body>
      <textarea id="prompt-textarea" placeholder="Message"></textarea>
      <button data-testid="send-button">Send</button>
    </body>
  </html>`;

  const { server, port } = await startServer(html);
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  try {
    await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'domcontentloaded',
    });
    const prompt = [
      'What functions are in this code? Just list function names. ```ts',
      '1\t// test file for oracle',
      '2\texport function hello() {}',
      '```',
    ].join('\n');
    const typedValue = await submitPrompt(page, prompt);
    const value = await page.$eval('#prompt-textarea', (el) => el.value);
    assert.equal(typedValue, value);
    const lines = value.split('\n');
    assert.equal(lines.length, 4);
    assert.ok(lines[0].includes('What functions are in this code?'));
    assert.ok(lines[1].includes('1'));
    assert.ok(lines[1].includes('// test file for oracle'));
    assert.ok(lines[2].includes('2'));
    assert.ok(lines[2].includes('export function hello()'));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
