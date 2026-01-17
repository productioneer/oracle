import type { Page } from 'puppeteer';
import { sleep } from '../utils/time.js';

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

export const DEFAULT_BASE_URL = 'https://chatgpt.com/';
export const FALLBACK_BASE_URL = 'https://chat.openai.com/';

export async function navigateToChat(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
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
  if (url.includes('login') || url.includes('auth')) return true;
  const hasEmailInput = await page.$('input[type="email"], input[name="username"]');
  if (hasEmailInput) return true;
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  return /log in|sign in/i.test(bodyText);
}

export async function detectCloudflare(page: Page): Promise<boolean> {
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  return /cloudflare|just a moment|checking your browser/i.test(bodyText);
}

export async function waitForPromptInput(page: Page, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const input = await page.$(
      'textarea#prompt-textarea, textarea[data-id="root"], textarea, div[contenteditable="true"][data-testid="prompt-textarea"], div[contenteditable="true"][role="textbox"]',
    );
    if (input) {
      const canType = await page.evaluate((el) => {
        if (el instanceof HTMLTextAreaElement) return !el.disabled;
        const contentEditable = el.getAttribute('contenteditable');
        const ariaDisabled = el.getAttribute('aria-disabled');
        return contentEditable !== 'false' && ariaDisabled !== 'true';
      }, input);
      if (canType) return;
    }
    await sleep(500);
  }
  throw new Error('Prompt input not available');
}

export async function submitPrompt(page: Page, prompt: string): Promise<string> {
  const input = await page.$(
    'textarea#prompt-textarea, textarea[data-id="root"], textarea, div[contenteditable="true"][data-testid="prompt-textarea"], div[contenteditable="true"][role="textbox"]',
  );
  if (!input) throw new Error('Prompt input not found');
  const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
  await input.evaluate((el) => (el as HTMLElement).focus());
  if (tagName === 'textarea') {
    await input.evaluate((el) => {
      (el as HTMLTextAreaElement).value = '';
    });
    await input.type(prompt, { delay: 5 });
    await input.evaluate((el, value) => {
      (el as HTMLTextAreaElement).value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, prompt);
  } else {
    await input.evaluate((el) => {
      (el as HTMLElement).textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await input.type(prompt, { delay: 5 });
  }
  const typedValue = await input.evaluate((el) => {
    if (el instanceof HTMLTextAreaElement) return el.value;
    return (el as HTMLElement).innerText ?? '';
  });
  const clicked = await clickSendIfPresent(page);
  if (!clicked) {
    await page.keyboard.press('Enter');
  }
  return typedValue;
}

export async function waitForUserMessage(page: Page, prompt: string, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  const needle = prompt.trim();
  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate((text) => {
      const nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"]')) as HTMLElement[];
      if (nodes.length) {
        return nodes.some((node) => (node.innerText || '').trim() === text);
      }
      const main = (document.querySelector('main') as HTMLElement | null) ?? (document.querySelector('[role="main"]') as HTMLElement | null);
      const haystack = (main?.innerText ?? document.body?.innerText ?? '').trim();
      return haystack.includes(text);
    }, needle);
    if (found) return true;
    await sleep(300);
  }
  return false;
}

async function clickSendIfPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
    ];
    const button = selectors
      .map((selector) => document.querySelector(selector) as HTMLButtonElement | null)
      .find((el) => el);
    if (button && !button.disabled) {
      button.click();
      return true;
    }
    return false;
  });
}

