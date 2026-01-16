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
    const input = await page.$('textarea#prompt-textarea, textarea[data-id="root"], textarea');
    if (input) {
      const disabled = await page.evaluate((el) => (el as HTMLTextAreaElement).disabled, input);
      if (!disabled) return;
    }
    await sleep(500);
  }
  throw new Error('Prompt input not available');
}

export async function submitPrompt(page: Page, prompt: string): Promise<string> {
  const input = await page.$('textarea#prompt-textarea, textarea[data-id="root"], textarea');
  if (!input) throw new Error('Prompt input not found');
  await input.click({ clickCount: 1 });
  await input.evaluate((el) => {
    (el as HTMLTextAreaElement).value = '';
  });
  await input.type(prompt, { delay: 5 });
  await input.evaluate((el, value) => {
    (el as HTMLTextAreaElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, prompt);
  const typedValue = await input.evaluate((el) => (el as HTMLTextAreaElement).value);
  await page.keyboard.press('Enter');
  return typedValue;
}

export async function waitForCompletion(
  page: Page,
  options: {
    timeoutMs: number;
    stableMs: number;
    stallMs: number;
    pollMs: number;
  },
): Promise<WaitForCompletionResult> {
  const start = Date.now();
  let lastText = '';
  let lastIndex = -1;
  let stableSince = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const { text, index } = await getLastAssistantMessage(page);
    if (text && (text !== lastText || index !== lastIndex)) {
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
      const finalMessage = await getLastAssistantMessage(page);
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
    return buttons.some((button) => {
      if (!isVisible(button)) return false;
      const label = button.getAttribute('aria-label') || '';
      const text = button.innerText || '';
      return /stop generating|stop/i.test(label) || /stop generating|stop/i.test(text);
    });

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

export async function getLastAssistantMessage(page: Page): Promise<{ text: string; index: number }> {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')) as HTMLElement[];
    if (!nodes.length) return { text: '', index: -1 };
    const last = nodes[nodes.length - 1];
    const article = last.querySelector('article') ?? last;
    const text = extractMarkdown(article);
    return { text, index: nodes.length - 1 };

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
  });
}
