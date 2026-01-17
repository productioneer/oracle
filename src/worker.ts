import fs from 'fs';
import path from 'path';
import { launchChrome, createHiddenPage } from './browser/chrome.js';
import { launchFirefox } from './browser/firefox.js';
import { checkBrowserRuntime, checkDebugEndpoint, checkPageResponsive } from './browser/health.js';
import {
  DEFAULT_BASE_URL,
  FALLBACK_BASE_URL,
  ensureChatGptReady,
  navigateToChat,
  submitPrompt,
  waitForUserMessage,
  waitForCompletion,
  waitForPromptInput,
} from './browser/chatgpt.js';
import { chromeUserDataDirMac } from './browser/profiles.js';
import { saveResultJson, saveResultMarkdown, saveRunConfig, saveStatus } from './run/state.js';
import type { RunConfig, StatusPayload } from './run/types.js';
import { readJson, pathExists } from './utils/fs.js';
import { createLogger } from './utils/log.js';
import { nowIso, sleep } from './utils/time.js';

const CANCEL_FILE = 'cancel.json';
class NeedsUserError extends Error {
  public readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}
class CancelError extends Error {}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runDir) {
    throw new Error('worker requires --run-dir');
  }
  const runPath = path.join(args.runDir, 'run.json');
  const config = await readJson<RunConfig>(runPath);
  const logger = await createLogger(config.logPath);

  logger(`[worker] start run ${config.runId}`);
  config.startedAt = config.startedAt ?? nowIso();
  await saveRunConfig(config.runPath, config);
  await writeStatus(config, 'starting', 'init', 'worker starting');

  if (await isCanceled(args.runDir)) {
    await finalizeCanceled(config, logger, 'Canceled before start');
    return;
  }

  for (let attempt = config.attempt; attempt <= config.maxAttempts; attempt += 1) {
    config.attempt = attempt;
    await saveRunConfig(config.runPath, config);
    await writeStatus(config, 'running', 'launch', `attempt ${attempt} launching browser`);

    try {
      const result = await runAttempt(config, logger, args.runDir);
      if (result === 'needs_user') return;
      if (result === 'completed') return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`[worker] attempt ${attempt} error: ${message}`);
      config.lastError = message;
      await saveRunConfig(config.runPath, config);
      await writeStatus(config, 'running', 'cleanup', `attempt ${attempt} failed: ${message}`);
      if (attempt >= config.maxAttempts) {
        await finalizeFailed(config, logger, message);
        return;
      }
      await sleep(2000);
    }
  }
}

