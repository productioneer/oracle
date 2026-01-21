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
  await waitForPromptInput(page, 30_000);
  const normalizedPrompt = prompt.replace(/\r\n/g, "\n");
  // for multiline content, set innerHTML directly (faster), fallback to character-by-character
  const isMultiline =
    normalizedPrompt.includes("\n") || normalizedPrompt.includes("\t");
  // set entire content at once for multiline prompts
  const setFullContent = async (content: string) =>
    page.evaluate(
      (selectors, text) => {
        const el = document.querySelector(selectors.promptInput);
        if (!el) return false;
        if (el instanceof HTMLTextAreaElement) {
          const textarea = el;
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          if (setter) {
            setter.call(textarea, text);
          } else {
            textarea.value = text;
          }
          const inputEvent =
            typeof InputEvent === "function"
              ? new InputEvent("input", {
                  bubbles: true,
                  data: text,
                  inputType: "insertText",
                })
              : new Event("input", { bubbles: true });
          textarea.dispatchEvent(inputEvent);
          textarea.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        // contenteditable: use <br> for newlines
        const div = el as HTMLElement;
        const lines = text.split("\n");
        const html = lines
          .map((line) => {
            // escape HTML entities
            return line
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
          })
          .join("<br>");
        div.innerHTML = html;
        const divInputEvent =
          typeof InputEvent === "function"
            ? new InputEvent("input", {
                bubbles: true,
                data: text,
                inputType: "insertText",
              })
            : new Event("input", { bubbles: true });
        div.dispatchEvent(divInputEvent);
        div.dispatchEvent(new Event("change", { bubbles: true }));
        // set cursor at end
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(div);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      },
      SELECTORS,
      content,
    );
  const normalizeForCompare = (value: string) =>
    value
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/\t/g, "  ");
  const readInputValue = async () =>
    page.evaluate((selectors) => {
      const el = document.querySelector(selectors.promptInput);
      if (!el) return "";
      if (el instanceof HTMLTextAreaElement) return el.value;
      const text = (el as HTMLElement).innerText;
      return text ?? (el as HTMLElement).textContent ?? "";
    }, SELECTORS);
  const clearInput = async () =>
    page.evaluate((selectors) => {
      const el = document.querySelector(selectors.promptInput);
      if (!el) return false;
      if (el instanceof HTMLTextAreaElement) {
        const textarea = el as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (setter) {
          setter.call(textarea, "");
        } else {
          textarea.value = "";
        }
        const inputEvent =
          typeof InputEvent === "function"
            ? new InputEvent("input", {
                bubbles: true,
                data: "",
                inputType: "deleteByCut",
              })
            : new Event("input", { bubbles: true });
        textarea.dispatchEvent(inputEvent);
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        textarea.focus();
        textarea.setSelectionRange(0, 0);
        return true;
      }
      // contenteditable div - set text content and dispatch events
      const div = el as HTMLElement;
      div.textContent = "";
      const inputEvent =
        typeof InputEvent === "function"
          ? new InputEvent("input", {
              bubbles: true,
              data: "",
              inputType: "deleteByCut",
            })
          : new Event("input", { bubbles: true });
      div.dispatchEvent(inputEvent);
      div.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof div.focus === "function") {
        div.focus();
      }
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(div);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return true;
    }, SELECTORS);
  const ensureFocused = async () => {
    await page.focus(SELECTORS.promptInput).catch(() => null);
    const focused = await page
      .evaluate((selectors) => {
        const el = document.querySelector(selectors.promptInput);
        return el ? document.activeElement === el : false;
      }, SELECTORS)
      .catch(() => false);
    if (!focused) {
      await page.click(SELECTORS.promptInput).catch(() => null);
    }
  };
  const sendText = async (text: string, _delay = 0) => {
    if (!text) return;
    await ensureFocused();
    // use DOM manipulation for reliable text insertion in contenteditable
    await page.evaluate(
      (selectors, textToInsert) => {
        const el = document.querySelector(selectors.promptInput);
        if (!el) return;
        if (el instanceof HTMLTextAreaElement) {
          const textarea = el;
          const start = textarea.selectionStart ?? textarea.value.length;
          const end = textarea.selectionEnd ?? textarea.value.length;
          const next =
            textarea.value.slice(0, start) +
            textToInsert +
            textarea.value.slice(end);
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set;
          if (setter) {
            setter.call(textarea, next);
          } else {
            textarea.value = next;
          }
          const inputEvent =
            typeof InputEvent === "function"
              ? new InputEvent("input", {
                  bubbles: true,
                  data: textToInsert,
                  inputType: "insertText",
                })
              : new Event("input", { bubbles: true });
          textarea.dispatchEvent(inputEvent);
          textarea.dispatchEvent(new Event("change", { bubbles: true }));
          const pos = start + textToInsert.length;
          textarea.setSelectionRange(pos, pos);
          return;
        }
        // contenteditable div
        const div = el as HTMLElement;
        const selection = window.getSelection();
        if (!selection) return;
        let range: Range;
        // ensure selection is inside the div, otherwise set cursor at end
        if (
          selection.rangeCount > 0 &&
          div.contains(selection.anchorNode)
        ) {
          range = selection.getRangeAt(0);
        } else {
          range = document.createRange();
          range.selectNodeContents(div);
          range.collapse(false);
        }
        range.deleteContents();
        const textNode = document.createTextNode(textToInsert);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        const divInputEvent =
          typeof InputEvent === "function"
            ? new InputEvent("input", {
                bubbles: true,
                data: textToInsert,
                inputType: "insertText",
              })
            : new Event("input", { bubbles: true });
        div.dispatchEvent(divInputEvent);
        div.dispatchEvent(new Event("change", { bubbles: true }));
      },
      SELECTORS,
      text,
    );
  };
  const insertTab = async () => {
    await ensureFocused();
    try {
      await page.keyboard.sendCharacter("\t");
    } catch {
      await page.type(SELECTORS.promptInput, "  ", { delay: 0 });
    }
    await ensureFocused();
  };
  const insertNewline = async () => {
    await ensureFocused();
    await page.evaluate((selectors) => {
      const el = document.querySelector(selectors.promptInput);
      if (!el) return false;
      if (el instanceof HTMLTextAreaElement) {
        const textarea = el as HTMLTextAreaElement;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        const next =
          textarea.value.slice(0, start) + "\n" + textarea.value.slice(end);
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (setter) {
          setter.call(textarea, next);
        } else {
          textarea.value = next;
        }
        const inputEvent =
          typeof InputEvent === "function"
            ? new InputEvent("input", {
                bubbles: true,
                data: "\n",
                inputType: "insertLineBreak",
              })
            : new Event("input", { bubbles: true });
        textarea.dispatchEvent(inputEvent);
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        const pos = start + 1;
        textarea.setSelectionRange(pos, pos);
        return true;
      }
      const div = el as HTMLElement;
      const selection = window.getSelection();
      if (!selection) return false;
      const range =
        selection.rangeCount > 0
          ? selection.getRangeAt(0)
          : document.createRange();
      range.deleteContents();
      const br = document.createElement("br");
      range.insertNode(br);
      range.setStartAfter(br);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      const inputEvent =
        typeof InputEvent === "function"
          ? new InputEvent("input", {
              bubbles: true,
              data: "\n",
              inputType: "insertLineBreak",
            })
          : new Event("input", { bubbles: true });
      div.dispatchEvent(inputEvent);
      div.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, SELECTORS);
    await ensureFocused();
  };
  const typeMultiline = async (value: string) => {
    const lines = value.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const segments = lines[i].split("\t");
      for (let j = 0; j < segments.length; j += 1) {
        await sendText(segments[j], 2);
        if (j < segments.length - 1) {
          await insertTab();
        }
      }
      if (i < lines.length - 1) {
        await insertNewline();
      }
    }
  };

  let typedValue = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForPromptInput(page, 10_000);
    await ensureFocused();
    const cleared = await clearInput();
    if (!cleared) throw new Error("Prompt input not found");
    await ensureFocused();

    if (isMultiline) {
      if (attempt === 0) {
        // try direct content set first (faster)
        await setFullContent(normalizedPrompt);
      } else {
        // fallback to character-by-character typing
        await typeMultiline(normalizedPrompt);
      }
    } else {
      await sendText(normalizedPrompt, 5);
    }
    await sleep(50);
    typedValue = await readInputValue();
    if (
      !isMultiline ||
      normalizeForCompare(typedValue) === normalizeForCompare(normalizedPrompt)
    ) {
      break;
    }
  }
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
