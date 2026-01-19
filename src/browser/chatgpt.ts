import type { Page } from "puppeteer";
import { sleep } from "../utils/time.js";

export type ChatGptState = {
  loggedIn: boolean;
  needsCloudflare: boolean;
};

export type WaitForCompletionResult = {
  content: string;
  assistantIndex: number;
  conversationUrl?: string;
};

export type ChatGptOptions = {
  baseUrl: string;
};

export type ThinkingMode = "standard" | "extended";

export class ResponseStalledError extends Error {
  public readonly kind = "stalled";
  constructor(message: string) {
    super(message);
  }
}

export class ResponseFailedError extends Error {
  public readonly kind = "failed";
  constructor(message: string) {
    super(message);
  }
}

export class ResponseTimeoutError extends Error {
  public readonly kind = "timeout";
  constructor(message: string) {
    super(message);
  }
}

export const DEFAULT_BASE_URL = "https://chatgpt.com/";
export const FALLBACK_BASE_URL = "https://chat.openai.com/";

const SELECTORS = {
  promptInput: "#prompt-textarea",
  sendButton: 'button[data-testid="send-button"]',
  actionButtons:
    '[data-testid="good-response-turn-action-button"], [data-testid="bad-response-turn-action-button"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  composerFooter: '[data-testid="composer-footer-actions"]',
  thinkingMenuItem: '[role="menuitemradio"]',
  sourcesHeader: '[data-testid="bar-search-sources-header"]',
};

const MIN_VIEWPORT_WIDTH = 1024;
const WIDE_VIEWPORT = { width: 1280, height: 800 };

const NO_ACTION_AFTER_STOP_POLLS = 2;

export async function navigateToChat(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

export async function ensureChatGptReady(page: Page): Promise<ChatGptState> {
  const needsCloudflare = await detectCloudflare(page);
  if (needsCloudflare) {
    return { loggedIn: false, needsCloudflare: true };
  }
  const loggedIn = !(await detectLogin(page));
  return { loggedIn, needsCloudflare: false };
}

export async function detectLogin(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes("login") || url.includes("auth")) return true;
  const hasEmailInput = await page.$(
    'input[type="email"], input[name="username"]',
  );
  if (hasEmailInput) return true;
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  return /log in|sign in/i.test(bodyText);
}

export async function detectCloudflare(page: Page): Promise<boolean> {
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  return /cloudflare|just a moment|checking your browser/i.test(bodyText);
}

export async function waitForPromptInput(
  page: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const input = await page.$(SELECTORS.promptInput);
    if (input) {
      const canType = await page.evaluate((el) => {
        if (el instanceof HTMLTextAreaElement) return !el.disabled;
        const contentEditable = el.getAttribute("contenteditable");
        const ariaDisabled = el.getAttribute("aria-disabled");
        return contentEditable !== "false" && ariaDisabled !== "true";
      }, input);
      if (canType) return;
    }
    await sleep(500);
  }
  throw new Error("Prompt input not available");
}

