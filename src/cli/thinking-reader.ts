import path from "path";
import { launchChrome, createHiddenPage } from "../browser/chrome.js";
import { launchFirefox } from "../browser/firefox.js";
import {
  DEFAULT_BASE_URL,
  ensureChatGptReady,
  ensureWideViewport,
  getThinkingContent,
  navigateToChat,
} from "../browser/chatgpt.js";
import type { RunConfig } from "../run/types.js";
import { sleep } from "../utils/time.js";

export async function readThinkingContent(config: RunConfig): Promise<string> {
  let browser: import("puppeteer").Browser | null = null;
  let page: import("puppeteer").Page | null = null;
  let shouldClose = false;
  try {
    if (config.browser === "chrome") {
      const hadChrome = await isOracleChromeRunning(config.profile.userDataDir);
      const active = config.debugPort
        ? await isChromeDebugPortActive(config.debugPort)
        : false;
      const connection = await launchChrome({
        userDataDir: config.profile.userDataDir,
        profileDir: config.profile.profileDir,
        debugPort: active ? config.debugPort : undefined,
        allowVisible: false,
      });
      browser = connection.browser;
      shouldClose = !hadChrome;
      page = await createHiddenPage(browser, config.runId);
    } else {
      const connection = await launchFirefox({
        profilePath: config.profile.profileDir ?? config.profile.userDataDir,
        allowVisible: false,
        reuse: true,
        executablePath: config.firefoxApp?.executablePath,
        appPath: config.firefoxApp?.appPath,
      });
      browser = connection.browser;
      shouldClose = !connection.keepAlive;
      page = await browser.newPage();
    }

    if (!page) throw new Error("Failed to open browser page");
    await ensureWideViewport(page);
    const targetUrl =
      config.conversationUrl ?? config.baseUrl ?? DEFAULT_BASE_URL;
    await navigateToChat(page, targetUrl);
    await ensureWideViewport(page);
    const ready = await ensureChatGptReady(page);
    if (ready.needsCloudflare) throw new Error("Cloudflare challenge detected");
    if (!ready.loggedIn) throw new Error("Login required");
    await waitForConversationContent(page, 15_000);
    return await getThinkingContent(page);
  } finally {
    if (page) {
      await page.close().catch(() => null);
    }
    if (browser) {
      try {
        if (shouldClose) {
          await browser.close();
        } else {
          await browser.disconnect();
        }
      } catch {
        // ignore
      }
    }
  }
}

async function waitForConversationContent(
  page: import("puppeteer").Page,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hasAssistant = await page.evaluate(() => {
      return (
        document.querySelectorAll('[data-message-author-role=\"assistant\"]')
          .length > 0
      );
    });
    if (hasAssistant) break;
    await sleep(500);
  }
  while (Date.now() - start < timeoutMs) {
    const hasThinkingUI = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll("button, span"),
      ) as HTMLElement[];
      const thoughtEl = elements.find((el) => {
        const text = (el.textContent || "").trim();
        return /^thought for /i.test(text) && text.length < 50;
      });
      if (thoughtEl) return true;
      const sidebars = Array.from(
        document.querySelectorAll(".bg-token-sidebar-surface-primary"),
      ) as HTMLElement[];
      return sidebars.some((s) => {
        if ((s.innerText?.length || 0) < 100) return false;
        const hasYourChats = Array.from(s.querySelectorAll("*")).some(
          (el) => (el.textContent || "").trim().toLowerCase() === "your chats",
        );
        if (hasYourChats) return false;
        return Array.from(s.querySelectorAll("*")).some((el) => {
          const text = (el.textContent || "").trim().toLowerCase();
          return text === "pro thinking" || text === "activity";
        });
      });
    });
    if (hasThinkingUI) return;
    await sleep(500);
  }
}

async function isChromeDebugPortActive(port: number): Promise<boolean> {
  const http = await import("http");
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 400));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function isOracleChromeRunning(userDataDir: string): Promise<boolean> {
  const { execFile } = await import("child_process");
  const normalized = path.resolve(userDataDir);
  const output = await new Promise<string>((resolve) => {
    execFile("ps", ["-ax", "-o", "command="], (err, stdout) => {
      if (err) return resolve("");
      resolve(stdout);
    });
  });
  const lines = output.split(/\n/);
  return lines.some(
    (line) =>
      line.includes("Google Chrome") &&
      line.includes(`--user-data-dir=${normalized}`),
  );
}
