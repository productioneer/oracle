const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('oracle result prints error immediately', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-result-'));
  const runId = 'abc123-def456';
  const runDir = path.join(root, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const resultPath = path.join(runDir, 'result.json');
  fs.writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      state: 'failed',
      completedAt: new Date().toISOString(),
      error: 'boom',
    }),
  );

  const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');
  const res = spawnSync(
    process.execPath,
    [cliPath, 'result', runId, '--runs-root', root],
    { encoding: 'utf8' },
  );

  assert.equal(res.status, 1);
  assert.equal(res.stdout.trim(), '');
  assert.ok(res.stderr.includes('boom'));
});
