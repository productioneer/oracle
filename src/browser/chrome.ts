import fs from "fs";
import { spawn } from "child_process";
import http from "http";
import path from "path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { sleep } from "../utils/time.js";
import type { Logger } from "../utils/log.js";
import { oracleChromeDataDir } from "./profiles.js";

export type ChromeLaunchOptions = {
  userDataDir?: string;
  profileDir?: string;
  debugPort?: number;
  appName?: string;
  allowVisible?: boolean;
  logger?: Logger;
};

export type ChromeConnection = {
  browser: Browser;
  debugPort: number;
  browserPid?: number;
  reused: boolean;
};

export async function launchChrome(
  options: ChromeLaunchOptions,
): Promise<ChromeConnection> {
  const appName = options.appName ?? "Google Chrome";
  const userDataDir = options.userDataDir ?? oracleChromeDataDir();
  await fs.promises.mkdir(userDataDir, { recursive: true });
  const existingPort = await findExistingChromePort(userDataDir);
  if (existingPort) {
    const version = await fetchJson(
      `http://127.0.0.1:${existingPort}/json/version`,
      1_000,
    ).catch(() => null);
    if (version?.webSocketDebuggerUrl) {
      const browser = await chromium.connectOverCDP(
        version.webSocketDebuggerUrl,
      );
      const browserPid = await findChromePid(existingPort, userDataDir);
      return { browser, debugPort: existingPort, browserPid, reused: true };
    }
  }

  const debugPort = options.debugPort ?? (await getFreePort());
  const args: string[] = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "--window-position=-32000,-32000",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-breakpad",
  ];
  if (options.profileDir) {
    args.push(`--profile-directory=${options.profileDir}`);
  }
  if (options.allowVisible) {
    args.push("--window-position=0,0");
  }

  const openArgs = ["-n", "-g", "-a", appName, "--args", ...args];
  options.logger?.(`[chrome] launch: open ${openArgs.join(" ")}`);
  spawn("open", openArgs, { stdio: "ignore", detached: true }).unref();

  try {
    await waitForDebugEndpoint(debugPort, options.logger);
  } catch (error) {
    const fallbackPort = await findExistingChromePort(userDataDir);
    if (fallbackPort && fallbackPort !== debugPort) {
      await waitForDebugEndpoint(fallbackPort, options.logger);
      const version = await fetchJson(
        `http://127.0.0.1:${fallbackPort}/json/version`,
      );
      const browser = await chromium.connectOverCDP(
        version.webSocketDebuggerUrl,
      );
      const browserPid = await findChromePid(fallbackPort, userDataDir);
      return { browser, debugPort: fallbackPort, browserPid, reused: true };
    }
    throw error;
  }
  const version = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome debug endpoint missing webSocketDebuggerUrl");
  }

  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
  const browserPid = await findChromePid(debugPort, userDataDir);
  return { browser, debugPort, browserPid, reused: false };
}

