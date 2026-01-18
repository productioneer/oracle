import { execFile } from 'child_process';
import type { Logger } from '../utils/log.js';
import { sleep } from '../utils/time.js';
import { FIREFOX_HOME_TITLE } from './firefox-constants.js';

export type FocusState = 'background' | 'hidden' | 'visible';
export type FocusNeedsType = 'automation' | 'accessibility' | 'unknown';

export type FocusNeeds = {
  type: FocusNeedsType;
  details?: string;
};

export type FocusStatus = {
  state: FocusState;
  reason?: string;
  needsUser?: FocusNeeds;
};

export type FocusAttempt = {
  action: 'background' | 'hide' | 'minimize';
  ok: boolean;
  reason?: string;
  needsUser?: FocusNeeds;
};

export type WindowSize = {
  width: number;
  height: number;
};

export type FirefoxWindowPhase = 'setup' | 'work';

export type FirefoxWindowResizeResult = {
  phase: FirefoxWindowPhase;
  size: WindowSize;
  ok: boolean;
  reason?: string;
  needsUser?: FocusNeeds;
};

export type FirefoxSetupResult = {
  focus: FocusStatus;
  resized?: FirefoxWindowResizeResult;
  attempts: number;
  elapsedMs: number;
};

export type FocusStrategyOptions = {
  browser: 'chrome' | 'firefox';
  allowVisible: boolean;
  appName?: string;
  pid?: number;
  logger?: Logger;
};

const APPLE_SCRIPT_TIMEOUT_MS = 2_000;
export const FIREFOX_SETUP_DELAY_MS = 750;
export const FIREFOX_SETUP_MAX_MS = 3_000;
export const FIREFOX_SETUP_RETRY_MS = 100;
export const FIREFOX_SETUP_WINDOW: WindowSize = { width: 360, height: 240 };
export const FIREFOX_WORK_WINDOW: WindowSize = { width: 1280, height: 800 };

export async function applyFocusStrategy(options: FocusStrategyOptions): Promise<FocusStatus | undefined> {
  if (options.allowVisible) {
    return { state: 'visible', reason: 'allow-visible' };
  }
  if (process.platform !== 'darwin') return undefined;

  const appName = options.appName ?? (options.browser === 'firefox' ? 'Firefox' : 'Google Chrome');

  if (options.browser === 'chrome') {
    return { state: 'background', reason: 'launch-args' };
  }

  return suppressFirefoxFocusMac(appName, options.pid, options.logger);
}

export async function runFirefoxSetupPhase(
  appName: string,
  pid: number | undefined,
  logger?: Logger,
): Promise<FirefoxSetupResult> {
  const start = Date.now();
  if (!pid) {
    return { focus: { state: 'visible', reason: 'pid-missing' }, attempts: 0, elapsedMs: 0 };
  }
  const trusted = await waitForTrustedFirefoxWindow(appName, pid, logger, { timeoutMs: 1_000 });
  if (!trusted) {
    logger?.('[focus] firefox window mismatch; skipping suppression');
    return { focus: { state: 'visible', reason: 'window-mismatch' }, attempts: 0, elapsedMs: Date.now() - start };
  }
  let focus: FocusStatus = { state: 'visible', reason: 'setup-timeout' };
  let resized: FirefoxWindowResizeResult | undefined;
  let attempts = 0;
  while (Date.now() - start < FIREFOX_SETUP_MAX_MS) {
    attempts += 1;
    const focusAttempt = await suppressFirefoxFocusMac(appName, pid, logger, { delayMs: 0 });
    focus = mergeFocusStatus(focus, focusAttempt);
    const resizeAttempt = await resizeFirefoxWindow(appName, pid, 'setup', logger);
    if (resizeAttempt.needsUser && !focus.needsUser) {
      focus.needsUser = resizeAttempt.needsUser;
    }
    resized = resizeAttempt;
    if (focusAttempt.needsUser || resizeAttempt.needsUser) {
      break;
    }
    const windowState = await getWindowState(appName, pid);
    if (windowState.ok && windowState.state !== 'visible') {
      break;
    }
    await sleep(FIREFOX_SETUP_RETRY_MS);
  }
  const finalState = await getWindowState(appName, pid);
  if (finalState.ok && finalState.state === 'visible') {
    const parked = await parkFirefoxWindowOffscreen(appName, pid, logger);
    if (parked) {
      focus = { state: 'hidden', reason: 'offscreen' };
    }
  }
  logger?.(
    `[focus] firefox setup attempts=${attempts} state=${focus.state} reason=${focus.reason ?? ''} elapsed=${Date.now() - start}ms`.trim(),
  );
  return {
    focus,
    resized,
    attempts,
    elapsedMs: Date.now() - start,
  };
}

