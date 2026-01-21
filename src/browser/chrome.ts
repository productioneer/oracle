import fs from "fs";
import { spawn } from "child_process";
import http from "http";
import path from "path";
import type { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer";
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
      const browser = await puppeteer.connect({
        browserWSEndpoint: version.webSocketDebuggerUrl,
      });
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
  } else {
    args.push("--no-startup-window", "--start-minimized");
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
      const browser = await puppeteer.connect({
        browserWSEndpoint: version.webSocketDebuggerUrl,
      });
      const browserPid = await findChromePid(fallbackPort, userDataDir);
      return { browser, debugPort: fallbackPort, browserPid, reused: true };
    }
    throw error;
  }
  const version = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome debug endpoint missing webSocketDebuggerUrl");
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: version.webSocketDebuggerUrl,
  });
  const browserPid = await findChromePid(debugPort, userDataDir);
  return { browser, debugPort, browserPid, reused: false };
}

export async function createHiddenPage(
  browser: Browser,
  token: string,
  options: { allowVisible?: boolean; logger?: Logger } = {},
): Promise<import("puppeteer").Page> {
  const browserTarget =
    browser.targets().find((t) => t.type() === "browser") ??
    browser.targets()[0];
  if (!browserTarget) {
    throw new Error("No browser target available for CDP");
  }
  const client = await browserTarget.createCDPSession();
  const url = `data:text/html,oracle-${token}`;
  let targetId: string;
  try {
    const result = await client.send(
      "Target.createTarget" as any,
      {
        url,
        background: true,
        hidden: true,
      } as any,
    );
    targetId = result.targetId;
  } catch (error) {
    // Fallback when hidden targets are unsupported.
    const result = await client.send("Target.createTarget", {
      url,
      background: true,
    });
    targetId = result.targetId;
  }
  const target =
    (await browser
      .waitForTarget((t) => (t as any)._targetId === targetId, {
        timeout: 10_000,
      })
      .catch(() => null)) ??
    (await browser
      .waitForTarget((t) => t.url() === url, { timeout: 10_000 })
      .catch(() => null));
  const page = await target?.page();
  if (page) {
    if (!options.allowVisible) {
      await hideChromeWindowForPage(page, options.logger);
    }
    return page;
  }

  // Fallback: create a normal page if hidden target cannot be attached.
  const fallback = await browser.newPage();
  if (!options.allowVisible) {
    await hideChromeWindowForPage(fallback, options.logger);
  }
  return fallback;
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
      const client = await page.target().createCDPSession();
      const { windowId } = await client.send("Browser.getWindowForTarget");
      await client.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: -32000,
          top: -32000,
          width: 800,
          height: 600,
          windowState: "normal",
        },
      });
      await client.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
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
