const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildThinkingState, computeThinkingIncrement } = require('../dist/run/thinking.js');

test('computeThinkingIncrement returns full text on first read', () => {
  const full = 'hello world';
  const result = computeThinkingIncrement(full, null);
  assert.equal(result.chunk, full);
  assert.equal(result.nextState.cursor, full.length);
});

test('computeThinkingIncrement returns delta when prefix matches', () => {
  const full = 'alpha beta gamma';
  const state = buildThinkingState('alpha beta');
  const result = computeThinkingIncrement(full, state);
  assert.equal(result.chunk, ' gamma');
});

test('computeThinkingIncrement resets on prefix mismatch', () => {
  const full = 'fresh content';
  const state = buildThinkingState('old content');
  const result = computeThinkingIncrement(full, state);
  assert.equal(result.chunk, full);
});