export async function resizeFirefoxWindow(
  appName: string,
  pid: number | undefined,
  phase: FirefoxWindowPhase,
  logger?: Logger,
): Promise<FirefoxWindowResizeResult> {
  const size = phase === 'setup' ? FIREFOX_SETUP_WINDOW : FIREFOX_WORK_WINDOW;
  if (process.platform !== 'darwin') {
    return { phase, size, ok: false, reason: 'unsupported-platform' };
  }
  if (!pid) {
    return { phase, size, ok: false, reason: 'pid-missing' };
  }
  const trusted = await waitForTrustedFirefoxWindow(appName, pid, logger, { timeoutMs: 500 });
  if (!trusted) {
    return { phase, size, ok: false, reason: 'window-mismatch' };
  }
  const script = [
    'tell application "System Events"',
    ...processSelectorLines(appName, pid),
    'tell targetProc',
    'if (count of windows) = 0 then return "no-window"',
    'set frontmost to false',
    `set size of window 1 to {${size.width}, ${size.height}}`,
    'return "ok"',
    'end tell',
    'end tell',
  ];
  const result = await runAppleScript(script);
  if (result.ok) {
    const output = result.stdout.trim().toLowerCase();
    if (output === 'missing') {
      return { phase, size, ok: false, reason: 'process-missing' };
    }
    if (output === 'no-window') {
      return { phase, size, ok: false, reason: 'no-window' };
    }
    logger?.(`[focus] firefox ${phase} window size ${size.width}x${size.height}`);
    return { phase, size, ok: true };
  }
  return {
    phase,
    size,
    ok: false,
    reason: result.error ?? 'resize-failed',
    needsUser: classifyAppleScriptError(result.error ?? ''),
  };
}

export async function waitForTrustedFirefoxWindow(
  appName: string,
  pid: number,
  logger?: Logger,
  options?: { timeoutMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 750;
  const start = Date.now();
  let lastTitle = '';
  while (Date.now() - start < timeoutMs) {
    const title = await getWindowTitle(appName, pid);
    if (title.ok) {
      lastTitle = title.title ?? '';
      if (lastTitle && lastTitle.toLowerCase().includes(FIREFOX_HOME_TITLE.toLowerCase())) {
        return true;
      }
    }
    await sleep(100);
  }
  if (lastTitle) {
    logger?.(`[focus] firefox window title mismatch: "${lastTitle}"`);
  }
  return false;
}

async function suppressFirefoxFocusMac(
  appName: string,
  pid: number | undefined,
  logger?: Logger,
  options?: { delayMs?: number },
): Promise<FocusStatus> {
  const attempts: FocusAttempt[] = [
    {
      action: 'background',
      ok: false,
      reason: 'launch-no-foreground',
    },
  ];

  if ((options?.delayMs ?? 250) > 0) {
    await sleep(options?.delayMs ?? 250);
  }

  if (!pid) {
    attempts[0].reason = 'pid-missing';
    return resolveFocusStatus(attempts);
  }
  const frontmost = await isAppFrontmost(appName, pid);
  if (frontmost.ok && frontmost.frontmost === false) {
    attempts[0].ok = true;
    attempts[0].reason = 'not-frontmost';
    logger?.('[focus] firefox already background');
  }
  if (!frontmost.ok) {
    attempts[0].reason = frontmost.reason ?? attempts[0].reason;
    attempts[0].needsUser = frontmost.needsUser;
  } else if (frontmost.frontmost) {
    attempts[0].reason = 'frontmost';
  }

  const hideAttempt = await hideApp(appName, pid);
  attempts.push(hideAttempt);
  if (hideAttempt.ok) {
    logger?.('[focus] firefox hidden');
    return resolveFocusStatus(attempts);
  }

  const minimizeAttempt = await minimizeApp(appName, pid);
  attempts.push(minimizeAttempt);
  if (minimizeAttempt.ok) {
    logger?.('[focus] firefox minimized');
  }
  return resolveFocusStatus(attempts);
}

async function isAppFrontmost(appName: string, pid: number): Promise<{
  ok: boolean;
  frontmost?: boolean;
  reason?: string;
  needsUser?: FocusNeeds;
}> {
  const script = [
    'tell application "System Events"',
    ...processSelectorLines(appName, pid),
    'return frontmost of targetProc',
    'end tell',
  ];
  const result = await runAppleScript(script);
  if (!result.ok) {
    if (isProcessMissingError(result.error ?? '')) {
      return { ok: false, reason: 'process-missing' };
    }
    return {
      ok: false,
      reason: result.error ?? 'frontmost-check-failed',
      needsUser: classifyAppleScriptError(result.error ?? ''),
    };
  }
  const value = result.stdout.trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    return {
      ok: false,
      reason: value ? `unexpected-frontmost:${value}` : 'unexpected-frontmost',
      needsUser: undefined,
    };
  }
  return { ok: true, frontmost: value === 'true' };
}

