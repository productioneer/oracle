const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareFirefoxWindowSize } = require('../dist/browser/firefox.js');

async function readXulstore(dir) {
  const raw = await fs.readFile(path.join(dir, 'xulstore.json'), 'utf8');
  return JSON.parse(raw);
}

test('prepareFirefoxWindowSize writes main-window size', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-ff-'));
  const changed = await prepareFirefoxWindowSize(dir, { width: 360, height: 240 });
  assert.equal(changed, true);
  const data = await readXulstore(dir);
  const main = data['chrome://browser/content/browser.xhtml']?.['main-window'];
  assert.equal(main.width, '360');
  assert.equal(main.height, '240');
  assert.equal(main.sizemode, 'normal');
});

test('prepareFirefoxWindowSize preserves existing fields and detects no-op', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-ff-'));
  const seed = {
    'chrome://browser/content/browser.xhtml': {
      'main-window': {
        width: '1280',
        height: '800',
        sizemode: 'normal',
        screenX: '100',
        screenY: '200',
      },
      other: { key: 'value' },
    },
    otherRoot: { foo: 'bar' },
  };
  await fs.writeFile(path.join(dir, 'xulstore.json'), `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  const changed = await prepareFirefoxWindowSize(dir, { width: 1280, height: 800 });
  assert.equal(changed, false);
  const data = await readXulstore(dir);
  const main = data['chrome://browser/content/browser.xhtml']?.['main-window'];
  assert.equal(main.screenX, '100');
  assert.equal(main.screenY, '200');
  assert.equal(data['chrome://browser/content/browser.xhtml']?.other?.key, 'value');
  assert.equal(data.otherRoot?.foo, 'bar');
});
