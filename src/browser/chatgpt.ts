import type { Page } from "playwright";
import { sleep } from "../utils/time.js";

export type ChatGptState = {
  ok: boolean;
  reason?: "cloudflare" | "login";
  message?: string;
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

const SELECTORS = {
  promptInputPrimary: "#prompt-textarea",
  promptInputSecondary: '.ProseMirror, [contenteditable="true"]',
  sendButtonPrimary: 'button[data-testid="send-button"]',
  sendButtonSecondary: 'button[aria-label*="Send"]',
  copyButtonPrimary: '[data-testid="copy-turn-action-button"]',
  copyButtonSecondary: 'button[aria-label="Copy"]',
  assistantMessage: '[data-message-author-role="assistant"]',
  userMessage: '[data-message-author-role="user"]',
  modelSwitcherPrimary: '[data-testid="model-switcher-dropdown-button"]',
  modelSwitcherSecondary: 'button[aria-label*="Model selector"]',
  modelOptionPro: '[data-testid="model-switcher-gpt-5-2-pro"]',
  newChatPrimary: '[data-testid="create-new-chat-button"]',
  newChatSecondary: 'a[href="/"]',
  composerFooter: '[data-testid="composer-footer-actions"]',
  thinkingTriggerExtended: 'button[aria-label*="Extended thinking"]',
  thinkingTriggerStandard: 'button[aria-label*="Pro"]',
  thinkingMenuItem: '[role="menuitemradio"]',
  sourcesHeader: '[data-testid="bar-search-sources-header"]',
  sidebarClose: '[data-testid="close-button"]',
  threadBottom: "#thread-bottom-container",
};

const MIN_VIEWPORT_WIDTH = 1024;
const WIDE_VIEWPORT = { width: 1280, height: 800 };
const RESPONSE_STABILITY_MS = 2000;
const THINKING_PANEL_INITIAL_WAIT_MS = 15_000;
const THINKING_PANEL_RETRY_WAIT_MS = 10_000;

const loggedSelectorMismatches = new Set<string>();

type SelectorPair = {
  name: string;
  primary: string;
  secondary?: string;
};

type SelectorMatch = {
  selector: string | null;
  mismatch: boolean;
  primaryFound: boolean;
  secondaryFound: boolean;
  primaryCount: number;
  secondaryCount: number;
};

const SELECTOR_PAIRS = {
  promptInput: {
    name: "promptInput",
    primary: SELECTORS.promptInputPrimary,
    secondary: SELECTORS.promptInputSecondary,
  },
  sendButton: {
    name: "sendButton",
    primary: SELECTORS.sendButtonPrimary,
    secondary: SELECTORS.sendButtonSecondary,
  },
  copyButton: {
    name: "copyButton",
    primary: SELECTORS.copyButtonPrimary,
    secondary: SELECTORS.copyButtonSecondary,
  },
  modelSwitcher: {
    name: "modelSwitcher",
    primary: SELECTORS.modelSwitcherPrimary,
    secondary: SELECTORS.modelSwitcherSecondary,
  },
  newChat: {
    name: "newChat",
    primary: SELECTORS.newChatPrimary,
    secondary: SELECTORS.newChatSecondary,
  },
} satisfies Record<string, SelectorPair>;

export async function navigateToChat(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

export async function ensureChatGptReady(
  page: Page,
  logger?: (message: string) => void,
): Promise<ChatGptState> {
  const needsCloudflare = await detectCloudflare(page);
  const hasModelSwitcher = await selectorExists(
    page,
    SELECTOR_PAIRS.modelSwitcher,
    logger,
    { timeoutMs: 15_000 },
  );
  const hasNewChat = await selectorExists(
    page,
    SELECTOR_PAIRS.newChat,
    logger,
    {
      timeoutMs: 15_000,
    },
  );

  if (hasModelSwitcher && hasNewChat) {
    logDebug(logger, "preflight ok (model switcher + new chat present)");
    return { ok: true };
  }

  const message = needsCloudflare
    ? "Cloudflare challenge detected. Complete the check in the browser and retry."
    : "Login required or session not ready. Ensure ChatGPT is logged in for the automation profile.";

  logDebug(
    logger,
    `preflight failed (modelSwitcher=${hasModelSwitcher}, newChat=${hasNewChat}, cloudflare=${needsCloudflare})`,
  );
  return {
    ok: false,
    reason: needsCloudflare ? "cloudflare" : "login",
    message,
  };
}

export async function detectCloudflare(page: Page): Promise<boolean> {
  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  return /cloudflare|just a moment|checking your browser/i.test(bodyText);
}

export async function waitForPromptInput(
  page: Page,
  timeoutMs = 30_000,
  logger?: (message: string) => void,
): Promise<void> {
  const selector = await waitForSelectorPair(
    page,
    SELECTOR_PAIRS.promptInput,
    logger,
    {
      timeoutMs,
      state: "attached",
    },
  );
  logDebug(logger, `prompt input selector resolved: ${selector}`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const canType = await page
      .evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        if (el instanceof HTMLTextAreaElement) return !el.disabled;
        const contentEditable = el.getAttribute("contenteditable");
        const ariaDisabled = el.getAttribute("aria-disabled");
        return contentEditable !== "false" && ariaDisabled !== "true";
      }, selector)
      .catch(() => false);
    if (canType) return;
    await sleep(500);
  }
  throw new Error("Prompt input not available");
}