export async function setThinkingMode(
  page: Page,
  mode: ThinkingMode,
): Promise<boolean> {
  return page.evaluate(
    (desired, selectors) => {
      const footer = document.querySelector(selectors.composerFooter);
      if (!footer) return false;
      const buttons = Array.from(
        footer.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      const toggle = buttons.find((button) =>
        /pro|extended thinking/i.test(button.innerText || ""),
      );
      if (!toggle) return false;
      const label = (toggle.innerText || "").toLowerCase();
      const isExtended = label.includes("extended");
      if (
        (desired === "extended" && isExtended) ||
        (desired === "standard" && !isExtended)
      )
        return true;
      toggle.click();
      const items = Array.from(
        document.querySelectorAll(selectors.thinkingMenuItem),
      ) as HTMLElement[];
      const needle = desired === "extended" ? /extended/i : /standard/i;
      const target = items.find((item) => needle.test(item.innerText || ""));
      if (!target) return false;
      target.click();
      return true;
    },
    mode,
    SELECTORS,
  );
}

export async function submitPrompt(
  page: Page,
  prompt: string,
): Promise<string> {
  const input = await page.$(SELECTORS.promptInput);
  if (!input) throw new Error("Prompt input not found");
  const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
  await input.evaluate((el) => (el as HTMLElement).focus());
  if (tagName === "textarea") {
    await input.evaluate((el) => {
      (el as HTMLTextAreaElement).value = "";
    });
    await input.type(prompt, { delay: 5 });
    await input.evaluate((el, value) => {
      (el as HTMLTextAreaElement).value = value as string;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, prompt);
  } else {
    await input.evaluate((el) => {
      (el as HTMLElement).textContent = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await input.type(prompt, { delay: 5 });
  }
  const typedValue = await input.evaluate((el) => {
    if (el instanceof HTMLTextAreaElement) return el.value;
    return (el as HTMLElement).innerText ?? "";
  });
  const clicked = await clickSendIfPresent(page);
  if (!clicked) {
    await page.keyboard.press("Enter");
  }
  return typedValue;
}

export async function waitForUserMessage(
  page: Page,
  prompt: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const start = Date.now();
  const needle = prompt.trim();
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate((text) => {
      const nodes = Array.from(
        document.querySelectorAll('[data-message-author-role="user"]'),
      ) as HTMLElement[];
      if (nodes.length) {
        return nodes.some((node) => (node.innerText || "").trim() === text);
      }
      const main =
        (document.querySelector("main") as HTMLElement | null) ??
        (document.querySelector('[role="main"]') as HTMLElement | null);
      const haystack = (
        main?.innerText ??
        document.body?.innerText ??
        ""
      ).trim();
      return haystack.includes(text);
    }, needle);
    if (found) return true;
    await sleep(300);
  }
  return false;
}

async function clickSendIfPresent(page: Page): Promise<boolean> {
  return page.evaluate((selectors) => {
    const button = document.querySelector(
      selectors.sendButton,
    ) as HTMLButtonElement | null;
    if (button && !button.disabled) {
      button.click();
      return true;
    }
    return false;
  }, SELECTORS);
}

export async function waitForCompletion(
  page: Page,
  options: {
    timeoutMs: number;
    pollMs: number;
    prompt?: string;
  },
): Promise<WaitForCompletionResult> {
  const start = Date.now();
  let lastText = "";
  let lastIndex = -1;
  let seenStop = false;
  let seenAssistant = false;
  let noActionAfterStop = 0;

  while (Date.now() - start < options.timeoutMs) {
    const snapshot = await getCompletionSnapshot(page);
    if (snapshot.innerWidth > 0 && snapshot.innerWidth < MIN_VIEWPORT_WIDTH) {
      await ensureWideViewport(page);
    }
    const {
      lastAssistantText,
      lastAssistantIndex,
      actionVisible,
      stopVisible,
    } = snapshot;

    if (
      lastAssistantText &&
      (lastAssistantText !== lastText || lastAssistantIndex !== lastIndex)
    ) {
      lastText = lastAssistantText;
      lastIndex = lastAssistantIndex;
      seenAssistant = true;
    }

    if (actionVisible && lastText) {
      return {
        content: lastAssistantText || lastText,
        assistantIndex: lastAssistantIndex ?? lastIndex,
        conversationUrl: page.url(),
      };
    }

    if (stopVisible) {
      seenStop = true;
      noActionAfterStop = 0;
    } else if (seenStop && !actionVisible) {
      noActionAfterStop += 1;
      if (noActionAfterStop >= NO_ACTION_AFTER_STOP_POLLS && seenAssistant) {
        throw new ResponseFailedError("Response failed or canceled");
      }
    }

    await sleep(options.pollMs);
  }

  const snapshot = await getCompletionSnapshot(page);
  if (snapshot.actionVisible && snapshot.lastAssistantText) {
    return {
      content: snapshot.lastAssistantText,
      assistantIndex: snapshot.lastAssistantIndex,
      conversationUrl: page.url(),
    };
  }
  if (snapshot.stopVisible) {
    throw new ResponseStalledError("Response stalled with stop button visible");
  }
  if (seenStop || seenAssistant) {
    throw new ResponseFailedError("Response failed or canceled");
  }
  throw new ResponseTimeoutError("Timed out waiting for completion");
}

export async function isGenerating(page: Page): Promise<boolean> {
  const snapshot = await getCompletionSnapshot(page);
  return snapshot.stopVisible;
}

export async function isResponseComplete(page: Page): Promise<boolean> {
  const snapshot = await getCompletionSnapshot(page);
  return snapshot.actionVisible;
}

export async function getLastAssistantMessage(
  page: Page,
): Promise<{ text: string; index: number }> {
  return page.evaluate((selectors) => {
    const nodes = Array.from(
      document.querySelectorAll(selectors.assistantMessage),
    ) as HTMLElement[];
    if (nodes.length === 0) return { text: "", index: -1 };
    const last = nodes[nodes.length - 1];
    return { text: last?.innerText ?? "", index: nodes.length - 1 };
  }, SELECTORS);
}

export async function getThinkingContent(page: Page): Promise<string> {
  // Helper to find thinking sidebar (not chat history)
  const findThinkingSidebar = () => {
    return page.evaluate(() => {
      const sidebars = Array.from(
        document.querySelectorAll(".bg-token-sidebar-surface-primary"),
      ) as HTMLElement[];
      const found = sidebars.find((s) => {
        if ((s.innerText?.length || 0) < 50) return false;
        // Exclude chat history sidebar (has "Your chats" label)
        const hasYourChats = Array.from(s.querySelectorAll("*")).some(
          (el) => (el.textContent || "").trim().toLowerCase() === "your chats",
        );
        if (hasYourChats) return false;
        // Must have thinking labels
        const hasThinkingLabel = Array.from(s.querySelectorAll("*")).some(
          (el) => {
            const text = (el.textContent || "").trim().toLowerCase();
            return text === "pro thinking" || text === "activity";
          },
        );
        return hasThinkingLabel;
      });
      return found?.innerText?.trim() || null;
    });
  };

  // Check if sidebar is already open
  let content = await findThinkingSidebar();
  if (content) return content;

  // Try clicking the "Thought for" header to open sidebar
  const clicked = await page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll("span, button"),
    ) as HTMLElement[];
    const headers = elements.filter((el) => {
      const text = (el.textContent || "").trim();
      // Must be short (< 50 chars) to avoid hitting transcript text
      return /^thought for /i.test(text) && text.length < 50;
    });
    const header = headers.length ? headers[headers.length - 1] : null;
    if (header) {
      header.click();
      return true;
    }
    return false;
  });

  if (clicked) {
    // Wait for sidebar to appear after click
    await new Promise((r) => setTimeout(r, 500));
    content = await findThinkingSidebar();
    if (content) return content;
  }

  // Fallback: look for Pro thinking and sources sections in main content
  return page.evaluate((selectors) => {
    const sections: string[] = [];

    const proThinking = findProThinking();
    if (proThinking) {
      const container =
        proThinking.closest("section") ?? proThinking.parentElement;
      const text =
        container?.innerText?.trim() || proThinking.innerText?.trim() || "";
      if (text) sections.push(text);
    }

    const sourcesHeader = document.querySelector(
      selectors.sourcesHeader,
    ) as HTMLElement | null;
    if (sourcesHeader) {
      const container =
        sourcesHeader.closest("section") ?? sourcesHeader.parentElement;
      const text =
        container?.innerText?.trim() || sourcesHeader.innerText?.trim() || "";
      if (text) sections.push(text);
    }

    return sections.join("\n\n").trim();

    function findProThinking(): HTMLElement | null {
      const elements = Array.from(
        document.querySelectorAll("div, span, p"),
      ) as HTMLElement[];
      return (
        elements.find((el) => {
          const text = (el.textContent || "").trim();
          if (text === "Pro thinking") return true;
          if (text.length < 200 && /^pro thinking/i.test(text)) return true;
          return false;
        }) ?? null
      );
    }
  }, SELECTORS);
}

