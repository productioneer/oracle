const { test } = require('node:test');
const assert = require('node:assert/strict');
const { __test__ } = require('../dist/browser/firefox.js');

test('isFirefoxMainCommand filters helper processes', () => {
  assert.equal(__test__.isFirefoxMainCommand('/Applications/Firefox.app/Contents/MacOS/firefox'), true);
  assert.equal(
    __test__.isFirefoxMainCommand(
      '/Applications/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container',
    ),
    false,
  );
  assert.equal(__test__.isFirefoxMainCommand('/Applications/Firefox.app/Contents/MacOS/gpu-helper.app/Contents/MacOS/Firefox GPU Helper'), false);
  assert.equal(__test__.isFirefoxMainCommand('/Applications/Firefox.app/Contents/MacOS/crashhelper'), false);
});