async function runAttempt(config: RunConfig, logger: (msg: string) => void, runDir: string): Promise<'completed' | 'needs_user'> {
  let browser: import('puppeteer').Browser | null = null;
  let page: import('puppeteer').Page | null = null;
  try {
    if (config.browser === 'chrome') {
      const connection = await launchChrome({
        userDataDir: config.profile.userDataDir,
        profileDir: config.profile.profileDir,
        debugPort: config.debugPort,
        allowVisible: config.allowVisible,
        logger,
      });
      browser = connection.browser;
      config.debugPort = connection.debugPort;
      config.browserPid = connection.browserPid;
      await saveRunConfig(config.runPath, config);
      page = await createHiddenPage(browser, config.runId);
    } else {
      const connection = await launchFirefox({
        profilePath: config.profile.profileDir ?? config.profile.userDataDir,
        allowVisible: config.allowVisible,
        logger,
      });
      browser = connection.browser;
      page = await browser.newPage();
    }
    if (page) {
      attachNetworkTracing(page, logger);
      await injectTextDocsCapture(page, logger);
    }

    await writeStatus(config, 'running', 'login', 'navigating to ChatGPT');
    await navigateWithFallback(page, config.baseUrl);

    const ready = await ensureChatGptReady(page);
    if (ready.needsCloudflare) {
      await writeNeedsUser(config, 'cloudflare', 'Cloudflare challenge detected');
      return 'needs_user';
    }
    if (!ready.loggedIn) {
      await writeNeedsUser(config, 'login', 'Login required');
      return 'needs_user';
    }

    await writeStatus(config, 'running', 'navigate', 'opening conversation');
    if (config.conversationUrl) {
      await navigateToChat(page, config.conversationUrl);
    }

    try {
      await waitForPromptInput(page);
    } catch (error) {
      await captureDebugArtifacts(page, config, logger, 'prompt-input');
      throw error;
    }

    if (!(await promptAlreadySubmitted(page, config.prompt))) {
      await writeStatus(config, 'running', 'submit', 'submitting prompt');
      const typedValue = await submitPrompt(page, config.prompt);
      if (typedValue.trim() !== config.prompt.trim()) {
        logger(`[prompt] mismatch typed="${typedValue}" expected="${config.prompt}"`);
      }
      const submitted = await waitForUserMessage(page, config.prompt, 8_000);
      if (!submitted) {
        logger('[prompt] user message not detected; retrying submit');
        await submitPrompt(page, config.prompt);
      }
      await sleep(1000);
      await maybeCaptureConversationUrl(page, config);
      await saveRunConfig(config.runPath, config);
    }

    await writeStatus(config, 'running', 'waiting', 'awaiting response');
    const completion = await waitForCompletionWithCancel(page, config, runDir);

    if (
      config.baseUrl.includes('127.0.0.1') ||
      config.baseUrl.includes('localhost') ||
      process.env.ORACLE_CAPTURE_HTML === '1'
    ) {
      await captureDebugArtifacts(page, config, logger, 'completion');
    }

    config.conversationUrl = completion.conversationUrl;
    config.lastAssistantIndex = completion.assistantIndex;
    await saveRunConfig(config.runPath, config);

    await writeStatus(config, 'running', 'extract', 'writing result');
    await saveResultMarkdown(config.resultPath, completion.content);
    await saveResultJson(config.resultJsonPath, {
      runId: config.runId,
      state: 'completed',
      completedAt: nowIso(),
      conversationUrl: completion.conversationUrl,
      content: completion.content,
    });

    await writeStatus(config, 'completed', 'cleanup', 'completed');
    logger(`[worker] completed run ${config.runId}`);
    await browser.close();
    return 'completed';
  } catch (error) {
    if (error instanceof NeedsUserError) {
      return 'needs_user';
    }
    if (error instanceof CancelError) {
      await finalizeCanceled(config, logger, 'Canceled by user');
      return 'completed';
    }
    if (shouldRequestProfileAssistance(error, config)) {
      await writeNeedsUser(
        config,
        'profile',
        'System Chrome profile failed to start debug port. Use --user-data-dir ~/.oracle/chrome or pre-launch Chrome with --remote-debugging-port, then resume.',
        'launch',
      );
      return 'needs_user';
    }
    logger(`[worker] runAttempt error: ${String(error)}`);
    try {
      await attemptRecovery(config, browser, page, logger, runDir);
    } catch (recoveryError) {
      if (recoveryError instanceof NeedsUserError) {
        return 'needs_user';
      }
      throw recoveryError;
    }
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        logger(`[worker] browser close failed: ${String(closeError)}`);
      }
    }
  }
}

async function attemptRecovery(
  config: RunConfig,
  browser: import('puppeteer').Browser | null,
  page: import('puppeteer').Page | null,
  logger: (msg: string) => void,
  runDir: string,
): Promise<void> {
  if (await isCanceled(runDir)) {
    await finalizeCanceled(config, logger, 'Canceled during run');
    return;
  }
  if (!browser || !page) return;

  logger('[recovery] health check');
  const debug = config.debugPort ? await checkDebugEndpoint(config.debugPort) : { ok: true };
  const runtime = await checkBrowserRuntime(browser);
  const pageHealth = await checkPageResponsive(page);

  logger(`[recovery] debug=${debug.ok} runtime=${runtime.ok} page=${pageHealth.ok}`);
  if (debug.ok) {
    try {
      await page.evaluate(() => window.stop());
      await page.reload({ waitUntil: 'domcontentloaded' });
      logger('[recovery] reload ok');
    } catch (error) {
      logger(`[recovery] reload failed: ${String(error)}`);
    }
    return;
  }

  if (!config.allowKill) {
    await writeNeedsUser(config, 'kill_chrome', 'Chrome debug endpoint unreachable; allow-kill required to restart');
    throw new NeedsUserError('kill_chrome', 'Chrome stuck; requires user approval');
  }

  if (config.browserPid) {
    logger(`[recovery] killing chrome pid ${config.browserPid}`);
    try {
      process.kill(config.browserPid, 'SIGKILL');
    } catch (error) {
      logger(`[recovery] kill failed: ${String(error)}`);
    }
  }

  if (config.browser === 'chrome') {
    await openDefaultChrome(logger);
  }
}

async function openDefaultChrome(logger: (msg: string) => void): Promise<void> {
  logger('[recovery] opening default Chrome for user');
  const { spawn } = await import('child_process');
  spawn('open', ['-a', 'Google Chrome'], { stdio: 'ignore', detached: true }).unref();
}

async function writeStatus(config: RunConfig, state: StatusPayload['state'], stage: StatusPayload['stage'], message?: string): Promise<void> {
  await saveStatus(config.statusPath, {
    runId: config.runId,
    state,
    stage,
    message,
    updatedAt: nowIso(),
    attempt: config.attempt,
    conversationUrl: config.conversationUrl,
  });
}

