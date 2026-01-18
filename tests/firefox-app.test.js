const { test } = require('node:test');
const assert = require('node:assert/strict');
const { __test__ } = require('../dist/browser/firefox-app.js');

test('normalizeFirefoxAppPath resolves app bundle', () => {
  const config = __test__.normalizeFirefoxAppPath('/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox');
  assert.equal(config.appPath, '/Applications/Firefox Developer Edition.app');
  assert.equal(config.appName, 'Firefox Developer Edition');
  assert.equal(
    config.executablePath,
    '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox',
  );
});

test('normalizeFirefoxAppPath accepts app path', () => {
  const config = __test__.normalizeFirefoxAppPath('/Applications/Firefox Nightly.app');
  assert.equal(config.appPath, '/Applications/Firefox Nightly.app');
  assert.equal(config.appName, 'Firefox Nightly');
  assert.equal(config.executablePath, '/Applications/Firefox Nightly.app/Contents/MacOS/firefox');
});

test('normalizeFirefoxAppPath rejects non-app paths', () => {
  assert.equal(__test__.normalizeFirefoxAppPath('/Applications/Firefox'), null);
});
