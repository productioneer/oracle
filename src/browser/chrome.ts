import fs from "fs";
import { spawn, execFile } from "child_process";
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

const MIN_WINDOW_WIDTH = 1280;
const MIN_WINDOW_HEIGHT = 800;

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
    "--disable-session-crashed-bubble",
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
  options: {
    allowVisible?: boolean;
    browserPid?: number;
    userDataDir?: string;
    logger?: Logger;
  } = {},
): Promise<Page> {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  // Only reuse HTTPS pages (real ChatGPT sessions with active login state).
  // Never reuse local/data pages — they may belong to other concurrent workers.
  let page: Page | null =
    context
      .pages()
      .find(
        (candidate) =>
          !candidate.isClosed() && candidate.url().startsWith("https://"),
      ) ?? null;
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
    // On macOS, also hide via AppleScript. CDP offscreen positioning is
    // unreliable because macOS clamps window coordinates. Window-level
    // visibility (`visible = false`) makes the window truly invisible while
    // keeping the renderer active (unlike minimize which suspends it).
    //
    // We use Chrome's AppleScript dictionary to target specific windows by
    // their offscreen position (x < 0), which ensures we only hide Oracle's
    // window — not the user's personal Chrome windows.
    if (process.platform === "darwin") {
      // Small delay to ensure CDP position change is reflected in AppleScript
      await sleep(200);
      await hideChromeMacOffscreen(options.logger);
    }
  }
  return page;
}

// hideChromeWindowForPage removed — was dead code (never called).
// Window hiding is handled by ensureChromeWindowHidden → hideChromeWindowById.

/**
 * Hide Chrome windows that are positioned offscreen via macOS AppleScript.
 * Uses Chrome's own AppleScript dictionary to set `visible` on specific windows,
 * which only affects the targeted window — not other Chrome instances.
 *
 * This identifies Oracle's window by its offscreen position (x < 0), which is set
 * by CDP before this function runs. This approach doesn't require knowing the URL.
 *
 * This replaces the old System Events approach (`set visible of process`) which
 * affected ALL Chrome instances due to macOS treating them as one application.
 */
async function hideChromeMacOffscreen(logger?: Logger): Promise<void> {
  const script = [
    'tell application "Google Chrome"',
    "set hiddenCount to 0",
    "repeat with w in windows",
    "try",
    "set b to bounds of w",
    "if (item 1 of b) < 0 then",
    "set visible of w to false",
    "set hiddenCount to hiddenCount + 1",
    "end if",
    "end try",
    "end repeat",
    "return hiddenCount",
    "end tell",
  ];
  try {
    const result = await new Promise<{ ok: boolean; stdout: string; error?: string }>((resolve) => {
      execFile(
        "osascript",
        script.flatMap((line) => ["-e", line]),
        { timeout: 3000 },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ ok: false, stdout: stdout ?? "", error: `${error.message}\n${stderr}`.trim() });
          } else {
            resolve({ ok: true, stdout: stdout ?? "" });
          }
        },
      );
    });
    if (result.ok) {
      const hiddenCount = parseInt(result.stdout.trim(), 10) || 0;
      if (hiddenCount > 0) {
        logger?.(`[chrome] hidden ${hiddenCount} offscreen window(s) via AppleScript`);
      } else {
        logger?.("[chrome] no offscreen windows found to hide");
      }
    } else {
      logger?.(`[chrome] AppleScript hide failed: ${result.error}`);
    }
  } catch (error) {
    logger?.(`[chrome] AppleScript hide error: ${String(error)}`);
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
  const width = bounds?.bounds?.width ?? MIN_WINDOW_WIDTH;
  const height = bounds?.bounds?.height ?? MIN_WINDOW_HEIGHT;
  const offscreen = left <= -2000 && top <= -2000;
  const widthTooSmall = width < MIN_WINDOW_WIDTH;
  const heightTooSmall = height < MIN_WINDOW_HEIGHT;
  if (widthTooSmall || heightTooSmall) {
    logger?.(
      `[chrome] window ${windowId} size too small (${width}x${height}); resizing to at least ${MIN_WINDOW_WIDTH}x${MIN_WINDOW_HEIGHT}`,
    );
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left,
        top,
        width: Math.max(width, MIN_WINDOW_WIDTH),
        height: Math.max(height, MIN_WINDOW_HEIGHT),
      },
    });
  }
  if (!offscreen) {
    logger?.(
      `[chrome] window ${windowId} moving offscreen (${MIN_WINDOW_WIDTH}x${MIN_WINDOW_HEIGHT})`,
    );
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: -32000,
        top: -32000,
        width: Math.max(width, MIN_WINDOW_WIDTH),
        height: Math.max(height, MIN_WINDOW_HEIGHT),
      },
    });
  }
  // Do NOT minimize — macOS suspends the renderer for minimized windows,
  // breaking keyboard input (e.g., ProseMirror in ChatGPT). The offscreen
  // position (-32000, -32000) combined with -g launch flag is sufficient
  // to keep the window invisible and prevent focus theft.
  if (isMinimized) {
    // Set offscreen position first (applies to restored geometry), then
    // restore from minimized. This avoids a brief flash at the pre-minimize
    // position when the window comes out of minimized state.
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: -32000,
        top: -32000,
        width: Math.max(width, MIN_WINDOW_WIDTH),
        height: Math.max(height, MIN_WINDOW_HEIGHT),
      },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
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
