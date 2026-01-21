const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parsePromptAttachments } = require('../dist/run/attachments.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-attachments-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('parsePromptAttachments ignores non-file @ tokens', () => {
  const prompt = 'Ping @john and email test@foo.com for details.';
  const parsed = parsePromptAttachments(prompt, process.cwd());
  assert.equal(parsed.prompt, prompt);
  assert.equal(parsed.attachments.length, 0);
});

test('parsePromptAttachments attaches file refs and preserves punctuation', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'note.txt');
    fs.writeFileSync(filePath, 'hello');
    const prompt = 'Review @note.txt, please.';
    const parsed = parsePromptAttachments(prompt, dir);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].path, filePath);
    assert.equal(parsed.prompt, 'Review [attached: note.txt], please.');
  });
});

test('parsePromptAttachments inlines quoted ranges with line numbers', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'my file.ts');
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n');
    const prompt = 'See @"my file.ts":2-3.';
    const parsed = parsePromptAttachments(prompt, dir);
    assert.equal(parsed.attachments.length, 0);
    const expected = 'See ```ts\n2\ttwo\n3\tthree\n```.';
    assert.equal(parsed.prompt, expected);
  });
});

test('parsePromptAttachments preserves blank lines in inline content', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'note.md');
    fs.writeFileSync(filePath, 'alpha\n\nbeta\n');
    const prompt = 'Include @note.md:1-3';
    const parsed = parsePromptAttachments(prompt, dir);
    assert.equal(parsed.attachments.length, 0);
    const expected = 'Include ```md\n1\talpha\n2\t\n3\tbeta\n```';
    assert.equal(parsed.prompt, expected);
  });
});

test('parsePromptAttachments de-dupes inline ranges', () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, 'sample.ts');
    fs.writeFileSync(filePath, 'alpha\nbeta\n');
    const prompt = '@sample.ts:1-2 and again @sample.ts:1-2';
    const parsed = parsePromptAttachments(prompt, dir);
    assert.equal(parsed.attachments.length, 0);
    assert.ok(parsed.prompt.includes('```ts\n1\talpha\n2\tbeta\n```'));
    assert.ok(parsed.prompt.includes('[see sample.ts:L1-2 above]'));
  });
});

test('parsePromptAttachments ignores @org/repo-style tokens', () => {
  const prompt = 'Check @org/repo and @team/project for updates.';
  const parsed = parsePromptAttachments(prompt, process.cwd());
  assert.equal(parsed.prompt, prompt);
  assert.equal(parsed.attachments.length, 0);
});