async function writeNeedsUser(
  config: RunConfig,
  type: NonNullable<StatusPayload['needs']>['type'],
  details: string,
  stage: StatusPayload['stage'] = 'login',
): Promise<void> {
  await saveStatus(config.statusPath, {
    runId: config.runId,
    state: 'needs_user',
    stage,
    message: details,
    updatedAt: nowIso(),
    attempt: config.attempt,
    conversationUrl: config.conversationUrl,
    needs: { type, details },
  });
}

async function navigateWithFallback(page: import('puppeteer').Page, baseUrl: string): Promise<void> {
  try {
    await navigateToChat(page, baseUrl);
  } catch (error) {
    if (baseUrl !== DEFAULT_BASE_URL) throw error;
    await navigateToChat(page, FALLBACK_BASE_URL);
  }
}

async function promptAlreadySubmitted(page: import('puppeteer').Page, prompt: string): Promise<boolean> {
  const trimmed = prompt.trim();
  return page.evaluate((needle) => {
    const nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"]')) as HTMLElement[];
    if (nodes.length) {
      return nodes.some((node) => (node.innerText || '').trim() === needle);
    }
    const main = (document.querySelector('main') as HTMLElement | null) ?? (document.querySelector('[role="main"]') as HTMLElement | null);
    const haystack = (main?.innerText ?? document.body?.innerText ?? '').trim();
    return haystack.includes(needle);
  }, trimmed);
}

async function captureDebugArtifacts(
  page: import('puppeteer').Page,
  config: RunConfig,
  logger: (msg: string) => void,
  label: string,
): Promise<void> {
  try {
    const debugDir = path.join(config.outDir, 'debug');
    await fs.promises.mkdir(debugDir, { recursive: true });
    const html = await page.content().catch(() => '');
    const url = page.url();
    const meta = { url, capturedAt: nowIso(), label };
    await fs.promises.writeFile(path.join(debugDir, `${label}.html`), html, 'utf8');
    await fs.promises.writeFile(path.join(debugDir, `${label}.json`), JSON.stringify(meta, null, 2), 'utf8');
    await page.screenshot({ path: path.join(debugDir, `${label}.png`) }).catch(() => null);
    const diagnostics = await page
      .evaluate(() => {
        const main = document.querySelector('main') as HTMLElement | null;
        const roleMain = document.querySelector('[role="main"]') as HTMLElement | null;
        const testIds = Array.from(document.querySelectorAll('[data-testid]'))
          .map((el) => el.getAttribute('data-testid') || '')
          .filter(Boolean);
        const testIdCounts: Record<string, number> = {};
        for (const id of testIds) {
          testIdCounts[id] = (testIdCounts[id] ?? 0) + 1;
        }
        const topTestIds = Object.entries(testIdCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40)
          .map(([id, count]) => ({ id, count }));
        const buttonLabels = Array.from(document.querySelectorAll('button'))
          .map((button) => (button as HTMLButtonElement).innerText.trim())
          .filter(Boolean)
          .slice(0, 40);
        return {
          title: document.title,
          url: window.location.href,
          mainText: main?.innerText ?? '',
          roleMainText: roleMain?.innerText ?? '',
          bodyText: document.body?.innerText ?? '',
          articleCount: document.querySelectorAll('article').length,
          messageAuthorCount: document.querySelectorAll('[data-message-author-role]').length,
          topTestIds,
          buttonLabels,
        };
      })
      .catch(() => null);
    if (diagnostics) {
      const { mainText, roleMainText, bodyText, ...rest } = diagnostics;
      await fs.promises.writeFile(
        path.join(debugDir, `${label}-diagnostics.json`),
        JSON.stringify(rest, null, 2),
        'utf8',
      );
      if (mainText) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-main.txt`),
          truncateText(mainText, 20000),
          'utf8',
        );
      }
      if (roleMainText) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-role-main.txt`),
          truncateText(roleMainText, 20000),
          'utf8',
        );
      }
      if (bodyText) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-body.txt`),
          truncateText(bodyText, 40000),
          'utf8',
        );
      }
    }
    if (label === 'completion') {
      const messageHtml = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')) as HTMLElement[];
        const last = nodes[nodes.length - 1];
        return last?.outerHTML ?? '';
      });
      if (messageHtml) {
        await fs.promises.writeFile(path.join(debugDir, `${label}-assistant.html`), messageHtml, 'utf8');
      }
      const conversation = await page.evaluate(async () => {
        const match = window.location.pathname.match(/\/c\/([a-z0-9-]+)/i);
        if (!match) return null;
        const response = await fetch(`/backend-api/conversation/${match[1]}`, { credentials: 'include' });
        if (!response.ok) return { status: response.status };
        return await response.json();
      });
      if (conversation) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-conversation.json`),
          JSON.stringify(conversation, null, 2),
          'utf8',
        );
      }
    }
  } catch (error) {
    logger(`[debug] capture failed: ${String(error)}`);
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

async function maybeCaptureConversationUrl(page: import('puppeteer').Page, config: RunConfig): Promise<void> {
  const url = page.url();
  if (url.includes('/c/') || url.includes('/chat/') || url.includes('/conversation/')) {
    config.conversationUrl = url;
  }
}

function attachNetworkTracing(page: import('puppeteer').Page, logger: (msg: string) => void): void {
  if (process.env.ORACLE_TRACE_NETWORK !== '1') return;
  const shouldLog = (url: string) => /backend-api|conversation|event-stream/i.test(url);
  page.on('response', (response) => {
    const url = response.url();
    if (!shouldLog(url)) return;
    const method = response.request().method();
    const status = response.status();
    logger(`[net] ${status} ${method} ${url}`);
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!shouldLog(url)) return;
    logger(`[net] failed ${request.method()} ${url} ${request.failure()?.errorText ?? ''}`.trim());
  });
}

