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
  promptInputSecondary: ".ProseMirror, [contenteditable=\"true\"]",
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
  const hasModelSwitcher = await selectorExists(page, SELECTOR_PAIRS.modelSwitcher, logger);
  const hasNewChat = await selectorExists(page, SELECTOR_PAIRS.newChat, logger, {
    requireText: "new chat",
  });

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
  const selector = await waitForSelectorPair(page, SELECTOR_PAIRS.promptInput, logger, {
    timeoutMs,
    state: "attached",
  });
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
      const span = document.querySelector("#page-header span") as HTMLElement | null;
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
      const span = document.querySelector("#page-header span") as HTMLElement | null;
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

export async function submitPrompt(
  page: Page,
  prompt: string,
  logger?: (message: string) => void,
): Promise<string> {
  await waitForPromptInput(page, 30_000, logger);
  const normalizedPrompt = prompt.replace(/\r\n/g, "\n");
  const preparedPrompt = normalizedPrompt.replace(/\t/g, "  ");
  const selector = await waitForSelectorPair(page, SELECTOR_PAIRS.promptInput, logger, {
    timeoutMs: 30_000,
    state: "visible",
  });
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
    logDebug(logger, `typing prompt attempt ${attempt + 1}`);
    await clearInput();
    await input.click();
    await page.keyboard.insertText(preparedPrompt);
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
    if (max <= 0) return 1;
    return max % 2 === 0 ? max + 1 : max + 2;
  });
}

