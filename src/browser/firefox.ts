import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import type { Browser } from "puppeteer";
import type { Logger } from "../utils/log.js";
import { oracleFirefoxDataDir } from "./profiles.js";
import { FIREFOX_SETUP_WINDOW } from "./focus.js";
import {
  FIREFOX_HOME_FILENAME,
  FIREFOX_HOME_TITLE,
} from "./firefox-constants.js";
import type { WindowSize } from "./focus.js";
import { pathExists, readJson, writeJsonAtomic } from "../utils/fs.js";
import { nowIso } from "../utils/time.js";
import { pathToFileURL } from "url";

export type FirefoxLaunchOptions = {
  profilePath?: string;
  allowVisible?: boolean;
  reuse?: boolean;
  executablePath?: string;
  appPath?: string;
  appName?: string;
  logger?: Logger;
};

export type FirefoxConnection = {
  browser: Browser;
  reused: boolean;
  keepAlive: boolean;
  pid?: number;
};

export class FirefoxProfileInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirefoxProfileInUseError";
  }
}

export async function launchFirefox(
  options: FirefoxLaunchOptions,
): Promise<FirefoxConnection> {
  const args: string[] = [];
  const ignoreDefaultArgs: string[] = [];
  const resolvedProfile = path.resolve(
    options.profilePath ?? oracleFirefoxDataDir(),
  );
  await fs.promises.mkdir(resolvedProfile, { recursive: true });
  args.push("-profile", resolvedProfile);
  args.push("-no-remote");

  if (!options.allowVisible && process.platform === "darwin") {
    await ensureFirefoxAutomationHome(resolvedProfile, options.logger);
    await prepareFirefoxWindowSize(
      resolvedProfile,
      FIREFOX_SETUP_WINDOW,
      options.logger,
    );
  }

  const reuse = options.reuse ?? !options.allowVisible;
  const connectionPath = firefoxConnectionPath(resolvedProfile);
  const profileGuard = `Firefox automation profile not detected (${resolvedProfile}). Make sure the Oracle profile is available and retry.`;
  if (reuse && (await pathExists(connectionPath))) {
    const existing = await loadFirefoxConnection(connectionPath);
    if (existing?.wsEndpoint && existing.profilePath === resolvedProfile) {
      if (
        options.appPath &&
        existing.appPath &&
        existing.appPath !== options.appPath
      ) {
        options.logger?.("[firefox] reuse skipped (app mismatch)");
        await fs.promises.unlink(connectionPath).catch(() => null);
      } else if (options.appPath && !existing.appPath) {
        options.logger?.("[firefox] reuse skipped (missing app metadata)");
        await fs.promises.unlink(connectionPath).catch(() => null);
      } else {
        try {
          options.logger?.("[firefox] reuse existing browser");
          const browser = await puppeteer.connect({
            browserWSEndpoint: existing.wsEndpoint,
            protocol: "webDriverBiDi",
          });
          try {
            const pid = await requireFirefoxPid(
              existing.pid,
              resolvedProfile,
              options.logger,
              profileGuard,
            );
            return { browser, reused: true, keepAlive: true, pid };
          } catch (error) {
            await browser.disconnect().catch(() => null);
            throw error;
          }
        } catch (error) {
          options.logger?.(`[firefox] reuse failed: ${String(error)}`);
          await fs.promises.unlink(connectionPath).catch(() => null);
          if (error instanceof FirefoxProfileInUseError) {
            throw error;
          }
        }
      }
    }
  }
  if (reuse) {
    const pid = await findFirefoxAppPidByProfile(
      resolvedProfile,
      options.logger,
    );
    const locked = await isFirefoxProfileLocked(resolvedProfile);
    if (pid || locked) {
      const cleaned = await cleanupAutomationFirefox(
        pid,
        resolvedProfile,
        options.logger,
      );
      if (!cleaned) {
        throw new FirefoxProfileInUseError(
          `Firefox profile already in use (${pid ? `pid ${pid}` : "lock file"}). Close the existing automation Firefox or remove the lock file in ${resolvedProfile}.`,
        );
      }
    }
  }
  if (!options.allowVisible) {
    // Best-effort: keep window in background; Firefox may still focus.
    args.push("-new-instance");
    if (process.platform === "darwin") {
      ignoreDefaultArgs.push("--foreground");
    }
  }
  options.logger?.(`[firefox] launch (bidi) args: ${args.join(" ")}`);
  const browser = await puppeteer.launch({
    browser: "firefox",
    headless: false,
    executablePath: options.executablePath,
    args,
    ignoreDefaultArgs: ignoreDefaultArgs.length ? ignoreDefaultArgs : undefined,
  });
  let pid: number;
  try {
    pid = await requireFirefoxPid(
      browser.process()?.pid,
      resolvedProfile,
      options.logger,
      profileGuard,
    );
  } catch (error) {
    await browser.close().catch(() => null);
    throw error;
  }
  if (reuse) {
    const wsEndpoint = browser.wsEndpoint();
    await writeJsonAtomic(connectionPath, {
      wsEndpoint,
      createdAt: nowIso(),
      profilePath: resolvedProfile,
      pid,
      appPath: options.appPath,
    });
    options.logger?.(`[firefox] wrote connection ${connectionPath}`);
  }
  return { browser, reused: false, keepAlive: reuse, pid };
}