async function injectTextDocsCapture(page: import('puppeteer').Page, logger: (msg: string) => void): Promise<void> {
  const script = () => {
    const globalAny = window as any;
    if (globalAny.__oracleFetchPatched) return;
    globalAny.__oracleFetchPatched = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      try {
        const input = args[0] as any;
        const url = typeof input === 'string' ? input : input?.url ?? '';
        if (url.includes('/textdocs')) {
          const clone = response.clone();
          clone
            .json()
            .then((data) => {
              globalAny.__oracleTextDocs = data;
              globalAny.__oracleTextDocsUrl = url;
              globalAny.__oracleTextDocsAt = Date.now();
            })
            .catch(() => null);
        }
      } catch {
        return response;
      }
      return response;
    };
  };
  try {
    await page.evaluateOnNewDocument(script);
    await page.evaluate(script);
  } catch (error) {
    logger(`[debug] inject textdocs capture failed: ${String(error)}`);
  }
}

async function waitForCompletionWithCancel(
  page: import('puppeteer').Page,
  config: RunConfig,
  runDir: string,
): Promise<import('./browser/chatgpt.js').WaitForCompletionResult> {
  let done = false;
  const cancelWatcher = (async () => {
    while (!done) {
      if (await isCanceled(runDir)) {
        throw new CancelError('Canceled by user');
      }
      await sleep(1000);
    }
    return null as never;
  })();

  try {
    return await Promise.race([
      waitForCompletion(page, {
        timeoutMs: config.timeoutMs,
        stableMs: config.stableMs,
        stallMs: config.stallMs,
        pollMs: config.pollMs,
        prompt: config.prompt,
      }),
      cancelWatcher,
    ]);
  } finally {
    done = true;
  }
}

async function isCanceled(runDir: string): Promise<boolean> {
  return pathExists(path.join(runDir, CANCEL_FILE));
}

async function finalizeCanceled(config: RunConfig, logger: (msg: string) => void, message: string): Promise<void> {
  await saveResultJson(config.resultJsonPath, {
    runId: config.runId,
    state: 'canceled',
    completedAt: nowIso(),
    conversationUrl: config.conversationUrl,
    error: message,
  });
  await writeStatus(config, 'canceled', 'cleanup', message);
  logger(`[worker] canceled: ${message}`);
}

async function finalizeFailed(config: RunConfig, logger: (msg: string) => void, message: string): Promise<void> {
  await saveResultJson(config.resultJsonPath, {
    runId: config.runId,
    state: 'failed',
    completedAt: nowIso(),
    conversationUrl: config.conversationUrl,
    error: message,
  });
  await writeStatus(config, 'failed', 'cleanup', message);
  logger(`[worker] failed: ${message}`);
}

function parseArgs(argv: string[]): { runDir?: string } {
  const args: { runDir?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--run-dir') {
      args.runDir = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function shouldRequestProfileAssistance(error: unknown, config: RunConfig): boolean {
  if (config.browser !== 'chrome') return false;
  if (!isSystemChromeProfile(config.profile.userDataDir)) return false;
  if (!(error instanceof Error)) return false;
  return /Chrome debug endpoint failed to start/i.test(error.message);
}

function isSystemChromeProfile(userDataDir: string): boolean {
  const normalized = path.resolve(userDataDir);
  const systemDir = path.resolve(chromeUserDataDirMac());
  return normalized === systemDir;
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});
