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
  waitForCompletion,
  waitForPromptInput,
} from './browser/chatgpt.js';
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
      await sleep(1000);
      await maybeCaptureConversationUrl(page, config);
      await saveRunConfig(config.runPath, config);
    }

    await writeStatus(config, 'running', 'waiting', 'awaiting response');
    const completion = await waitForCompletion(page, {
      timeoutMs: config.timeoutMs,
      stableMs: config.stableMs,
      stallMs: config.stallMs,
      pollMs: config.pollMs,
    });

    if (config.baseUrl.includes('127.0.0.1') || config.baseUrl.includes('localhost')) {
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
): Promise<void> {
  await saveStatus(config.statusPath, {
    runId: config.runId,
    state: 'needs_user',
    stage: 'login',
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
    return nodes.some((node) => (node.innerText || '').trim() === needle);
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
  } catch (error) {
    logger(`[debug] capture failed: ${String(error)}`);
  }
}

async function maybeCaptureConversationUrl(page: import('puppeteer').Page, config: RunConfig): Promise<void> {
  const url = page.url();
  if (url.includes('/c/') || url.includes('/chat/') || url.includes('/conversation/')) {
    config.conversationUrl = url;
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

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});
