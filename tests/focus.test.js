const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveFocusStatus, classifyAppleScriptError, parseAppleScriptBool } = require('../dist/browser/focus.js');

test('resolveFocusStatus prefers background success', () => {
  const status = resolveFocusStatus([
    { action: 'background', ok: true, reason: 'not-frontmost' },
    { action: 'hide', ok: false, reason: 'hide-failed' },
  ]);
  assert.equal(status.state, 'background');
  assert.equal(status.reason, 'not-frontmost');
});

test('resolveFocusStatus falls back to hidden when hide succeeds', () => {
  const status = resolveFocusStatus([
    { action: 'background', ok: false, reason: 'frontmost' },
    { action: 'hide', ok: true, reason: 'app-hide' },
  ]);
  assert.equal(status.state, 'hidden');
  assert.equal(status.reason, 'app-hide');
});

test('resolveFocusStatus marks visible with needsUser when all fail', () => {
  const status = resolveFocusStatus([
    { action: 'background', ok: false, reason: 'frontmost' },
    { action: 'hide', ok: false, reason: 'ui-scripting', needsUser: { type: 'accessibility' } },
    { action: 'minimize', ok: false, reason: 'minimize-failed' },
  ]);
  assert.equal(status.state, 'visible');
  assert.equal(status.needsUser?.type, 'accessibility');
});

test('classifyAppleScriptError identifies accessibility errors', () => {
  const needs = classifyAppleScriptError('System Events got an error: UI scripting not enabled. (-25211)');
  assert.equal(needs?.type, 'accessibility');
});

test('classifyAppleScriptError identifies automation errors', () => {
  const needs = classifyAppleScriptError('Not authorized to send Apple events to System Events. (-1743)');
  assert.equal(needs?.type, 'automation');
});

test('classifyAppleScriptError ignores unknown errors', () => {
  const needs = classifyAppleScriptError('Some unrelated error');
  assert.equal(needs, undefined);
});

test('parseAppleScriptBool parses booleans', () => {
  assert.equal(parseAppleScriptBool('true'), true);
  assert.equal(parseAppleScriptBool('false'), false);
  assert.equal(parseAppleScriptBool(' TRUE '), true);
  assert.equal(parseAppleScriptBool('nope'), undefined);
});