export async function waitForUserMessage(
  page: Page,
  prompt: string,
  expectedTurn: number,
  timeoutMs = 10_000,
  logger?: (message: string) => void,
): Promise<boolean> {
  const selector = `[data-testid="conversation-turn-${expectedTurn}"]`;
  const expected = normalizeTextForCompare(prompt);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await page.evaluate(
      ({
        selector,
        userSelector,
        expectedNormalized,
      }: {
        selector: string;
        userSelector: string;
        expectedNormalized: string;
      }) => {
        const container = document.querySelector(selector);
        if (container) {
          const user = container.querySelector(userSelector) as HTMLElement | null;
          const text = user ? (user.innerText || "") : "";
          return { matched: normalizeText(text) === expectedNormalized, fallback: false };
        }
        const users = Array.from(document.querySelectorAll(userSelector)) as HTMLElement[];
        for (const user of users) {
          const text = user.innerText || "";
          if (normalizeText(text) === expectedNormalized) {
            return { matched: true, fallback: true };
          }
        }
        return { matched: false, fallback: false };

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
        expectedNormalized: expected,
      },
    );
    if (result.matched) {
      if (result.fallback) {
        logger?.(
          `[chatgpt] user message matched via fallback; expected turn ${expectedTurn}`,
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
        const users = Array.from(document.querySelectorAll(userSelector)) as HTMLElement[];
        const lastUser = users.length ? users[users.length - 1].innerText || "" : "";
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
      logDebug(logger, `thinking header click attempt ${attempt + 1}: ${clicked}`);
      if (!clicked) break;
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
  await page.locator(SELECTORS.sidebarClose).waitFor({ state: "visible", timeout: 10_000 });
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
    const elements = Array.from(document.querySelectorAll("div, span, button")) as HTMLElement[];
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

async function clickSendButton(page: Page, logger?: (message: string) => void): Promise<void> {
  const selector = await waitForSelectorPair(page, SELECTOR_PAIRS.sendButton, logger, {
    timeoutMs: 15_000,
    state: "visible",
  });
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
    logger?: (message: string) => void;
  },
): Promise<WaitForCompletionResult> {
  const start = Date.now();
  let lastText = "";
  let lastIndex = -1;
  let lastChangeAt = Date.now();
  let sawAssistant = false;
  let sawGenerating = false;
  let lastCopyVisible = false;
  let lastGenerating = false;

  const basePollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const pollMs = Math.max(500, Math.min(basePollMs, 1000));

  while (Date.now() - start < options.timeoutMs) {
    const snapshot = await getCompletionSnapshot(page, options.logger);
    if (snapshot.innerWidth > 0 && snapshot.innerWidth < MIN_VIEWPORT_WIDTH) {
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
        sawAssistant = true;
        logDebug(
          options.logger,
          `response update (index=${lastIndex}, len=${lastText.length})`,
        );
      }
    }

    if (snapshot.generating) {
      sawGenerating = true;
    }
    if (snapshot.copyVisible !== lastCopyVisible || snapshot.generating !== lastGenerating) {
      logDebug(
        options.logger,
        `response state (copyVisible=${snapshot.copyVisible}, generating=${snapshot.generating})`,
      );
      lastCopyVisible = snapshot.copyVisible;
      lastGenerating = snapshot.generating;
    }

    const stable = Date.now() - lastChangeAt >= RESPONSE_STABILITY_MS;
    if (snapshot.copyVisible && lastText && stable) {
      return {
        content: snapshot.lastAssistantText || lastText,
        assistantIndex: snapshot.lastAssistantIndex ?? lastIndex,
        conversationUrl: page.url(),
      };
    }

    if (!snapshot.generating && !snapshot.copyVisible && sawAssistant) {
      throw new ResponseFailedError("Response failed or canceled");
    }

    await sleep(pollMs);
  }

  const snapshot = await getCompletionSnapshot(page, options.logger);
  if (snapshot.copyVisible && snapshot.lastAssistantText) {
    return {
      content: snapshot.lastAssistantText,
      assistantIndex: snapshot.lastAssistantIndex,
      conversationUrl: page.url(),
    };
  }
  if (snapshot.generating) {
    throw new ResponseStalledError("Response stalled with stop/update button visible");
  }
  if (sawGenerating || sawAssistant) {
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
      const container = proThinking.closest("section") ?? proThinking.parentElement;
      const text =
        container?.innerText?.trim() || proThinking.innerText?.trim() || "";
      if (text) sections.push(text);
    }

    const sourcesHeader = document.querySelector(selectors.sourcesHeader) as HTMLElement | null;
    if (sourcesHeader) {
      const container = sourcesHeader.closest("section") ?? sourcesHeader.parentElement;
      const text =
        container?.innerText?.trim() || sourcesHeader.innerText?.trim() || "";
      if (text) sections.push(text);
    }

    return sections.join("\n\n").trim();

    function findProThinking(): HTMLElement | null {
      const elements = Array.from(document.querySelectorAll("div, span, p")) as HTMLElement[];
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
  }, SELECTORS);
}

export async function ensureWideViewport(page: Page): Promise<void> {
  try {
    const current = page.viewportSize();
    if (!current) return;
    if (current.width < MIN_VIEWPORT_WIDTH) {
      await page.setViewportSize(WIDE_VIEWPORT);
    }
  } catch {
    // ignore
  }
}

async function getCompletionSnapshot(
  page: Page,
  logger?: (message: string) => void,
): Promise<{
  copyVisible: boolean;
  generating: boolean;
  lastAssistantText: string;
  lastAssistantIndex: number;
  innerWidth: number;
}> {
  const snapshot = await page.evaluate((selectors) => {
    const copyPrimary = document.querySelector(selectors.copyButtonPrimary);
    const copySecondary = document.querySelector(selectors.copyButtonSecondary);
    const copyElement = copyPrimary || copySecondary;
    const copyVisible = copyElement ? isVisible(copyElement as HTMLElement) : false;
    const copyMismatch = Boolean(
      copyPrimary && copySecondary && copyPrimary !== copySecondary,
    );

    const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
    const generating = buttons.some((button) => {
      if (!isVisible(button)) return false;
      const text = (button.innerText || "").toLowerCase();
      return text.includes("stop") || text.includes("update");
    });

    const nodes = Array.from(document.querySelectorAll(selectors.assistantMessage)) as HTMLElement[];
    const last = nodes[nodes.length - 1];
    return {
      copyVisible,
      copyMismatch,
      copyPrimaryFound: Boolean(copyPrimary),
      copySecondaryFound: Boolean(copySecondary),
      generating,
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

  maybeLogMismatch("copyButton", snapshot, logger);

  return {
    copyVisible: snapshot.copyVisible,
    generating: snapshot.generating,
    lastAssistantText: snapshot.lastAssistantText,
    lastAssistantIndex: snapshot.lastAssistantIndex,
    innerWidth: snapshot.innerWidth,
  };
}

async function waitForSelectorPair(
  page: Page,
  pair: SelectorPair,
  logger: ((message: string) => void) | undefined,
  options: { timeoutMs?: number; state?: "attached" | "visible" } = {},
): Promise<string> {
  const combined = pair.secondary ? `${pair.primary}, ${pair.secondary}` : pair.primary;
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
  options: { requireText?: string } = {},
): Promise<boolean> {
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
      const primaryEl = document.querySelector(primary);
      const secondaryEl = secondary ? document.querySelector(secondary) : null;
      const secondaryMatch = secondaryEl
        ? text
          ? (secondaryEl.textContent || "").toLowerCase().includes(text)
          : true
        : false;
      const mismatch =
        primaryEl && secondaryEl && primaryEl !== secondaryEl && secondaryMatch;
      return {
        found: Boolean(primaryEl || (secondaryEl && secondaryMatch)),
        mismatch,
        primaryFound: Boolean(primaryEl),
        secondaryFound: Boolean(secondaryEl && secondaryMatch),
      };
    },
    {
      primary: pair.primary,
      secondary: pair.secondary ?? null,
      text: options.requireText ? options.requireText.toLowerCase() : "",
    },
  )) as {
    found: boolean;
    mismatch: boolean;
    primaryFound: boolean;
    secondaryFound: boolean;
  };

  if (resolved.mismatch) {
    logSelectorMismatch(pair.name, logger);
  }

  logDebug(
    logger,
    `selectorExists ${pair.name} found=${resolved.found} primaryCount=${resolved.primaryFound ? "1+" : "0"} secondaryCount=${resolved.secondaryFound ? "1+" : "0"}`,
  );
  return resolved.found;
}

async function resolveSelectorPair(
  page: Page,
  pair: SelectorPair,
  logger?: (message: string) => void,
): Promise<SelectorMatch> {
  const resolved = (await page.evaluate(
    ({
      primary,
      secondary,
    }: {
      primary: string;
      secondary: string | null;
    }) => {
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
