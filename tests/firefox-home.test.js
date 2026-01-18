const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { __test__ } = require('../dist/browser/firefox.js');
const { FIREFOX_HOME_FILENAME, FIREFOX_HOME_TITLE } = require('../dist/browser/firefox-constants.js');

test('ensureFirefoxAutomationHome writes home file and prefs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-firefox-'));
  await __test__.ensureFirefoxAutomationHome(dir);
  const homePath = path.join(dir, FIREFOX_HOME_FILENAME);
  const userJsPath = path.join(dir, 'user.js');
  const home = fs.readFileSync(homePath, 'utf8');
  const userJs = fs.readFileSync(userJsPath, 'utf8');
  assert.ok(home.includes(FIREFOX_HOME_TITLE));
  assert.ok(userJs.includes('browser.startup.homepage'));
  assert.ok(userJs.includes('browser.startup.page'));
  assert.ok(userJs.includes('browser.newtabpage.enabled'));
});

test('ensureFirefoxAutomationHome replaces existing prefs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-firefox-'));
  const userJsPath = path.join(dir, 'user.js');
  fs.writeFileSync(
    userJsPath,
    [
      'user_pref("browser.startup.homepage", "https://example.com");',
      'user_pref("browser.startup.page", 0);',
      'user_pref("browser.newtabpage.enabled", true);',
    ].join('\n'),
    'utf8',
  );
  await __test__.ensureFirefoxAutomationHome(dir);
  const userJs = fs.readFileSync(userJsPath, 'utf8');
  assert.ok(!userJs.includes('https://example.com'));
  assert.ok(userJs.includes('browser.startup.homepage'));
  assert.ok(userJs.includes('browser.startup.page'));
  assert.ok(userJs.includes('browser.newtabpage.enabled'));
});