export async function waitForIdle(
  page: Page,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const generating = await isGenerating(page);
    if (!generating) return;
    await sleep(pollMs);
  }
  throw new ResponseStalledError(
    "Timed out waiting for previous response to finish",
  );
}

export async function ensureModelSelected(
  page: Page,
  logger?: (message: string) => void,
): Promise<void> {
  const headerText = await page
    .evaluate(() => {
      const span = document.querySelector(
        "#page-header span",
      ) as HTMLElement | null;
      return span?.innerText ?? "";
    })
    .catch(() => "");
  if (/5\.2\s*pro/i.test(headerText)) {
    logDebug(logger, "model already 5.2 Pro");
    return;
  }

  const selector = await waitForSelectorPair(
    page,
    SELECTOR_PAIRS.modelSwitcher,
    logger,
    {
      timeoutMs: 15_000,
      state: "visible",
    },
  );
  logDebug(logger, `opening model dropdown via ${selector}`);
  await page.locator(selector).click();
  try {
    await page
      .locator(SELECTORS.modelOptionPro)
      .waitFor({ state: "visible", timeout: 15_000 });
  } catch (error) {
    throw new Error(
      "5.2 Pro model option not available. Verify account access and try again.",
    );
  }
  logDebug(logger, "selecting model 5.2 Pro");
  await page.locator(SELECTORS.modelOptionPro).click();
  await page.waitForFunction(
    () => {
      const span = document.querySelector(
        "#page-header span",
      ) as HTMLElement | null;
      return (span?.innerText ?? "").includes("5.2 Pro");
    },
    undefined,
    { timeout: 15_000 },
  );
  logDebug(logger, "model verified as 5.2 Pro");
}

export async function setThinkingMode(
  page: Page,
  mode: ThinkingMode,
): Promise<boolean> {
  return page.evaluate(
    ({
      desired,
      selectors,
    }: {
      desired: ThinkingMode;
      selectors: typeof SELECTORS;
    }) => {
      const footer = document.querySelector(selectors.composerFooter);
      if (!footer) return false;
      const toggle = footer.querySelector(
        desired === "extended"
          ? selectors.thinkingTriggerStandard
          : selectors.thinkingTriggerExtended,
      ) as HTMLButtonElement | null;
      if (!toggle) {
        const already = footer.querySelector(
          desired === "extended"
            ? selectors.thinkingTriggerExtended
            : selectors.thinkingTriggerStandard,
        );
        return Boolean(already);
      }
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
    {
      desired: mode,
      selectors: SELECTORS,
    },
  );
}

/**
 * Paste text into ChatGPT's ProseMirror editor via a synthetic ClipboardEvent.
 * Much faster than character-by-character typing, especially for long prompts
 * (e.g. inlined file content). Falls back to character-by-character Shift+Enter
 * typing if the paste doesn't produce the expected result.
 */
async function typeIntoEditor(page: Page, text: string): Promise<void> {
  const trimmed = text.replace(/\n+$/, "");

  // Paste via synthetic ClipboardEvent — instant regardless of text length.
  // ProseMirror calls preventDefault() on paste (returning false from
  // dispatchEvent), so we can't use the return value as a success indicator.
  // The caller (submitPrompt) does a readback check and retries if needed.
  await page.evaluate((content: string) => {
    const el = document.activeElement;
    if (!el) return;
    const dt = new DataTransfer();
    dt.setData("text/plain", content);
    const event = new ClipboardEvent("paste", {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
  }, trimmed);
}

/**
 * Type text into ChatGPT's ProseMirror editor character-by-character.
 * Newlines are typed as Shift+Enter (creates line break) instead of Enter
 * (which ProseMirror maps to "submit message"). Trailing newlines are trimmed.
 * Slower than paste but more reliable as a fallback.
 */
async function typeIntoEditorKeyboard(
  page: Page,
  text: string,
  delay = 30,
): Promise<void> {
  const trimmed = text.replace(/\n+$/, "");
  const lines = trimmed.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]) {
      await page.keyboard.type(lines[i], { delay });
    }
    if (i < lines.length - 1) {
      await page.keyboard.press("Shift+Enter");
    }
  }
}

