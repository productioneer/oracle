import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { pathExists, readJson, writeJsonAtomic } from '../utils/fs.js';
import { sleep } from '../utils/time.js';

type ApprovalFile = {
  approvedAt: number;
};

type DoneFile = {
  doneAt: number;
  approvedAt?: number;
};

export type RestartApprovalResult =
  | { action: 'restart'; approvedAt: number }
  | { action: 'done'; doneAt: number }
  | { action: 'canceled' };

const APPROVAL_FILE = 'chrome-restart.json';
const DONE_FILE = 'chrome-restart.done';
const RESTART_LOCK = 'chrome-restart.lock';
const NOTIFY_LOCK = 'chrome-restart.notify';

const DEFAULT_POLL_MS = 2000;

export function approvalsDir(): string {
  const override = process.env.ORACLE_APPROVALS_DIR;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.oracle', 'approvals');
}

export async function ensureApprovalsDir(dir = approvalsDir()): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function writeRestartApproval(dir = approvalsDir(), approvedAt = Date.now()): Promise<void> {
  await ensureApprovalsDir(dir);
  await writeJsonAtomic(path.join(dir, APPROVAL_FILE), { approvedAt });
}

export async function readRestartApproval(dir = approvalsDir()): Promise<ApprovalFile | null> {
  const filePath = path.join(dir, APPROVAL_FILE);
  if (!(await pathExists(filePath))) return null;
  return readJson<ApprovalFile>(filePath).catch(() => null);
}

export async function writeRestartDone(
  dir = approvalsDir(),
  payload: { doneAt?: number; approvedAt?: number } = {},
): Promise<void> {
  await ensureApprovalsDir(dir);
  const doneAt = payload.doneAt ?? Date.now();
  await writeJsonAtomic(path.join(dir, DONE_FILE), { doneAt, approvedAt: payload.approvedAt });
}

export async function readRestartDone(dir = approvalsDir()): Promise<DoneFile | null> {
  const filePath = path.join(dir, DONE_FILE);
  if (!(await pathExists(filePath))) return null;
  return readJson<DoneFile>(filePath).catch(() => null);
}

export async function clearRestartFiles(
  dir = approvalsDir(),
  options: { preserveDone?: boolean } = {},
): Promise<void> {
  const removals = [
    removeFile(path.join(dir, APPROVAL_FILE)),
    removeFile(path.join(dir, RESTART_LOCK)),
    removeFile(path.join(dir, NOTIFY_LOCK)),
  ];
  if (!options.preserveDone) {
    removals.push(removeFile(path.join(dir, DONE_FILE)));
  }
  await Promise.all(removals);
}

export async function tryAcquireRestartLock(dir = approvalsDir()): Promise<boolean> {
  return tryAcquireLock(path.join(dir, RESTART_LOCK));
}

export async function tryAcquireNotifyLock(dir = approvalsDir()): Promise<boolean> {
  return tryAcquireLock(path.join(dir, NOTIFY_LOCK));
}