export async function cleanupAutomationProfile(
  profilePath: string,
  logger?: Logger,
): Promise<void> {
  const pids = await findFirefoxAppPidsByProfile(profilePath, logger);
  for (const pid of pids) {
    await terminateFirefoxPid(pid, logger);
  }
  const connectionPath = firefoxConnectionPath(profilePath);
  if (await pathExists(connectionPath)) {
    await fs.promises.unlink(connectionPath).catch(() => null);
  }
  const lockFiles = ["parent.lock", ".parentlock", "lock"];
  for (const lockFile of lockFiles) {
    const lockPath = path.join(profilePath, lockFile);
    if (await pathExists(lockPath)) {
      await fs.promises.unlink(lockPath).catch(() => null);
    }
  }
}

export async function prepareFirefoxWindowSize(
  profilePath: string,
  size: WindowSize,
  logger?: Logger,
): Promise<boolean> {
  const xulstorePath = path.join(profilePath, "xulstore.json");
  let data: Record<string, unknown> = {};
  if (await pathExists(xulstorePath)) {
    try {
      const parsed = await readJson<Record<string, unknown>>(xulstorePath);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed;
      }
    } catch (error) {
      logger?.(`[firefox] failed reading xulstore: ${String(error)}`);
      data = {};
    }
  }
  const updated = updateXulstoreWindow(data, size);
  if (!updated.changed) {
    return false;
  }
  await writeJsonAtomic(xulstorePath, updated.data);
  logger?.(`[firefox] xulstore window ${size.width}x${size.height}`);
  return updated.changed;
}

async function ensureFirefoxAutomationHome(
  profilePath: string,
  logger?: Logger,
): Promise<void> {
  const homePath = path.join(profilePath, FIREFOX_HOME_FILENAME);
  const homeUrl = pathToFileURL(homePath).toString();
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${FIREFOX_HOME_TITLE}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; }
  </style>
</head>
<body>
  <h1>${FIREFOX_HOME_TITLE}</h1>
