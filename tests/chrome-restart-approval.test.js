const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const {
  approvalsDir,
  writeRestartApproval,
  readRestartApproval,
  writeRestartDone,
  readRestartDone,
  tryAcquireRestartLock,
  waitForChromeRestartApproval,
} = require('../dist/notifications/chrome-restart.js');

const testDir = path.join(os.tmpdir(), `oracle-approvals-${Date.now()}`);

beforeEach(async () => {
  process.env.ORACLE_APPROVALS_DIR = testDir;
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  delete process.env.ORACLE_APPROVALS_DIR;
});

test('approval + lock + done flow allows only one restart', async () => {
  const now = Date.now();
  await writeRestartApproval(approvalsDir(), now);

  const approval = await readRestartApproval(approvalsDir());
  assert.equal(approval.approvedAt, now);

  const firstLock = await tryAcquireRestartLock(approvalsDir());
  const secondLock = await tryAcquireRestartLock(approvalsDir());
  assert.equal(firstLock, true);
  assert.equal(secondLock, false);

  await writeRestartDone(approvalsDir(), { doneAt: now + 1, approvedAt: now });
  const done = await readRestartDone(approvalsDir());
  assert.equal(done.approvedAt, now);
});

test('waiters: one restart, others see done', async () => {
  const runA = waitForChromeRestartApproval({
    runId: 'run-a',
    pollMs: 50,
    notify: async () => true,
  });

  const resultA = await runA;
  assert.equal(resultA.action, 'restart');

  const runB = waitForChromeRestartApproval({
    runId: 'run-b',
    pollMs: 50,
    notify: async () => true,
  });

  await writeRestartDone(approvalsDir(), { approvedAt: resultA.approvedAt });

  const resultB = await runB;
  assert.equal(resultB.action, 'done');
});
