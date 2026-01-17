const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { oracleChromeDataDir, oracleFirefoxDataDir } = require('../dist/browser/profiles.js');

test('oracle profile dirs default to ~/.oracle', () => {
  const home = os.homedir();
  assert.equal(oracleChromeDataDir(), path.join(home, '.oracle', 'chrome'));
  assert.equal(oracleFirefoxDataDir(), path.join(home, '.oracle', 'firefox'));
  assert.notEqual(oracleChromeDataDir(), oracleFirefoxDataDir());
});