export async function submitPrompt(
  page: Page,
  prompt: string,
  logger?: (message: string) => void,
): Promise<string> {
  await waitForPromptInput(page, 30_000, logger);
  const normalizedPrompt = prompt.replace(/\r\n/g, "\n");
  const preparedPrompt = normalizedPrompt.replace(/\t/g, "  ");
  const selector = await waitForSelectorPair(
    page,
    SELECTOR_PAIRS.promptInput,
    logger,
    {
      timeoutMs: 30_000,
      state: "visible",
    },
  );
  const input = page.locator(selector);

  const clearInput = async () => {
    await input.click();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+A`);
    await page.keyboard.press("Backspace");
  };

  const readInputValue = async () =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return "";
      if (el instanceof HTMLTextAreaElement) return el.value;
      return (el as HTMLElement).innerText || "";
    }, selector);

  const expectedNormalized = normalizeTextForCompare(preparedPrompt);
  let typedValue = "";
  let typedNormalized = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    logDebug(
      logger,
      `typing prompt attempt ${attempt + 1}${attempt > 0 ? " (keyboard fallback)" : " (paste)"}`,
    );
    await clearInput();
    await input.click();
    if (attempt === 0) {
      await typeIntoEditor(page, preparedPrompt);
    } else {
      await typeIntoEditorKeyboard(page, preparedPrompt);
    }
    await sleep(50);
    typedValue = await readInputValue();
    typedNormalized = normalizeTextForCompare(typedValue);
    if (typedNormalized === expectedNormalized) {
      break;
    }
  }

  if (typedNormalized !== expectedNormalized) {
    logDebug(
      logger,
      `prompt mismatch (expectedLen=${preparedPrompt.length}, typedLen=${typedValue.length}, expectedNormLen=${expectedNormalized.length}, typedNormLen=${typedNormalized.length})`,
    );
    throw new Error("Prompt entry mismatch after typing");
  }

  logDebug(logger, "prompt typed successfully; clicking send");
  await clickSendButton(page, logger);
  return typedValue;
}

export async function readPromptInputValue(
  page: Page,
  logger?: (message: string) => void,
): Promise<{ value: string; found: boolean }> {
  const resolved = await resolveSelectorPair(
    page,
    SELECTOR_PAIRS.promptInput,
    logger,
  );
  if (!resolved.selector) {
    logDebug(logger, "prompt input selector not found for read");
    return { value: "", found: false };
  }
  logDebug(
    logger,
    `prompt input resolve -> ${resolved.selector} (primaryCount=${resolved.primaryCount}, secondaryCount=${resolved.secondaryCount})`,
  );
  const value = await page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return "";
      if (el instanceof HTMLTextAreaElement) return el.value;
      return (el as HTMLElement).innerText || "";
    }, resolved.selector)
    .catch(() => "");
  return { value, found: true };
}

export async function getSendButtonState(
  page: Page,
  logger?: (message: string) => void,
): Promise<{ found: boolean; enabled: boolean }> {
  const resolved = await resolveSelectorPair(
    page,
    SELECTOR_PAIRS.sendButton,
    logger,
  );
  if (!resolved.selector) {
    logDebug(logger, "send button selector not found");
    return { found: false, enabled: false };
  }
  logDebug(
    logger,
    `send button resolve -> ${resolved.selector} (primaryCount=${resolved.primaryCount}, secondaryCount=${resolved.secondaryCount})`,
  );
  const result = await page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false, enabled: false };
      if (el instanceof HTMLButtonElement) {
        return { found: true, enabled: !el.disabled };
      }
      const ariaDisabled = el.getAttribute("aria-disabled");
      return { found: true, enabled: ariaDisabled !== "true" };
    }, resolved.selector)
    .catch(() => ({ found: false, enabled: false }));
  logDebug(
    logger,
    `send button state found=${result.found} enabled=${result.enabled}`,
  );
  return result;
}

export async function getNextUserTurnNumber(page: Page): Promise<number> {
  return page.evaluate(() => {
    const turns = Array.from(
      document.querySelectorAll('[data-testid^="conversation-turn-"]'),
    ) as HTMLElement[];
    const numbers = turns
      .map((el) => {
        const id = el.getAttribute("data-testid") || "";
        const match = id.match(/conversation-turn-(\d+)/);
        return match ? Number(match[1]) : NaN;
      })
      .filter((value) => Number.isFinite(value)) as number[];
    const max = numbers.length ? Math.max(...numbers) : 0;
    return max + 1;
  });
}

export async function waitForUserMessage(
  page: Page,
  prompt: string,
  expectedTurn: number,
  timeoutMs = 10_000,
  logger?: (message: string) => void,
  options: { normalizedCandidates?: string[] } = {},
): Promise<boolean> {
  const selector = `[data-testid="conversation-turn-${expectedTurn}"]`;
  const expectedCandidates =
    options.normalizedCandidates && options.normalizedCandidates.length > 0
      ? options.normalizedCandidates
      : [normalizeTextForCompare(prompt)];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(
      ({
        selector,
        userSelector,
        expectedList,
      }: {
        selector: string;
        userSelector: string;
        expectedList: string[];
      }) => {
        const container = document.querySelector(selector);
        if (container) {
          const user = container.querySelector(
            userSelector,
          ) as HTMLElement | null;
          const text = user ? user.innerText || "" : "";
          const normalized = normalizeText(text);
          const matches = expectedList.some((expected) => {
            if (!expected) return false;
            if (normalized === expected) return true;
            if (expected.length > 200) {
              const prefix = expected.slice(0, 200);
              return normalized.startsWith(prefix);
            }
            return false;
          });
          if (matches) {
            return { matched: true, partial: false };
          }
          return { matched: false, partial: false };
        }
        return { matched: false, partial: false };

        function normalizeText(value: string): string {
          return value
            .replace(/\r\n/g, "\n")
            .replace(/\u00a0/g, " ")
            .replace(/\t/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
      },
      {
        selector,
        userSelector: SELECTORS.userMessage,
        expectedList: expectedCandidates,
      },
    );
    if (result.matched) {
      if (result.partial) {
        logger?.(
          `[chatgpt] user message matched via prefix (expectedTurn=${expectedTurn}, prefixLen=200)`,
        );
      }
      return true;
    }
    await sleep(300);
  }
  if (logger) {
    const snapshot = await page
      .evaluate((userSelector) => {
        const turns = Array.from(
          document.querySelectorAll('[data-testid^="conversation-turn-"]'),
        )
          .map((el) => el.getAttribute("data-testid") || "")
          .filter(Boolean);
        const users = Array.from(
          document.querySelectorAll(userSelector),
        ) as HTMLElement[];
        const lastUser = users.length
          ? users[users.length - 1].innerText || ""
          : "";
        return { turns, userCount: users.length, lastUserLen: lastUser.length };
      }, SELECTORS.userMessage)
      .catch(() => null);
    if (snapshot) {
      logger(
        `[chatgpt] user message not found (expectedTurn=${expectedTurn}, userCount=${snapshot.userCount}, turns=${snapshot.turns.join(",")}, lastUserLen=${snapshot.lastUserLen})`,
      );
    }
  }
  return false;
}

export async function waitForThinkingPanel(
  page: Page,
  logger?: (message: string) => void,
): Promise<boolean> {
  try {
    const innerWidth = await page
      .evaluate(() => window.innerWidth)
      .catch(() => null);
    if (typeof innerWidth === "number" && innerWidth < MIN_VIEWPORT_WIDTH) {
      logDebug(
        logger,
        `viewport too narrow (${innerWidth}px); resizing to >=${MIN_VIEWPORT_WIDTH}px`,
      );
    }
    await ensureWideViewport(page);
    try {
      await page.waitForSelector("text=Pro thinking", {
        timeout: THINKING_PANEL_INITIAL_WAIT_MS,
      });
    } catch {
      // continue to attempt open
    }

    if (await hasProThinking(page)) {
      logDebug(logger, "thinking panel visible (pro thinking found)");
      await ensureSidebarCloseButton(page);
      return true;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const clicked = await clickLatestThoughtHeader(page);
      logDebug(
        logger,
        `thinking header click attempt ${attempt + 1}: ${clicked}`,
      );
      if (!clicked) break;
      await ensureWideViewport(page);
      await sleep(THINKING_PANEL_RETRY_WAIT_MS);
      if (await hasProThinking(page)) {
        logDebug(logger, "thinking panel visible after header click");
        await ensureSidebarCloseButton(page);
        return true;
      }
    }
    logDebug(logger, "thinking panel not confirmed");
    return false;
  } catch (error) {
    logger?.(`[thinking] panel check failed: ${String(error)}`);
    return false;
  }
}

async function ensureSidebarCloseButton(page: Page): Promise<void> {
  await page
    .locator(SELECTORS.sidebarClose)
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function hasProThinking(page: Page): Promise<boolean> {
  return page
    .locator("text=Pro thinking")
    .count()
    .then((count) => count > 0)
    .catch(() => false);
}

async function clickLatestThoughtHeader(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll("div, span, button"),
    ) as HTMLElement[];
    const headers = elements.filter((el) => {
      const text = (el.textContent || "").trim();
      return /^thought for \d+/i.test(text) && text.length < 50;
    });
    const header = headers.length ? headers[headers.length - 1] : null;
    if (header) {
      header.click();
      return true;
    }
    return false;
  });
}

async function clickSendButton(
  page: Page,
  logger?: (message: string) => void,
): Promise<void> {
  const selector = await waitForSelectorPair(
    page,
    SELECTOR_PAIRS.sendButton,
    logger,
    {
      timeoutMs: 15_000,
      state: "visible",
    },
  );
  logDebug(logger, `send button selector resolved: ${selector}`);
  const button = page.locator(selector);
  const disabled = await button.evaluate((el) =>
    el instanceof HTMLButtonElement ? el.disabled : false,
  );
  if (disabled) {
    throw new Error("Send button is disabled");
  }
  await button.click();
}

export async function waitForCompletion(
  page: Page,
  options: {
    timeoutMs: number;
    pollMs: number;
    prompt?: string;
    expectedAssistantTurn?: number;
    logger?: (message: string) => void;
  },
): Promise<WaitForCompletionResult> {
  const start = Date.now();
  let lastText = "";
  let lastIndex = -1;
  let lastChangeAt = Date.now();
  let sawGenerating = false;
  let lastCopyVisible = false;
  let lastGenerating = false;
  let loggedEmptyAssistant = false;
  let lastHeartbeatLog = 0;
  const heartbeatMs = 30_000;
  let generationEndedAt: number | null = null;

  const basePollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const pollMs = Math.max(500, Math.min(basePollMs, 1000));
  if (pollMs !== basePollMs) {
    logDebug(
      options.logger,
      `poll interval clamped (requested=${basePollMs}, using=${pollMs})`,
    );
  }

  if (options.expectedAssistantTurn) {
    logDebug(
      options.logger,
      `waiting for assistant turn ${options.expectedAssistantTurn}`,
    );
  }

  while (Date.now() - start < options.timeoutMs) {
    const snapshot = await getCompletionSnapshot(
      page,
      options.logger,
      options.expectedAssistantTurn,
    );
    if (snapshot.innerWidth > 0 && snapshot.innerWidth < MIN_VIEWPORT_WIDTH) {
      logDebug(
        options.logger,
        `viewport too narrow (${snapshot.innerWidth}px); resizing to >=${MIN_VIEWPORT_WIDTH}px`,
      );
      await ensureWideViewport(page);
    }

    if (snapshot.lastAssistantText) {
      if (
        snapshot.lastAssistantText !== lastText ||
        snapshot.lastAssistantIndex !== lastIndex
      ) {
        lastText = snapshot.lastAssistantText;
        lastIndex = snapshot.lastAssistantIndex;
        lastChangeAt = Date.now();
        logDebug(
          options.logger,
          `response update (index=${lastIndex}, len=${lastText.length})`,
        );
      }
    }

    if (snapshot.generating) {
      sawGenerating = true;
      generationEndedAt = null;
    } else if (sawGenerating && generationEndedAt === null) {
      generationEndedAt = Date.now();
    }
    if (
      snapshot.copyVisible !== lastCopyVisible ||
      snapshot.generating !== lastGenerating
    ) {
      logDebug(
        options.logger,
        `response state (copyVisible=${snapshot.copyVisible}, generating=${snapshot.generating})`,
      );
      lastCopyVisible = snapshot.copyVisible;
      lastGenerating = snapshot.generating;
    }
    if (
      snapshot.copyVisible &&
      !snapshot.lastAssistantText &&
      !loggedEmptyAssistant
    ) {
      logDebug(
        options.logger,
        `response copy visible but assistant text empty (assistantCount=${snapshot.assistantCount}, innerTextLen=${snapshot.innerTextLength}, visible=${snapshot.lastAssistantVisible})`,
      );
      loggedEmptyAssistant = true;
    }
    if (options.expectedAssistantTurn && !snapshot.expectedTurnFound) {
      await scrollLatestAssistantIntoView(page, options.logger);
    } else if (snapshot.assistantCount === 0) {
      await scrollLatestAssistantIntoView(page, options.logger);
    } else if (snapshot.copyVisible && !snapshot.lastAssistantText) {
      await scrollLatestAssistantIntoView(page, options.logger);
    }
    if (Date.now() - lastHeartbeatLog > heartbeatMs) {
      logDebug(
        options.logger,
        `waiting response (assistantCount=${snapshot.assistantCount}, generating=${snapshot.generating}, copyVisible=${snapshot.copyVisible}, expectedTurnFound=${snapshot.expectedTurnFound}, expectedAssistantFound=${snapshot.expectedAssistantFound}, lastTextLen=${snapshot.lastAssistantText.length})`,
      );
      lastHeartbeatLog = Date.now();
    }

    const stable = Date.now() - lastChangeAt >= RESPONSE_STABILITY_MS;
    const content = snapshot.lastAssistantText || lastText;
    if (snapshot.copyVisible && content && stable) {
      return {
        content,
        assistantIndex: snapshot.lastAssistantIndex ?? lastIndex,
        conversationUrl: page.url(),
      };
    }

    if (
      generationEndedAt &&
      Date.now() - generationEndedAt > 30_000 &&
      !snapshot.copyVisible
    ) {
      throw new ResponseFailedError("Response failed or canceled");
    }

    await sleep(pollMs);
  }

  const snapshot = await getCompletionSnapshot(
    page,
    options.logger,
    options.expectedAssistantTurn,
  );
  if (snapshot.copyVisible && snapshot.lastAssistantText) {
    return {
      content: snapshot.lastAssistantText,
      assistantIndex: snapshot.lastAssistantIndex,
      conversationUrl: page.url(),
    };
  }
  if (snapshot.generating) {
    throw new ResponseStalledError(
      "Response stalled with stop/update button visible",
    );
  }
  if (sawGenerating) {
    throw new ResponseFailedError("Response failed or canceled");
  }
  throw new ResponseTimeoutError("Timed out waiting for completion");
}

export async function isGenerating(page: Page): Promise<boolean> {
  const snapshot = await getCompletionSnapshot(page);
  return snapshot.generating;
}

export async function isResponseComplete(page: Page): Promise<boolean> {
  const snapshot = await getCompletionSnapshot(page);
  return snapshot.copyVisible;
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
  let content = await readThinkingSections(page);
  if (content) return content;

  const clicked = await clickLatestThoughtHeader(page);
  if (clicked) {
    await sleep(500);
    content = await readThinkingSections(page);
    if (content) return content;
  }

  return "";
}

async function readThinkingSections(page: Page): Promise<string> {
  return page.evaluate((selectors) => {
    const sections: string[] = [];

    const proThinking = findProThinking();
    if (proThinking) {
      const container =
        proThinking.closest("section") ?? proThinking.parentElement;
      if (container) {
        // Extract body text, stripping the "Pro thinking" header and other UI chrome
        const bodyText = getBodyText(container, proThinking);
        if (bodyText) sections.push(bodyText);
      }
    }

    const sourcesHeader = document.querySelector(
      selectors.sourcesHeader,
    ) as HTMLElement | null;
    if (sourcesHeader) {
      const container =
        sourcesHeader.closest("section") ?? sourcesHeader.parentElement;
      if (container) {
        const bodyText = getBodyText(container, sourcesHeader);
        if (bodyText) sections.push("Sources:\n" + bodyText);
      }
    }

    return sections.join("\n\n").trim();

    function findProThinking(): HTMLElement | null {
      const elements = Array.from(
        document.querySelectorAll("div, span, p"),
      ) as HTMLElement[];
      return (
        elements.find((el) => {
          const text = (el.textContent || "").trim();
          if (!text) return false;
          if (text === "Pro thinking") return true;
          if (text.length < 200 && /^pro thinking/i.test(text)) return true;
          return false;
        }) ?? null
      );
    }

    /** Extract text from a container, excluding the header element and known UI chrome. */
    function getBodyText(
      container: HTMLElement,
      headerEl: HTMLElement,
    ): string {
      const children = Array.from(container.children) as HTMLElement[];
      const bodyParts: string[] = [];
      for (const child of children) {
        if (child === headerEl) continue;
        // Skip known UI chrome elements
        const tag = child.tagName?.toLowerCase();
        if (tag === "button") continue;
        const text = child.innerText?.trim();
        if (!text) continue;
        // Strip leading "Pro thinking" prefix that some pages add to body text
        const cleaned = text.replace(/^Pro thinking\n?/i, "").trim();
        if (cleaned) bodyParts.push(cleaned);
      }
      if (bodyParts.length > 0) return bodyParts.join("\n");
      // Fallback: use container text with header stripped
      const full = container.innerText?.trim() || "";
      return full.replace(/^Pro thinking\n?/i, "").trim();
    }
  }, SELECTORS);
}

export async function ensureWideViewport(page: Page): Promise<void> {
  try {
    const current = page.viewportSize();
    if (current && current.width >= MIN_VIEWPORT_WIDTH) return;
    if (current && current.width < MIN_VIEWPORT_WIDTH) {
      await page.setViewportSize(WIDE_VIEWPORT);
      return;
    }
    const innerWidth = await page
      .evaluate(() => window.innerWidth)
      .catch(() => null);
    if (typeof innerWidth === "number" && innerWidth >= MIN_VIEWPORT_WIDTH) {
      return;
    }
    await page.setViewportSize(WIDE_VIEWPORT);
  } catch {
    // ignore
  }
}

async function scrollLatestAssistantIntoView(
  page: Page,
  logger?: (message: string) => void,
): Promise<void> {
  try {
    const result = await page.evaluate((selectors) => {
      const nodes = Array.from(
        document.querySelectorAll(selectors.assistantMessage),
      ) as HTMLElement[];
      if (nodes.length > 0) {
        const last = nodes[nodes.length - 1];
        last.scrollIntoView({ block: "end", behavior: "auto" });
        return { scrolled: "assistant", count: nodes.length };
      }
      const anchor = document.querySelector(
        selectors.threadBottom,
      ) as HTMLElement | null;
      if (anchor) {
        anchor.scrollIntoView({ block: "end", behavior: "auto" });
        return { scrolled: "thread-bottom", count: 0 };
      }
      return { scrolled: "none", count: 0 };
    }, SELECTORS);
    if (result.scrolled !== "none") {
      logDebug(
        logger,
        `scroll to ${result.scrolled} (assistantCount=${result.count})`,
      );
    }
  } catch (error) {
    logger?.(`[chatgpt] scroll latest assistant failed: ${String(error)}`);
  }
}

async function getCompletionSnapshot(
  page: Page,
  logger?: (message: string) => void,
  expectedAssistantTurn?: number,
): Promise<{
  copyVisible: boolean;
  expectedTurnFound: boolean;
  expectedAssistantFound: boolean;
  generating: boolean;
  lastAssistantText: string;
  lastAssistantIndex: number;
  assistantCount: number;
  lastAssistantVisible: boolean;
  innerTextLength: number;
  innerWidth: number;
}> {
  const snapshot = await page.evaluate(
    ({ selectors, expectedTurn }) => {
      const buttons = Array.from(
        document.querySelectorAll("button"),
      ) as HTMLButtonElement[];
      const generating = buttons.some((button) => {
        if (!isVisible(button)) return false;
        const label =
          button.innerText ||
          button.textContent ||
          button.getAttribute("aria-label") ||
          button.getAttribute("title") ||
          button.getAttribute("data-testid") ||
          "";
        const text = label.toLowerCase();
        return text.includes("stop") || text.includes("update");
      });

      const nodes = Array.from(
        document.querySelectorAll(selectors.assistantMessage),
      ) as HTMLElement[];
      const last = nodes[nodes.length - 1] ?? null;
      let expectedTurnFound = false;
      let expectedAssistantFound = false;
      let expectedContainer: HTMLElement | null = null;
      let expectedAssistant: HTMLElement | null = null;
      if (typeof expectedTurn === "number") {
        // Check if the base expected turn container exists (tracks readiness)
        const baseSelector = `[data-testid="conversation-turn-${expectedTurn}"]`;
        expectedTurnFound = Boolean(document.querySelector(baseSelector));

        // Scan forward from expectedTurn to find the actual assistant response.
        // ChatGPT may insert intermediate turns (e.g. a "thinking" turn with no
        // data-message-author-role) between the user and assistant turns.
        for (let offset = 0; offset <= 3; offset++) {
          const turnNum = expectedTurn + offset;
          const turnSelector = `[data-testid="conversation-turn-${turnNum}"]`;
          const turnEl = document.querySelector(
            turnSelector,
          ) as HTMLElement | null;
          if (!turnEl) continue;
          const assistantEl = turnEl.querySelector(
            selectors.assistantMessage,
          ) as HTMLElement | null;
          if (assistantEl) {
            expectedContainer = turnEl;
            expectedAssistant = assistantEl;
            expectedAssistantFound = true;
            break;
          }
        }
      }
      const targetAssistant =
        typeof expectedTurn === "number" ? expectedAssistant : last;
      const lastVisible = targetAssistant ? isVisible(targetAssistant) : false;
      const innerText = targetAssistant?.innerText ?? "";
      const targetTurn = targetAssistant
        ? (targetAssistant.closest(
            '[data-testid^="conversation-turn-"]',
          ) as HTMLElement | null)
        : null;
      const copyScope =
        typeof expectedTurn === "number" ? expectedContainer : targetTurn;
      const copyPrimary = copyScope
        ? (Array.from(
            copyScope.querySelectorAll(selectors.copyButtonPrimary),
          ) as HTMLElement[])
        : [];
      const copySecondary = copyScope
        ? (Array.from(
            copyScope.querySelectorAll(selectors.copyButtonSecondary),
          ) as HTMLElement[])
        : [];
      const copyElements = [...copyPrimary, ...copySecondary];
      const copyElement = copyElements[0] ?? null;
      const copyVisible = copyElement ? isVisible(copyElement) : false;
      const copyMismatch = Boolean(
        copyPrimary.length > 0 &&
        copySecondary.length > 0 &&
        copyPrimary[0] !== copySecondary[0],
      );

      return {
        copyVisible,
        copyMismatch,
        copyPrimaryFound: copyPrimary.length > 0,
        copySecondaryFound: copySecondary.length > 0,
        generating,
        lastAssistantText: innerText,
        lastAssistantIndex: targetAssistant
          ? nodes.indexOf(targetAssistant)
          : -1,
        assistantCount: nodes.length,
        lastAssistantVisible: lastVisible,
        innerTextLength: innerText.length,
        expectedTurnFound,
        expectedAssistantFound,
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
    },
    { selectors: SELECTORS, expectedTurn: expectedAssistantTurn ?? null },
  );

  maybeLogMismatch("copyButton", snapshot, logger);

  return {
    copyVisible: snapshot.copyVisible,
    expectedTurnFound: snapshot.expectedTurnFound,
    expectedAssistantFound: snapshot.expectedAssistantFound,
    generating: snapshot.generating,
    lastAssistantText: snapshot.lastAssistantText,
    lastAssistantIndex: snapshot.lastAssistantIndex,
    assistantCount: snapshot.assistantCount,
    lastAssistantVisible: snapshot.lastAssistantVisible,
    innerTextLength: snapshot.innerTextLength,
    innerWidth: snapshot.innerWidth,
  };
}

async function waitForSelectorPair(
  page: Page,
  pair: SelectorPair,
  logger: ((message: string) => void) | undefined,
  options: { timeoutMs?: number; state?: "attached" | "visible" } = {},
): Promise<string> {
  const combined = pair.secondary
    ? `${pair.primary}, ${pair.secondary}`
    : pair.primary;
  logDebug(
    logger,
    `waitForSelectorPair ${pair.name} combined="${combined}" state=${options.state ?? "attached"}`,
  );
  await page.waitForSelector(combined, {
    timeout: options.timeoutMs,
    state: options.state ?? "attached",
  });
  const resolved = await resolveSelectorPair(page, pair, logger);
  if (!resolved.selector) {
    throw new Error(`Selector not found for ${pair.name}`);
  }
  logDebug(
    logger,
    `selector resolved ${pair.name} -> ${resolved.selector} (primaryCount=${resolved.primaryCount}, secondaryCount=${resolved.secondaryCount})`,
  );
  return resolved.selector;
}

async function selectorExists(
  page: Page,
  pair: SelectorPair,
  logger?: (message: string) => void,
  options: { requireText?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const combined = pair.secondary
    ? `${pair.primary}, ${pair.secondary}`
    : pair.primary;
  if (options.timeoutMs) {
    try {
      await page.waitForSelector(combined, {
        timeout: options.timeoutMs,
        state: "attached",
      });
    } catch {
      // fall through to evaluation
    }
  }
  const resolved = (await page.evaluate(
    ({
      primary,
      secondary,
      text,
    }: {
      primary: string;
      secondary: string | null;
      text: string;
    }) => {
      const primaryEls = Array.from(document.querySelectorAll(primary));
      const secondaryEls = secondary
        ? Array.from(document.querySelectorAll(secondary))
        : [];
      const needle = text.toLowerCase();
      const matchesText = (el: Element) =>
        !needle || (el.textContent || "").toLowerCase().includes(needle);
      const primaryMatch = primaryEls.find((el) => matchesText(el)) ?? null;
      const secondaryMatch = secondaryEls.find((el) => matchesText(el)) ?? null;
      const found = Boolean(primaryMatch || secondaryMatch);
      const mismatch =
        primaryMatch && secondaryMatch && primaryMatch !== secondaryMatch;
      return {
        found,
        mismatch,
        primaryCount: primaryEls.length,
        secondaryCount: secondaryEls.length,
        primaryMatched: Boolean(primaryMatch),
        secondaryMatched: Boolean(secondaryMatch),
      };
    },
    {
      primary: pair.primary,
      secondary: pair.secondary ?? null,
      text: options.requireText ?? "",
    },
  )) as {
    found: boolean;
    mismatch: boolean;
    primaryCount: number;
    secondaryCount: number;
    primaryMatched: boolean;
    secondaryMatched: boolean;
  };

  if (resolved.mismatch) {
    logSelectorMismatch(pair.name, logger);
  }

  logDebug(
    logger,
    `selectorExists ${pair.name} found=${resolved.found} primaryCount=${resolved.primaryCount} secondaryCount=${resolved.secondaryCount} primaryMatched=${resolved.primaryMatched} secondaryMatched=${resolved.secondaryMatched}`,
  );
  return resolved.found;
}

async function resolveSelectorPair(
  page: Page,
  pair: SelectorPair,
  logger?: (message: string) => void,
): Promise<SelectorMatch> {
  const resolved = (await page.evaluate(
    ({ primary, secondary }: { primary: string; secondary: string | null }) => {
      const primaryEls = Array.from(document.querySelectorAll(primary));
      const secondaryEls = secondary
        ? Array.from(document.querySelectorAll(secondary))
        : [];
      const primaryEl = primaryEls[0] ?? null;
      const secondaryEl = secondaryEls[0] ?? null;
      const mismatch = primaryEl && secondaryEl && primaryEl !== secondaryEl;
      return {
        selector: primaryEl ? primary : secondaryEl ? secondary : null,
        mismatch,
        primaryFound: Boolean(primaryEl),
        secondaryFound: Boolean(secondaryEl),
        primaryCount: primaryEls.length,
        secondaryCount: secondaryEls.length,
      };
    },
    {
      primary: pair.primary,
      secondary: pair.secondary ?? null,
    },
  )) as SelectorMatch;

  if (resolved.mismatch) {
    logSelectorMismatch(pair.name, logger);
  }

  return resolved;
}

function maybeLogMismatch(
  key: string,
  snapshot: {
    copyMismatch?: boolean;
    copyPrimaryFound?: boolean;
    copySecondaryFound?: boolean;
  },
  logger?: (message: string) => void,
): void {
  if (!snapshot.copyMismatch) return;
  if (snapshot.copyPrimaryFound && snapshot.copySecondaryFound) {
    logSelectorMismatch(key, logger);
  }
}

function logSelectorMismatch(
  key: string,
  logger?: (message: string) => void,
): void {
  if (loggedSelectorMismatches.has(key)) return;
  loggedSelectorMismatches.add(key);
  logger?.(
    `[selectors] mismatch for ${key}; data-testid and aria selectors resolve to different elements. Please report this to the developer.`,
  );
}

function logDebug(
  logger: ((message: string) => void) | undefined,
  message: string,
): void {
  logger?.(`[chatgpt] ${message}`);
}

function normalizeTextForCompare(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