export async function waitForChromeRestartApproval(options: {
  runId: string;
  notifyTitle?: string;
  notifyMessage?: string;
  pollMs?: number;
  logger?: (msg: string) => void;
  onStatus?: (message: string) => Promise<void>;
  isCanceled?: () => Promise<boolean>;
  notify?: (title: string, message: string) => Promise<boolean | null>;
}): Promise<RestartApprovalResult> {
  const dir = approvalsDir();
  await ensureApprovalsDir(dir);
  const waitSince = Date.now();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const logger = options.logger ?? (() => null);
  const title = options.notifyTitle ?? 'Approve Chrome restart';
  const message =
    options.notifyMessage ?? `Oracle run ${options.runId} needs to restart Chrome to continue.`;
  const notify = options.notify ?? notifyWithNotifiCli;
  let notified = false;
  let forceDone = false;

  let statusNotifiedAt = 0;
  const statusThrottleMs = 60_000;
  if (options.onStatus) {
    await options.onStatus('waiting for approval to restart Chrome');
    statusNotifiedAt = Date.now();
  }

  while (true) {
    if (options.isCanceled && (await options.isCanceled())) {
      return { action: 'canceled' };
    }

    if (options.onStatus && Date.now() - statusNotifiedAt > statusThrottleMs) {
      await options.onStatus('waiting for approval to restart Chrome');
      statusNotifiedAt = Date.now();
    }

    const done = await readRestartDone(dir);
    if (done && isFreshTimestamp(done.doneAt, waitSince, done.approvedAt)) {
      return { action: 'done', doneAt: done.doneAt };
    }

    const approval = await readRestartApproval(dir);
    if (approval && approval.approvedAt >= waitSince) {
      const acquired = await tryAcquireRestartLock(dir);
      if (acquired) {
        return { action: 'restart', approvedAt: approval.approvedAt };
      }
      // Someone else is restarting; wait for done.
    } else if (!notified) {
      const acquiredNotify = await tryAcquireNotifyLock(dir);
      if (acquiredNotify) {
        const approved = await notify(title, message);
        if (approved) {
          await writeRestartApproval(dir, Date.now());
          forceDone = true;
        } else {
          logger('[restart] approval dismissed');
        }
      }
      notified = true;
    } else if (forceDone) {
      const done = await readRestartDone(dir);
      if (done && isFreshTimestamp(done.doneAt, waitSince, done.approvedAt)) {
        return { action: 'done', doneAt: done.doneAt };
      }
    }

    await sleep(pollMs);
  }
}

export async function markChromeRestartDone(payload: { approvedAt?: number } = {}): Promise<void> {
  const dir = approvalsDir();
  await writeRestartDone(dir, { approvedAt: payload.approvedAt });
  await clearRestartFiles(dir, { preserveDone: true });
}

export async function notifyWithNotifiCli(title: string, message: string): Promise<boolean | null> {
  const command = resolveNotifiCli();
  if (!command) return notifyWithAppleScript(title, message);
  try {
    const choice = await runCommand(command, [
      '-title',
      title,
      '-message',
      message,
      '-actions',
      'Approve restart,Cancel',
    ]);
    if (!choice) return notifyWithAppleScript(title, message);
    const normalized = choice.trim().toLowerCase();
    if (normalized === 'approve restart') return true;
    if (normalized === 'default') return true;
    return false;
  } catch {
    return notifyWithAppleScript(title, message);
  }
}

export async function notifyWithAppleScript(title: string, message: string): Promise<boolean | null> {
  const script = [
    'try',
    `button returned of (display alert ${escapeAppleScript(title)} message ${escapeAppleScript(
      message,
    )} buttons {"Approve restart","Cancel"} default button "Approve restart" cancel button "Cancel")`,
    'on error',
    'return "Cancel"',
    'end try',
  ].join('\n');
  try {
    const output = await runCommand('/usr/bin/osascript', ['-e', script]);
    const normalized = output.trim().toLowerCase();
    if (normalized === 'approve restart') return true;
    return false;
  } catch {
    return null;
  }
}

function resolveNotifiCli(): string | null {
  const override = process.env.ORACLE_NOTIFICLI_PATH;
  if (override && override.trim()) return override.trim();
  return which('notificli');
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const error = new Error(`Command failed: ${command} ${args.join(' ')} (${code}) ${stderr.trim()}`);
      reject(error);
    });
  });
}

function which(command: string): string | null {
  const envPath = process.env.PATH ?? '';
  const parts = envPath.split(path.delimiter).filter(Boolean);
  for (const part of parts) {
    const candidate = path.join(part, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    await handle.close();
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
}

function isFreshTimestamp(doneAt: number, waitSince: number, approvedAt?: number): boolean {
  if (doneAt >= waitSince) return true;
  if (approvedAt !== undefined && approvedAt >= waitSince) return true;
  return false;
}

function escapeAppleScript(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