export async function waitForCompletion(
  page: Page,
  options: {
    timeoutMs: number;
    stableMs: number;
    stallMs: number;
    pollMs: number;
    prompt?: string;
  },
): Promise<WaitForCompletionResult> {
  const start = Date.now();
  let lastText = '';
  let lastIndex = -1;
  let stableSince = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const answered = await clickAnswerNowIfPresent(page);
    if (answered) {
      stableSince = Date.now();
      await sleep(500);
    }

    const { text, index } = await getLastAssistantMessage(page, options.prompt);
    if (text && isSubstantiveText(text) && (text !== lastText || index !== lastIndex)) {
      lastText = text;
      lastIndex = index;
      stableSince = Date.now();
    }

    const generating = await isGenerating(page);
    const stableFor = Date.now() - stableSince;
    if (generating && lastText && stableFor >= options.stallMs) {
      throw new Error('Generation stalled');
    }
    if (!generating && lastText && stableFor >= options.stableMs) {
      const continued = await clickContinueIfPresent(page);
      if (continued) {
        stableSince = Date.now();
        await sleep(500);
        continue;
      }
      const finalMessage = await getLastAssistantMessage(page, options.prompt);
      return {
        content: finalMessage.text || lastText,
        assistantIndex: finalMessage.index ?? lastIndex,
        conversationUrl: page.url(),
      };
    }

    await sleep(options.pollMs);
  }
  throw new Error('Timed out waiting for completion');
}

export async function isGenerating(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const stopButton = document.querySelector('[data-testid=\"stop-button\"]') as HTMLElement | null;
    if (stopButton && isVisible(stopButton)) return true;
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const hasStop = buttons.some((button) => {
      if (!isVisible(button)) return false;
      const label = button.getAttribute('aria-label') || '';
      const text = button.innerText || '';
      return /stop generating|stop/i.test(label) || /stop generating|stop/i.test(text);
    });
    if (hasStop) return true;
    const writingBlock = document.querySelector('[data-writing-block]') as HTMLElement | null;
    if (writingBlock && isVisible(writingBlock)) return true;
    return false;

    function isVisible(el: HTMLElement): boolean {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

  });
}

export async function clickContinueIfPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const target = buttons.find((button) => /continue generating/i.test(button.innerText || ''));
    if (target) {
      target.click();
      return true;
    }
    return false;
  });
}

export async function clickAnswerNowIfPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const target = buttons.find((button) => /answer now/i.test(button.innerText || ''));
    if (target && !target.disabled) {
      target.click();
      return true;
    }
    return false;
  });
}