export async function createHiddenPage(
  browser: Browser,
  token: string,
  options: { allowVisible?: boolean; logger?: Logger } = {},
): Promise<Page> {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  let page: Page | null =
    context.pages().find((candidate) => candidate.url().startsWith("https://")) ??
    context.pages()[0] ??
    null;
  if (page && page.isClosed()) {
    page = null;
  }
  if (!page) {
    page = await context.newPage();
    const url = `data:text/html,oracle-${token}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch {
      // ignore data url failures
    }
  }
  if (!options.allowVisible) {
    const preferredWindowId = await getWindowIdForPage(page, options.logger);
    await ensureChromeWindowHidden(browser, options.logger, preferredWindowId);
  }
  return page;
}

async function hideChromeWindowForPage(
  page: Page,
  logger?: Logger,
): Promise<void> {
  let lastError: unknown;
  const start = Date.now();
  const timeoutMs = 2_000;
  while (Date.now() - start < timeoutMs) {
    try {
      const client = await page.context().newCDPSession(page);
      const { windowId } = await client.send("Browser.getWindowForTarget");
      const current = await client
        .send("Browser.getWindowBounds", { windowId })
        .catch(() => null);
      if (current?.bounds?.windowState === "minimized") {
        await client.detach().catch(() => null);
        return;
      }
      try {
        await client.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "minimized" },
        });
      } catch (error) {
        logger?.(`[chrome] minimize failed: ${String(error)}`);
      }
      const after = await client
        .send("Browser.getWindowBounds", { windowId })
        .catch(() => null);
      if (after?.bounds?.windowState !== "minimized") {
        await client.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            left: -32000,
            top: -32000,
            width: 800,
            height: 600,
          },
        });
        await client.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "minimized" },
        });
      }
      await client.detach().catch(() => null);
      return;
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  if (lastError) {
    logger?.(`[chrome] hide window failed: ${String(lastError)}`);
  }
}

async function ensureChromeWindowHidden(
  browser: Browser,
  logger?: Logger,
  preferredWindowId?: number,
): Promise<void> {
  let cdp: import("playwright").CDPSession | null = null;
  try {
    cdp = await browser.newBrowserCDPSession();
    const targets = await cdp.send("Target.getTargets");
    const pageTargets = (targets?.targetInfos ?? []).filter(
      (target: { type?: string }) => target.type === "page",
    );
    if (pageTargets.length === 0) {
      logger?.("[chrome] no page targets available to derive window");
      return;
    }
    const windowToTargets = new Map<number, string[]>();
    for (const target of pageTargets) {
      const windowInfo = await cdp.send("Browser.getWindowForTarget", {
        targetId: target.targetId,
      });
      if (!windowInfo?.windowId) continue;
      const list = windowToTargets.get(windowInfo.windowId) ?? [];
      list.push(target.targetId);
      windowToTargets.set(windowInfo.windowId, list);
    }
    const windowIds = Array.from(windowToTargets.keys());
    if (windowIds.length === 0) {
      logger?.("[chrome] no windowIds resolved from targets");
      return;
    }
    const primaryWindowId =
      preferredWindowId && windowToTargets.has(preferredWindowId)
        ? preferredWindowId
        : windowIds[0];
    if (windowIds.length > 1) {
      logger?.(
        `[chrome] multiple windows detected (${windowIds.join(",")}); closing extras (keeping ${primaryWindowId})`,
      );
      for (const [windowId, targetsForWindow] of windowToTargets.entries()) {
        if (windowId === primaryWindowId) continue;
        for (const targetId of targetsForWindow) {
          await cdp.send("Target.closeTarget", { targetId }).catch(() => null);
        }
      }
    }
    await hideChromeWindowById(cdp, primaryWindowId, logger);
  } catch (error) {
    logger?.(`[chrome] ensure hidden window failed: ${String(error)}`);
  } finally {
    if (cdp) {
      await cdp.detach().catch(() => null);
    }
  }
}

async function getWindowIdForPage(
  page: Page,
  logger?: Logger,
): Promise<number | undefined> {
  try {
    const client = await page.context().newCDPSession(page);
    const info = await client.send("Target.getTargetInfo");
    const targetId = info?.targetInfo?.targetId;
    if (!targetId) {
      await client.detach().catch(() => null);
      return undefined;
    }
    const windowInfo = await client.send("Browser.getWindowForTarget", {
      targetId,
    });
    await client.detach().catch(() => null);
    if (windowInfo?.windowId) {
      return windowInfo.windowId as number;
    }
  } catch (error) {
    logger?.(`[chrome] windowId lookup failed: ${String(error)}`);
  }
  return undefined;
}

async function hideChromeWindowById(
  cdp: import("playwright").CDPSession,
  windowId: number,
  logger?: Logger,
): Promise<void> {
  const bounds = await cdp
    .send("Browser.getWindowBounds", { windowId })
    .catch(() => null);
  if (bounds?.bounds) {
    logger?.(
      `[chrome] window ${windowId} bounds state=${bounds.bounds.windowState ?? "unknown"} left=${bounds.bounds.left ?? "?"} top=${bounds.bounds.top ?? "?"} width=${bounds.bounds.width ?? "?"} height=${bounds.bounds.height ?? "?"}`,
    );
  }
  const isMinimized = bounds?.bounds?.windowState === "minimized";
  const left = bounds?.bounds?.left ?? 0;
  const top = bounds?.bounds?.top ?? 0;
  const offscreen = left <= -2000 && top <= -2000;
  if (!offscreen) {
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left: -32000, top: -32000, width: 800, height: 600 },
    });
  }
  if (!isMinimized) {
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
  }
  const after = await cdp
    .send("Browser.getWindowBounds", { windowId })
    .catch(() => null);
  if (after?.bounds) {
    logger?.(
      `[chrome] window ${windowId} hidden state=${after.bounds.windowState ?? "unknown"} left=${after.bounds.left ?? "?"} top=${after.bounds.top ?? "?"} width=${after.bounds.width ?? "?"} height=${after.bounds.height ?? "?"}`,
    );
  }
}

async function waitForDebugEndpoint(
  port: number,
  logger?: Logger,
): Promise<void> {
  const start = Date.now();
  const timeoutMs = 15_000;
  while (Date.now() - start < timeoutMs) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`, 1_000);
      return;
    } catch (error) {
      logger?.(`[chrome] debug endpoint not ready: ${String(error)}`);
      await sleep(250);
    }
  }
  throw new Error("Chrome debug endpoint failed to start");
}

async function fetchJson(url: string, timeoutMs = 2_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require("net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function findChromePid(
  debugPort: number,
  userDataDir: string,
): Promise<number | undefined> {
  const { execFile } = await import("child_process");
  const args = ["-ax", "-o", "pid=,command="];
  const output = await new Promise<string>((resolve) => {
    execFile("ps", args, (err, stdout) => {
      if (err) return resolve("");
      resolve(stdout);
    });
  });
  const lines = output.split(/\n/);
  for (const line of lines) {
    if (!line.includes(`--remote-debugging-port=${debugPort}`)) continue;
    if (!line.includes(`--user-data-dir=${userDataDir}`)) continue;
    const match = line.trim().match(/^(\d+)\s+/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

async function findExistingChromePort(
  userDataDir: string,
): Promise<number | null> {
  const { execFile } = await import("child_process");
  const args = ["-ax", "-o", "command="];
  const output = await new Promise<string>((resolve) => {
    execFile("ps", args, (err, stdout) => {
      if (err) return resolve("");
      resolve(stdout);
    });
  });
  const lines = output.split(/\n/);
  for (const line of lines) {
    if (!line.includes(`--user-data-dir=${userDataDir}`)) continue;
    const match = line.match(/--remote-debugging-port=(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

export function buildChromeProfileDir(profileDir?: string): string | undefined {
  if (!profileDir) return undefined;
  return profileDir;
}

export function chromeProfilePath(
  userDataDir: string,
  profileDir?: string,
): string {
  return profileDir ? path.join(userDataDir, profileDir) : userDataDir;
}
