import { launchChrome, createHiddenPage } from "../browser/chrome.js";
import { launchFirefox } from "../browser/firefox.js";
import {
  ensureChatGptReady,
  ensureWideViewport,
  getThinkingContent,
  navigateToChat,
} from "../browser/chatgpt.js";
import type { RunConfig } from "../run/types.js";
import { sleep } from "../utils/time.js";

export async function readThinkingContent(config: RunConfig): Promise<string> {
  let lastError: unknown;
  const devMode = process.env.ORACLE_DEV === "1";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let browser: import("playwright").Browser | null = null;
    let page: import("playwright").Page | null = null;
    let shouldClose = false;
    let firefoxServer: import("playwright").BrowserServer | undefined;
    try {
      if (config.browser === "chrome") {
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
        shouldClose = !connection.reused;
        page = await createHiddenPage(browser, config.runId, {
          allowVisible: false,
        });
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
        firefoxServer = connection.server;
        const context = browser.contexts()[0] ?? (await browser.newContext());
        page = await context.newPage();
      }

      if (!page) throw new Error("Failed to open browser page");
      await ensureWideViewport(page);
      if (!config.conversationUrl) {
        throw new Error(
          `Thinking requires a conversation URL for run ${config.runId}`,
        );
      }
      const targetUrl = config.conversationUrl;
      await navigateToChat(page, targetUrl);
      await ensureWideViewport(page);
      if (!(devMode && isLocalUrl(targetUrl))) {
        const ready = await ensureChatGptReady(page);
        if (!ready.ok) throw new Error(ready.message ?? "ChatGPT not ready");
      }
      await waitForConversationContent(page, 15_000);
      return await getThinkingContent(page);
    } catch (error) {
      lastError = error;
      if (!isRetryableThinkingError(error) || attempt >= 1) {
        throw error;
      }
    } finally {
      if (page) {
        await page.close().catch(() => null);
      }
      if (browser) {
        try {
          if (shouldClose) {
            await browser.close();
            if (firefoxServer) {
              await firefoxServer.close().catch(() => null);
            }
          } else {
            await disconnectBrowser(browser);
          }
        } catch {
          // ignore
        }
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to read thinking content");
}

async function waitForConversationContent(
  page: import("playwright").Page,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hasAssistant = await page.evaluate(() => {
      return (
        document.querySelectorAll('[data-message-author-role="assistant"]')
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
      return elements.some((el) => {
        const text = (el.textContent || "").trim();
        return text === "Pro thinking" || /^pro thinking/i.test(text);
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

function isRetryableThinkingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /detached frame|execution context was destroyed/i.test(message);
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1"
    );
  } catch {
    return false;
  }
}

async function disconnectBrowser(
  browser: import("playwright").Browser,
): Promise<void> {
  const maybeDisconnect = (browser as any).disconnect;
  if (typeof maybeDisconnect === "function") {
    await maybeDisconnect.call(browser);
  } else {
    await browser.close();
  }
}
