const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveStallMs, applyRunOverrides } = require('../dist/run/options.js');

test('resolveStallMs prefers explicit value', () => {
  assert.equal(resolveStallMs(60_000, 30_000), 30_000);
});

test('resolveStallMs scales with timeout and clamps to bounds', () => {
  assert.equal(resolveStallMs(60_000), 60_000);
  assert.equal(resolveStallMs(10 * 60 * 1000), 2 * 60 * 1000);
  assert.equal(resolveStallMs(2 * 60 * 60 * 1000), 24 * 60 * 1000);
  assert.equal(resolveStallMs(10 * 60 * 60 * 1000), 30 * 60 * 1000);
});

test('applyRunOverrides updates selected fields only', () => {
  const config = {
    allowVisible: false,
    allowKill: false,
    timeoutMs: 1000,
    pollMs: 1000,
    stableMs: 1000,
    stallMs: 1000,
  };
  applyRunOverrides(config, { allowKill: true, stallMs: 2000 });
  assert.equal(config.allowKill, true);
  assert.equal(config.stallMs, 2000);
  assert.equal(config.allowVisible, false);
});