</body>
</html>
`;
  const existing = (await pathExists(homePath))
    ? await fs.promises.readFile(homePath, "utf8")
    : "";
  if (existing !== html) {
    await fs.promises.writeFile(homePath, html, "utf8");
  }

  const userJsPath = path.join(profilePath, "user.js");
  const prefs = [
    `user_pref("browser.startup.homepage", "${homeUrl}");`,
    'user_pref("browser.startup.page", 1);',
    'user_pref("browser.newtabpage.enabled", false);',
  ];
  const prefKeys = [
    "browser.startup.homepage",
    "browser.startup.page",
    "browser.newtabpage.enabled",
  ];
  const raw = (await pathExists(userJsPath))
    ? await fs.promises.readFile(userJsPath, "utf8")
    : "";
  const filtered = raw
    .split(/\r?\n/)
    .filter((line) => !prefKeys.some((key) => line.includes(`"${key}"`)))
    .filter((line) => line.trim().length > 0);
  const next = [...filtered, ...prefs].join("\n") + "\n";
  if (raw !== next) {
    await fs.promises.writeFile(userJsPath, next, "utf8");
    logger?.("[firefox] wrote automation homepage prefs");
  }
}

type XulstoreUpdateResult = {
  data: Record<string, unknown>;
  changed: boolean;
};

const XULSTORE_BROWSER_KEY = "chrome://browser/content/browser.xhtml";
const XULSTORE_MAIN_WINDOW = "main-window";

function updateXulstoreWindow(
  data: Record<string, unknown>,
  size: WindowSize,
): XulstoreUpdateResult {
  const root = { ...data };
  const browserEntry = readRecord(root[XULSTORE_BROWSER_KEY]);
  const windowEntry = readRecord(browserEntry[XULSTORE_MAIN_WINDOW]);
  const nextWindow = {
    ...windowEntry,
    width: String(size.width),
    height: String(size.height),
    sizemode: "normal",
  };
  const changed =
    windowEntry.width !== nextWindow.width ||
    windowEntry.height !== nextWindow.height ||
    windowEntry.sizemode !== nextWindow.sizemode;
  browserEntry[XULSTORE_MAIN_WINDOW] = nextWindow;
  root[XULSTORE_BROWSER_KEY] = browserEntry;
  return { data: root, changed };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type FirefoxConnectionInfo = {
  wsEndpoint: string;
  createdAt: string;
  profilePath: string;
  pid?: number;
  appPath?: string;
};

function firefoxConnectionPath(profilePath: string): string {
  return path.join(profilePath, "oracle-connection.json");
}

async function loadFirefoxConnection(
  filePath: string,
): Promise<FirefoxConnectionInfo | null> {
  try {
    return await readJson<FirefoxConnectionInfo>(filePath);
  } catch {
    return null;
  }
}

type ProcessInfo = {
  pid: number;
  ppid: number;
  command: string;
};

async function findFirefoxAppPidByProfile(
  profilePath: string,
  logger?: Logger,
): Promise<number | undefined> {
  const pids = await findFirefoxAppPidsByProfile(profilePath, logger);
  return pids[0];
}

async function findFirefoxAppPidsByProfile(
  profilePath: string,
  logger?: Logger,
): Promise<number[]> {
  const appPids = await listFirefoxAppPids();
  const matches: number[] = [];
  for (const pid of appPids) {
    if (await isFirefoxPidUsingProfile(pid, profilePath, logger)) {
      matches.push(pid);
    }
  }
  return matches;
}

async function listFirefoxAppPids(): Promise<number[]> {
  const processes = await listProcessTable();
  const pids: number[] = [];
  for (const info of processes.values()) {
    if (isFirefoxMainCommand(info.command)) {
      pids.push(info.pid);
    }
  }
  return pids;
}

function isFirefoxMainCommand(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower.includes("plugin-container")) return false;
  if (lower.includes("crashhelper")) return false;
  if (lower.includes("gpu-helper")) return false;
  return lower.includes("/firefox");
}

async function listProcessTable(): Promise<Map<number, ProcessInfo>> {
  const { execFile } = await import("child_process");
  const output = await new Promise<string>((resolve) => {
    execFile("ps", ["-ax", "-o", "pid=,ppid=,command="], (err, stdout) => {
      if (err) return resolve("");
      resolve(stdout);
    });
  });
  const table = new Map<number, ProcessInfo>();
  for (const line of output.split(/\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];
    table.set(pid, { pid, ppid, command });
  }
  return table;
}

async function resolveFirefoxPid(
  pid: number | undefined,
  profilePath: string,
  logger?: Logger,
): Promise<number | undefined> {
  if (pid && (await isFirefoxPidUsingProfile(pid, profilePath, logger))) {
    return pid;
  }
  const resolved = await findFirefoxAppPidByProfile(profilePath, logger);
  if (!resolved) {
    logger?.("[firefox] profile pid resolution failed; skipping window ops");
  }
  return resolved;
}

async function requireFirefoxPid(
  pid: number | undefined,
  profilePath: string,
  logger: Logger | undefined,
  message: string,
): Promise<number> {
  const validated = await resolveFirefoxPid(pid, profilePath, logger);
  if (!validated) {
    throw new FirefoxProfileInUseError(message);
  }
  return validated;
}

async function isFirefoxPidUsingProfile(
  pid: number,
  profilePath: string,
  logger?: Logger,
): Promise<boolean> {
  const { execFile } = await import("child_process");
  const output = await new Promise<string>((resolve) => {
    execFile("lsof", ["-p", String(pid)], (err, stdout) => {
      if (err) return resolve("");
      resolve(stdout);
    });
  });
  if (!output) {
    logger?.("[firefox] lsof failed; cannot validate profile");
    return false;
  }
  return output.includes(profilePath);
}

async function isFirefoxProfileLocked(profilePath: string): Promise<boolean> {
  const lockFiles = ["parent.lock", ".parentlock", "lock"];
  for (const lockFile of lockFiles) {
    if (await pathExists(path.join(profilePath, lockFile))) return true;
  }
  return false;
}

async function cleanupAutomationFirefox(
  pid: number | undefined,
  profilePath: string,
  logger?: Logger,
): Promise<boolean> {
  const verifiedPid = await resolveFirefoxPid(pid, profilePath, logger);
  if (verifiedPid) {
    logger?.(`[firefox] terminating stale automation pid ${verifiedPid}`);
    const stopped = await terminateFirefoxPid(verifiedPid, logger);
    if (!stopped) return false;
  }
  const lockFiles = ["parent.lock", ".parentlock", "lock"];
  for (const lockFile of lockFiles) {
    const lockPath = path.join(profilePath, lockFile);
    if (await pathExists(lockPath)) {
      await fs.promises.unlink(lockPath).catch(() => null);
    }
  }
  return true;
}

async function terminateFirefoxPid(
  pid: number,
  logger?: Logger,
  timeoutMs = 5_000,
): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    logger?.(`[firefox] terminate failed: ${String(error)}`);
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    logger?.(`[firefox] kill failed: ${String(error)}`);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const __test__ = {
  isFirefoxMainCommand,
  ensureFirefoxAutomationHome,
};