export async function getLastAssistantMessage(
  page: Page,
  prompt?: string,
): Promise<{ text: string; index: number }> {
  const domResult = await page.evaluate((promptText) => {
    const promptValue = (promptText || '').trim();
    const selectors = [
      '[data-message-author-role]',
      '[data-testid*="conversation"]',
      '[data-testid*="message"]',
      '[data-testid*="chat-message"]',
      'article',
    ];
    const candidates = collectCandidates(selectors);
    const assistantMessages: { text: string; role: string | null }[] = [];
    const unknownMessages: { text: string; role: string | null }[] = [];
    for (const candidate of candidates) {
      const text = extractMarkdown(candidate);
      if (!isSubstantiveText(text)) continue;
      const role = resolveRole(candidate);
      if (role && role.toLowerCase().includes('assistant')) {
        assistantMessages.push({ text, role });
        continue;
      }
      if (role && role.toLowerCase().includes('user')) continue;
      if (promptValue && isPromptMatch(text, promptValue)) continue;
      if (role) {
        if (/system|tool/i.test(role)) continue;
      }
      unknownMessages.push({ text, role });
    }

    const messages = assistantMessages.length ? assistantMessages : unknownMessages;
    if (messages.length) {
      return { text: messages[messages.length - 1].text, index: messages.length - 1 };
    }

    const cachedTextDocs = (window as any).__oracleTextDocs;
    const cachedResult = extractFromTextDocs(cachedTextDocs);
    if (cachedResult.text) return cachedResult;

    const fallbackText =
      extractFromContainerText(promptValue, getMainText()) ||
      extractFromContainerText(promptValue, getRoleMainText()) ||
      extractFromContainerText(promptValue, document.body?.innerText ?? '');
    if (!isSubstantiveText(fallbackText)) return { text: '', index: -1 };
    return { text: fallbackText, index: -1 };

    function collectCandidates(localSelectors: string[]): Element[] {
      const results: Element[] = [];
      const seen = new Set<Element>();
      const roots: (Document | ShadowRoot)[] = [document];
      const main = document.querySelector('main') ?? document.querySelector('[role="main"]');
      const withinMain = (el: Element) => (main ? main.contains(el) : true);
      while (roots.length) {
        const root = roots.pop();
        if (!root) continue;
        for (const selector of localSelectors) {
          const nodes = Array.from(root.querySelectorAll(selector));
          for (const node of nodes) {
            if (seen.has(node)) continue;
            if (selector === 'article' && !withinMain(node)) continue;
            seen.add(node);
            results.push(node);
          }
        }
        const all = Array.from(root.querySelectorAll('*'));
        for (const node of all) {
          const shadow = (node as HTMLElement).shadowRoot;
          if (shadow) roots.push(shadow);
        }
      }
      return results;
    }

    function resolveRole(el: Element): string | null {
      const explicit = el.getAttribute('data-message-author-role') || el.getAttribute('data-author') || el.getAttribute('data-role');
      if (explicit) return explicit;
      let node: Element | null = el;
      while (node) {
        const attr = node.getAttribute('data-message-author-role') || node.getAttribute('data-author') || node.getAttribute('data-role');
        if (attr) return attr;
        const testId = node.getAttribute('data-testid') || '';
        if (/assistant/i.test(testId)) return 'assistant';
        if (/user/i.test(testId)) return 'user';
        const aria = node.getAttribute('aria-label') || '';
        if (/assistant|chatgpt/i.test(aria)) return 'assistant';
        if (/user|you/i.test(aria)) return 'user';
        node = node.parentElement;
      }
      return null;
    }

    function isPromptMatch(text: string, promptNeedle: string): boolean {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (trimmed === promptNeedle) return true;
      if (promptNeedle.length >= 8 && trimmed.includes(promptNeedle) && trimmed.length <= promptNeedle.length + 20) return true;
      return false;
    }

    function extractFromContainerText(promptNeedle: string, text: string): string {
      if (!text) return '';
      const normalized = text.replace(/\r/g, '').trim();
      if (!promptNeedle) return normalized;
      const idx = normalized.lastIndexOf(promptNeedle);
      if (idx === -1) return '';
      let after = normalized.slice(idx + promptNeedle.length).trim();
      after = after.replace(/^(answer now|thinking|stop generating|continue generating)\b[^\n]*\n?/i, '').trim();
      return after;
    }

    function getMainText(): string {
      return (document.querySelector('main') as HTMLElement | null)?.innerText ?? '';
    }

    function getRoleMainText(): string {
      return (document.querySelector('[role="main"]') as HTMLElement | null)?.innerText ?? '';
    }

    function extractFromTextDocs(data: any): { text: string; index: number } {
      if (!data) return { text: '', index: -1 };
      const candidates: Array<{ text: string; role?: string; createTime?: number }> = [];
      const walk = (node: any, role?: string) => {
        if (!node) return;
        if (typeof node === 'string') return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item, role);
          return;
        }
        if (typeof node !== 'object') return;
        const nextRole =
          (typeof node.role === 'string' && node.role) ||
          (typeof node.author?.role === 'string' && node.author.role) ||
          role;
        const createTime = typeof node.create_time === 'number' ? node.create_time : undefined;
        if (typeof node.text === 'string' && node.text.trim()) {
          candidates.push({ text: node.text.trim(), role: nextRole, createTime });
        }
        if (node.content) {
          const content = node.content;
          if (typeof content === 'string' && content.trim()) {
            candidates.push({ text: content.trim(), role: nextRole, createTime });
          }
          if (Array.isArray(content.parts)) {
            const partsText = content.parts.filter((part: any) => typeof part === 'string').join('\n').trim();
            if (partsText) candidates.push({ text: partsText, role: nextRole, createTime });
          }
        }
        for (const value of Object.values(node)) {
          walk(value, nextRole);
        }
      };
      walk(data, undefined);
      if (!candidates.length) return { text: '', index: -1 };
      const assistants = candidates.filter((c) => c.role && /assistant/i.test(c.role));
      const list = assistants.length ? assistants : candidates;
      list.sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0));
      const last = list[list.length - 1];
      return { text: last.text, index: list.length - 1 };
    }

    function isSubstantiveText(text: string): boolean {
      const cleaned = text.replace(/[`\\s]/g, '');
      if (cleaned.length < 3) return false;
      return /[A-Za-z0-9]/.test(cleaned);
    }

    function extractMarkdown(root: Element): string {
      const clone = root.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('pre').forEach((pre) => {
        const code = pre.innerText.trimEnd();
        pre.replaceWith(`\n\`\`\`\n${code}\n\`\`\`\n`);
      });
      clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      clone.querySelectorAll('li').forEach((li) => {
        li.replaceWith(`- ${li.innerText}\n`);
      });
      const text = clone.textContent ?? '';
      return text.replace(/\n{3,}/g, '\n\n').trim();
    }
  }, prompt);
  if (domResult.text) return domResult;

  const conversationId = extractConversationId(page.url());
  if (!conversationId) return domResult;

  try {
    const apiResult = await page.evaluate(async (convId) => {
      const response = await fetch(`/backend-api/conversation/${convId}`, { credentials: 'include' });
      if (!response.ok) return { text: '', index: -1 };
      const data = await response.json();
      const mapping = data?.mapping ?? {};
      const messages = Object.values(mapping)
        .map((entry: any) => entry?.message)
        .filter((msg: any) => msg?.author?.role === 'assistant' && msg?.content);
      if (!messages.length) return { text: '', index: -1 };
      messages.sort((a: any, b: any) => (a.create_time ?? 0) - (b.create_time ?? 0));
      const last = messages[messages.length - 1];
      const parts = Array.isArray(last.content.parts) ? last.content.parts : [];
      const text = parts.join('\n').trim();
      return { text, index: messages.length - 1 };
    }, conversationId);
    if (apiResult.text) return apiResult;
  } catch {}

  try {
    const textDocsResult = await page.evaluate(async (convId) => {
      const response = await fetch(`/backend-api/conversation/${convId}/textdocs`, { credentials: 'include' });
      if (!response.ok) return { text: '', index: -1 };
      const data = await response.json();
      const candidates: Array<{ text: string; role?: string; createTime?: number }> = [];

      const walk = (node: any, role?: string) => {
        if (!node) return;
        if (typeof node === 'string') return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item, role);
          return;
        }
        if (typeof node !== 'object') return;
        const nextRole =
          (typeof node.role === 'string' && node.role) ||
          (typeof node.author?.role === 'string' && node.author.role) ||
          role;
        const createTime = typeof node.create_time === 'number' ? node.create_time : undefined;
        if (typeof node.text === 'string' && node.text.trim()) {
          candidates.push({ text: node.text.trim(), role: nextRole, createTime });
        }
        if (node.content) {
          const content = node.content;
          if (typeof content === 'string' && content.trim()) {
            candidates.push({ text: content.trim(), role: nextRole, createTime });
          }
          if (Array.isArray(content.parts)) {
            const partsText = content.parts.filter((part: any) => typeof part === 'string').join('\n').trim();
            if (partsText) candidates.push({ text: partsText, role: nextRole, createTime });
          }
        }
        for (const value of Object.values(node)) {
          walk(value, nextRole);
        }
      };

      walk(data, undefined);
      if (!candidates.length) return { text: '', index: -1 };
      const assistants = candidates.filter((c) => c.role && /assistant/i.test(c.role));
      const list = assistants.length ? assistants : candidates;
      list.sort((a, b) => (a.createTime ?? 0) - (b.createTime ?? 0));
      const last = list[list.length - 1];
      return { text: last.text, index: list.length - 1 };
    }, conversationId);
    if (textDocsResult.text) return textDocsResult;
  } catch {}

  return domResult;
}

function extractConversationId(url: string): string | null {
  const match = url.match(/\/c\/([a-z0-9-]+)/i);
  if (match) return match[1];
  const alt = url.match(/conversation\/([a-z0-9-]+)/i);
  if (alt) return alt[1];
  return null;
}

function isSubstantiveText(text: string): boolean {
  const cleaned = text.replace(/[`\\s]/g, '');
  if (cleaned.length < 3) return false;
  return /[A-Za-z0-9]/.test(cleaned);
}