async function hideApp(appName: string, pid: number): Promise<FocusAttempt> {
  const script = [
    'tell application "System Events"',
    ...processSelectorLines(appName, pid),
    'tell targetProc',
    'set visible to false',
    'return "ok"',
    'end tell',
    'end tell',
  ];
  const result = await runAppleScript(script);
  if (result.ok) {
    const state = await getWindowState(appName, pid);
    if (state.ok && state.state === 'visible') {
      return { action: 'hide', ok: false, reason: 'still-visible' };
    }
    return { action: 'hide', ok: true, reason: 'app-hide' };
  }
  return {
    action: 'hide',
    ok: false,
    reason: result.error ?? 'app-hide-failed',
    needsUser: classifyAppleScriptError(result.error ?? ''),
  };
}

async function minimizeApp(appName: string, pid: number): Promise<FocusAttempt> {
  const script = [
    'tell application "System Events"',
    ...processSelectorLines(appName, pid),
    'tell targetProc',
    'set frontmost to false',
    'repeat with theWindow in windows',
    'try',
    'set value of attribute "AXMinimized" of theWindow to true',
    'end try',
    'end repeat',
    'set visible to false',
    'end tell',
    'return "ok"',
    'end tell',
  ];
  const result = await runAppleScript(script);
  if (result.ok) {
    const output = result.stdout.trim().toLowerCase();
    if (output === 'missing') {
      return { action: 'minimize', ok: false, reason: 'process-missing' };
    }
    const state = await getWindowState(appName, pid);
    if (state.ok && state.state === 'visible') {
      return { action: 'minimize', ok: false, reason: 'still-visible' };
    }
    return { action: 'minimize', ok: true, reason: 'minimized' };
  }
  return {
    action: 'minimize',
    ok: false,
    reason: result.error ?? 'minimize-failed',
    needsUser: classifyAppleScriptError(result.error ?? ''),
  };
}

async function runAppleScript(lines: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile('osascript', lines.flatMap((line) => ['-e', line]), { timeout: APPLE_SCRIPT_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        const message = [error.message, stderr].filter(Boolean).join('\n').trim();
        resolve({ ok: false, stdout: stdout ?? '', error: message || 'osascript-failed' });
        return;
      }
      resolve({ ok: true, stdout: stdout ?? '' });
    });
  });
}

export function classifyAppleScriptError(raw: string): FocusNeeds | undefined {
  const message = raw.trim();
  if (!message) return undefined;
  const lower = message.toLowerCase();
  if (lower.includes('ui scripting') || lower.includes('assistive') || lower.includes('accessibility')) {
    return { type: 'accessibility', details: message };
  }
  if (lower.includes('(-25211)')) {
    return { type: 'accessibility', details: message };
  }
  if (lower.includes('not authorized') || lower.includes('not authorised') || lower.includes('not permitted') || lower.includes('not allowed')) {
    if (lower.includes('system events') || lower.includes('apple events') || lower.includes('automation')) {
      return { type: 'automation', details: message };
    }
    return { type: 'automation', details: message };
  }
  if (lower.includes('(-1743)')) {
    return { type: 'automation', details: message };
  }
  return undefined;
}

export function resolveFocusStatus(attempts: FocusAttempt[]): FocusStatus {
  for (const attempt of attempts) {
    if ((attempt.action === 'hide' || attempt.action === 'minimize') && attempt.ok) {
      return { state: 'hidden', reason: attempt.reason };
    }
  }
  for (const attempt of attempts) {
    if (attempt.action === 'background' && attempt.ok) {
      return { state: 'background', reason: attempt.reason };
    }
  }
  const last = attempts[attempts.length - 1];
  const needsUser = [...attempts].reverse().find((attempt) => attempt.needsUser)?.needsUser;
  return {
    state: 'visible',
    reason: last?.reason ?? 'focus-fallback',
    needsUser,
  };
}

