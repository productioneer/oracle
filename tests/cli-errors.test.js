const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function makeRunRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRunConfig(root, runId, overrides = {}) {
  const runDir = path.join(root, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const config = {
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
    ...overrides,
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(config, null, 2));
  return { runDir, config };
}

function writeStatus(runDir, status) {
  fs.writeFileSync(
    path.join(runDir, 'status.json'),
    JSON.stringify(status, null, 2),
  );
}

test('status errors when run missing', () => {
  const root = makeRunRoot('oracle-status-missing-');
  const res = runCli(['status', 'missing-run', '--runs-root', root]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('run not found'));
});

test('status errors when status missing', () => {
  const root = makeRunRoot('oracle-status-nostatus-');
  writeRunConfig(root, 'abc123-def456');
  const res = runCli(['status', 'abc123-def456', '--runs-root', root]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('status not available'));
});

test('status waits for needs_user to resolve', async () => {
  const root = makeRunRoot('oracle-status-needs-user-');
  const runId = 'abc123-def456';
  const { runDir } = writeRunConfig(root, runId);
  writeStatus(runDir, {
    runId,
    state: 'needs_user',
    stage: 'login',
    updatedAt: new Date().toISOString(),
    attempt: 1,
    needs: { type: 'login', details: 'login required' },
  });

  const child = spawn(process.execPath, [cliPath, 'status', runId, '--runs-root', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  setTimeout(() => {
    writeStatus(runDir, {
      runId,
      state: 'running',
      stage: 'waiting',
      message: 'awaiting response',
      updatedAt: new Date().toISOString(),
      attempt: 1,
    });
  }, 50);

  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.trim(), '');
  assert.ok(stdout.includes('running (waiting)'));
});

test('result errors when missing', () => {
  const root = makeRunRoot('oracle-result-missing-');
  writeRunConfig(root, 'abc123-def456');
  const res = runCli(['result', 'abc123-def456', '--runs-root', root]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('result not available'));
});

test('thinking errors when conversation missing', () => {
  const root = makeRunRoot('oracle-thinking-missing-');
  const { runDir } = writeRunConfig(root, 'abc123-def456');
  writeStatus(runDir, {
    runId: 'abc123-def456',
    state: 'running',
    stage: 'waiting',
    updatedAt: new Date().toISOString(),
    attempt: 1,
  });
  const res = runCli(['thinking', 'abc123-def456', '--runs-root', root]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('thinking not available'));
});

test('resume errors when run completed', () => {
  const root = makeRunRoot('oracle-resume-completed-');
  const { runDir } = writeRunConfig(root, 'abc123-def456');
  writeStatus(runDir, {
    runId: 'abc123-def456',
    state: 'completed',
    stage: 'cleanup',
    updatedAt: new Date().toISOString(),
    attempt: 1,
  });
  const res = runCli(['resume', 'abc123-def456', '--runs-root', root]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('already completed'));
});

test('cancel errors when run completed', () => {
  const root = makeRunRoot('oracle-cancel-completed-');
  const { runDir } = writeRunConfig(root, 'abc123-def456');
  writeStatus(runDir, {
    runId: 'abc123-def456',
    state: 'completed',
    stage: 'cleanup',
    updatedAt: new Date().toISOString(),
    attempt: 1,
  });
  const res = runCli(['cancel', 'abc123-def456', '--runs-root', root]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('already completed'));
});

test('open errors when conversation missing', () => {
  const root = makeRunRoot('oracle-open-noconvo-');
  const { runDir } = writeRunConfig(root, 'abc123-def456');
  writeStatus(runDir, {
    runId: 'abc123-def456',
    state: 'completed',
    stage: 'cleanup',
    updatedAt: new Date().toISOString(),
    attempt: 1,
  });
  const res = runCli(['open', 'abc123-def456', '--runs-root', root]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('no conversation URL'));
});

test('run errors on invalid browser in dev mode', () => {
  const root = makeRunRoot('oracle-run-invalid-browser-');
  const res = runCli(
    ['run', '--browser', 'safari', '--prompt', 'hi', '--runs-root', root],
    { env: { ORACLE_DEV: '1' } },
  );
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('Unknown browser'));
});

test('run errors on missing prompt file', () => {
  const root = makeRunRoot('oracle-run-missing-prompt-');
  const res = runCli(
    ['run', '--prompt-file', path.join(root, 'missing.txt'), '--runs-root', root],
  );
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('Prompt file not found'));
});
