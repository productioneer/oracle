const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyRunOverrides } = require('../dist/run/options.js');

test('applyRunOverrides updates selected fields only', () => {
  const config = {
    allowVisible: false,
    allowKill: false,
    timeoutMs: 1000,
    pollMs: 1000,
    thinking: 'extended',
  };
  applyRunOverrides(config, { allowKill: true, pollMs: 2000, thinking: 'standard' });
  assert.equal(config.allowKill, true);
  assert.equal(config.pollMs, 2000);
  assert.equal(config.thinking, 'standard');
  assert.equal(config.allowVisible, false);
});
