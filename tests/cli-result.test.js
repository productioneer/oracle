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

  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify(
      {
        runId,
        createdAt: new Date().toISOString(),
        prompt: 'hi',
        promptHash: 'hash',
        browser: 'chrome',
        profile: { kind: 'chrome', userDataDir: path.join(root, 'profile') },
        headless: false,
        baseUrl: 'https://chatgpt.com/',
        allowVisible: false,
        allowKill: false,
        pollMs: 15000,
        timeoutMs: 60000,
        thinking: 'extended',
        attempt: 1,
        maxAttempts: 1,
        outDir: runDir,
        statusPath: path.join(runDir, 'status.json'),
        resultPath: path.join(runDir, 'result.md'),
        resultJsonPath: path.join(runDir, 'result.json'),
        logPath: path.join(runDir, 'run.log'),
        runPath: path.join(runDir, 'run.json'),
      },
      null,
      2,
    ),
  );

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