export async function ensureWideViewport(page: Page): Promise<void> {
  try {
    const current = await page.evaluate(() => window.innerWidth);
    // Only set viewport if below minimum - don't shrink an already-wide window
    if (current < MIN_VIEWPORT_WIDTH) {
      await page.setViewport(WIDE_VIEWPORT);
    }
  } catch {
    // ignore
  }
}

async function getCompletionSnapshot(page: Page): Promise<{
  actionVisible: boolean;
  stopVisible: boolean;
  lastAssistantText: string;
  lastAssistantIndex: number;
  innerWidth: number;
}> {
  return page.evaluate((selectors) => {
    const actionButton = document.querySelector(
      selectors.actionButtons,
    ) as HTMLElement | null;
    const actionVisible = actionButton ? isVisible(actionButton) : false;

    const buttons = Array.from(
      document.querySelectorAll("button"),
    ) as HTMLButtonElement[];
    const stopVisible = buttons.some((button) => {
      if (!isVisible(button)) return false;
      const label = (button.getAttribute("aria-label") || "").toLowerCase();
      const text = (button.innerText || "").toLowerCase();
      return (
        label.includes("stop") ||
        text.includes("stop") ||
        label.includes("update") ||
        text.includes("update")
      );
    });

    const nodes = Array.from(
      document.querySelectorAll(selectors.assistantMessage),
    ) as HTMLElement[];
    const last = nodes[nodes.length - 1];
    return {
      actionVisible,
      stopVisible,
      lastAssistantText: last?.innerText ?? "",
      lastAssistantIndex: nodes.length ? nodes.length - 1 : -1,
      innerWidth: window.innerWidth,
    };

    function isVisible(el: HTMLElement): boolean {
      const style = window.getComputedStyle(el);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    }
  }, SELECTORS);
}