function mergeFocusStatus(current: FocusStatus, incoming: FocusStatus): FocusStatus {
  const needsUser = current.needsUser ?? incoming.needsUser;
  if (incoming.state !== 'visible') {
    return { ...incoming, needsUser };
  }
  if (current.state !== 'visible') {
    return { ...current, needsUser };
  }
  return { ...incoming, needsUser };
}

function isProcessMissingError(raw: string): boolean {
  const lower = raw.toLowerCase();
  if (lower.includes("can't get process")) return true;
  if (lower.includes('can’t get process')) return true;
  if (lower.includes('process') && lower.includes('not found')) return true;
  return false;
}

export function parseAppleScriptBool(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

type WindowState = 'hidden' | 'minimized' | 'visible' | 'no-window';

type WindowStateResult = {
  ok: boolean;
  state?: WindowState;
  reason?: string;
  needsUser?: FocusNeeds;
};

async function getWindowState(appName: string, pid: number): Promise<WindowStateResult> {
  const script = [
    'tell application "System Events"',
    ...processSelectorLines(appName, pid),
    'tell targetProc',
    'if (count of windows) = 0 then return "no-window"',
    'set anyVisible to false',
    'set anyUnminimized to false',
    'repeat with theWindow in windows',
    'set isVisible to true',
    'try',
    'set isVisible to value of attribute "AXVisible" of theWindow',
    'end try',
    'set isMinimized to false',
    'try',
    'set isMinimized to value of attribute "AXMinimized" of theWindow',
    'end try',
    'if isVisible is true then set anyVisible to true',
    'if isMinimized is false then set anyUnminimized to true',
    'end repeat',
    'if anyVisible is false then return "hidden"',
    'if anyUnminimized is false then return "minimized"',
    'return "visible"',
    'end tell',
    'end tell',
  ];
  const result = await runAppleScript(script);
  if (!result.ok) {
    if (isProcessMissingError(result.error ?? '')) {
      return { ok: false, reason: 'process-missing' };
    }
    return {
      ok: false,
      reason: result.error ?? 'window-state-failed',
      needsUser: classifyAppleScriptError(result.error ?? ''),
    };
  }
  const value = result.stdout.trim().toLowerCase();
  if (value === 'hidden' || value === 'minimized' || value === 'visible' || value === 'no-window') {
    return { ok: true, state: value as WindowState };
  }
  return { ok: false, reason: value ? `unexpected-window:${value}` : 'unexpected-window' };
}

async function getWindowTitle(
  appName: string,
  pid: number,
): Promise<{ ok: boolean; title?: string; reason?: string; needsUser?: FocusNeeds }> {
  const script = [
    'tell application "System Events"',
    ...processSelectorLines(appName, pid),
    'tell targetProc',
    'if (count of windows) = 0 then return "no-window"',
    'try',
    'set title to name of window 1',
    'return title',
    'on error',
    'return ""',
    'end try',
    'end tell',
    'end tell',
  ];
  const result = await runAppleScript(script);
  if (!result.ok) {
    if (isProcessMissingError(result.error ?? '')) {
      return { ok: false, reason: 'process-missing' };
    }
    return {
      ok: false,
      reason: result.error ?? 'window-title-failed',
      needsUser: classifyAppleScriptError(result.error ?? ''),
    };
  }
  const value = result.stdout.trim();
  if (value === 'no-window') {
    return { ok: false, reason: 'no-window' };
  }
  return { ok: true, title: value };
}

async function parkFirefoxWindowOffscreen(appName: string, pid: number, logger?: Logger): Promise<boolean> {
  const script = [
    'tell application "System Events"',
    ...processSelectorLines(appName, pid),
    'tell targetProc',
    'if (count of windows) = 0 then return "no-window"',
    'set frontmost to false',
    'set position of window 1 to {-2000, -2000}',
    'return "ok"',
    'end tell',
    'end tell',
  ];
  const result = await runAppleScript(script);
  if (!result.ok) {
    logger?.(`[focus] firefox park offscreen failed: ${result.error ?? 'unknown'}`);
    return false;
  }
  const output = result.stdout.trim().toLowerCase();
  if (output === 'no-window' || output === 'missing') {
    return false;
  }
  logger?.('[focus] firefox parked offscreen');
  return true;
}

function processSelectorLines(appName: string, pid: number): string[] {
  if (!pid) {
    return [
      `if not (exists process "${appName}") then return "missing"`,
      `set targetProc to process "${appName}"`,
    ];
  }
  return [
    `set matches to (every process whose unix id is ${pid})`,
    'if (count of matches) = 0 then return "missing"',
    'set targetProc to item 1 of matches',
  ];
}
