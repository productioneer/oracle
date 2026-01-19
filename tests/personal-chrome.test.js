const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldRestartPersonalChrome } = require('../dist/browser/personal-chrome.js');

test('shouldRestartPersonalChrome when previously running and now stopped', () => {
  assert.equal(shouldRestartPersonalChrome([123], []), true);
  assert.equal(shouldRestartPersonalChrome([123, 456], []), true);
  assert.equal(shouldRestartPersonalChrome([], []), false);
  assert.equal(shouldRestartPersonalChrome([123], [123]), false);
  assert.equal(shouldRestartPersonalChrome([], [123]), false);
});
