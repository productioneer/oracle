import fs from "fs";
import path from "path";
import { launchChrome, createHiddenPage } from "./browser/chrome.js";
import {
  launchFirefox,
  FirefoxProfileInUseError,
  cleanupAutomationProfile,
} from "./browser/firefox.js";
import { resolveFirefoxApp } from "./browser/firefox-app.js";
import {
  applyFocusStrategy,
  FIREFOX_SETUP_DELAY_MS,
  resizeFirefoxWindow,
  runFirefoxSetupPhase,
} from "./browser/focus.js";
import {
  checkBrowserRuntime,
  checkDebugEndpoint,
  checkPageResponsive,
} from "./browser/health.js";
import { oracleChromeDataDir } from "./browser/profiles.js";
import {
  isPersonalChromeRunning,
  listPersonalChromePids,
  openPersonalChrome,
  shouldRestartPersonalChrome,
  waitForPersonalChromeExit,
} from "./browser/personal-chrome.js";
import {
  markChromeRestartDone,
  waitForChromeRestartApproval,
} from "./notifications/chrome-restart.js";
import {
  DEFAULT_BASE_URL,
  ensureChatGptReady,
  ensureModelSelected,
  ensureWideViewport,
  getNextUserTurnNumber,
  isGenerating,
  navigateToChat,
  ResponseFailedError,
  ResponseStalledError,
  ResponseTimeoutError,
  setThinkingMode,
  submitPrompt,
  waitForIdle,
  waitForUserMessage,
  waitForCompletion,
  waitForPromptInput,
  waitForThinkingPanel,
} from "./browser/chatgpt.js";
import { uploadAttachments } from "./browser/attachments.js";
import {
  saveResultJson,
  saveResultMarkdown,
  saveRunConfig,
  saveStatus,
} from "./run/state.js";
import type { RunConfig, StatusPayload } from "./run/types.js";
import { readJson, pathExists } from "./utils/fs.js";
import { createLogger } from "./utils/log.js";
import { isDetachedFrameError } from "./utils/errors.js";
import { nowIso, sleep } from "./utils/time.js";

const CANCEL_FILE = "cancel.json";
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
    throw new Error("worker requires --run-dir");
  }
  const runPath = path.join(args.runDir, "run.json");
  const config = await readJson<RunConfig>(runPath);
  config.thinking = config.thinking ?? "extended";
  const logger = await createLogger(config.logPath);

  logger(`[worker] start run ${config.runId}`);
  config.startedAt = config.startedAt ?? nowIso();
  await saveRunConfig(config.runPath, config);
  await writeStatus(config, "starting", "init", "worker starting");

  if (await isCanceled(args.runDir)) {
    await finalizeCanceled(config, logger, "Canceled before start");
    return;
  }

  let recoveryRetries = 0;
  for (
    let attempt = config.attempt;
    attempt <= config.maxAttempts;
    attempt += 1
  ) {
    config.attempt = attempt;
    await saveRunConfig(config.runPath, config);
    await writeStatus(
      config,
      "running",
      "launch",
      `attempt ${attempt} launching browser`,
    );

    try {
      const result = await runAttempt(config, logger, args.runDir, recoveryRetries);
      if (result === "needs_user") return;
      if (result === "retry") {
        recoveryRetries += 1;
        if (recoveryRetries > 1) {
          throw new Error("Recovery retry limit exceeded");
        }
        attempt -= 1;
        continue;
      }
      if (result === "completed") return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`[worker] attempt ${attempt} error: ${message}`);
      config.lastError = message;
      await saveRunConfig(config.runPath, config);
      await writeStatus(
        config,
        "running",
        "cleanup",
        `attempt ${attempt} failed: ${message}`,
      );
      if (attempt >= config.maxAttempts) {
        await finalizeFailed(config, logger, message);
        return;
      }
      await sleep(2000);
    }
  }
}

async function runAttempt(
  config: RunConfig,
  logger: (msg: string) => void,
  runDir: string,
  recoveryAttempt: number,
): Promise<"completed" | "needs_user" | "retry"> {
  let browser: import("playwright").Browser | null = null;
  let page: import("playwright").Page | null = null;
  let firefoxServer: import("playwright").BrowserServer | undefined;
  let keepFirefoxAlive = false;
  let chromeReused = false;
  let firefoxApp = config.firefoxApp;
  if (config.browser === "firefox" && process.platform === "darwin") {
    try {
      firefoxApp = firefoxApp ?? resolveFirefoxApp();
      if (firefoxApp && !config.firefoxApp) {
        config.firefoxApp = firefoxApp;
        await saveRunConfig(config.runPath, config);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeNeedsUser(config, "firefox_app", message, "launch");
      throw new NeedsUserError("firefox_app", message);
    }
  }
  const appName =
    config.browser === "firefox"
      ? (firefoxApp?.appName ?? "Firefox")
      : "Google Chrome";
  let firefoxPid: number | undefined;
  try {
    if (config.browser === "chrome") {
      const connection = await launchChrome({
        userDataDir: config.profile.userDataDir,
        profileDir: config.profile.profileDir,
        debugPort: config.debugPort,
        allowVisible: config.allowVisible,
        logger,
      });
      browser = connection.browser;
      chromeReused = connection.reused;
      config.debugPort = connection.debugPort;
      config.browserPid = connection.browserPid;
      await saveRunConfig(config.runPath, config);
      page = await createHiddenPage(browser, config.runId, {
        allowVisible: config.allowVisible,
        logger,
      });
    } else {
      let connection: Awaited<ReturnType<typeof launchFirefox>>;
      try {
        connection = await launchFirefox({
          profilePath: config.profile.profileDir ?? config.profile.userDataDir,
          allowVisible: config.allowVisible,
          reuse: config.focusOnly ? false : !config.allowVisible,
          executablePath: firefoxApp?.executablePath,
          appPath: firefoxApp?.appPath,
          logger,
        });
      } catch (error) {
        if (error instanceof FirefoxProfileInUseError) {
          await writeNeedsUser(config, "profile", error.message, "launch");
          throw new NeedsUserError("profile", error.message);
        }
        throw error;
      }
      browser = connection.browser;
      keepFirefoxAlive = connection.keepAlive;
      firefoxPid = connection.pid;
      firefoxServer = connection.server;
      const setup = config.allowVisible
        ? null
        : await runFirefoxSetupPhase(appName, firefoxPid, logger);
      if (setup?.focus) {
        config.focus = setup.focus;
      } else {
        const focusStatus = await applyFocusStrategy({
          browser: config.browser,
          allowVisible: config.allowVisible,
          appName,
          pid: firefoxPid,
          logger,
        });
        if (focusStatus) {
          config.focus = focusStatus;
        }
      }
      if (!firefoxPid && !config.allowVisible) {
        config.focus = config.focus ?? {
          state: "visible",
          reason: "pid-mismatch",
        };
      }
      if (config.focus) {
        await saveRunConfig(config.runPath, config);
        const focusMessage = buildFocusMessage(
          config.focus,
          config.allowVisible,
        );
        if (focusMessage) {
          await writeStatus(config, "running", "launch", focusMessage);
        }
      }
      if (!config.allowVisible) {
        await sleep(FIREFOX_SETUP_DELAY_MS);
      }
      if (config.focusOnly) {
        await finalizeFocusOnly(config, logger, "focus-only completed");
        return "completed";
      }
      if (!config.allowVisible) {
        const resizeWork = await resizeFirefoxWindow(
          appName,
          firefoxPid,
          "work",
          logger,
        );
        mergeFocusNeeds(config, resizeWork.needsUser);
        if (resizeWork.reason === "window-mismatch" && !config.allowVisible) {
          config.focus = config.focus ?? {
            state: "visible",
            reason: "window-mismatch",
          };
        }
        if (resizeWork.needsUser) {
          await saveRunConfig(config.runPath, config);
        }
      }
      const context = browser.contexts()[0] ?? (await browser.newContext());
      page = await context.newPage();
    }
    if (config.browser === "chrome") {
      const focusStatus = await applyFocusStrategy({
        browser: config.browser,
        allowVisible: config.allowVisible,
        appName,
        logger,
      });
      if (focusStatus) {
        config.focus = focusStatus;
        await saveRunConfig(config.runPath, config);
        const focusMessage = buildFocusMessage(
          focusStatus,
          config.allowVisible,
        );
        if (focusMessage) {
          await writeStatus(config, "running", "launch", focusMessage);
        }
      }
    }
    if (!page) {
      throw new Error("Failed to create browser page");
    }
    await ensureWideViewport(page);
    attachNetworkTracing(page, logger);
    await injectTextDocsCapture(page, logger);

    if (config.focusOnly) {
      await finalizeFocusOnly(config, logger, "focus-only completed");
      return "completed";
    }

    await writeStatus(config, "running", "login", "navigating to ChatGPT");
    assertChatGptUrl(config.baseUrl, "baseUrl");
    if (config.conversationUrl) {
      assertChatGptUrl(config.conversationUrl, "conversationUrl");
    }
    const targetUrl = config.conversationUrl ?? config.baseUrl;
    await navigateToChat(page, targetUrl);
    await ensureWideViewport(page);

    if (!page) {
      throw new Error("Browser page unavailable");
    }
    for (let pageAttempt = 0; pageAttempt < 2; pageAttempt += 1) {
      try {
        const ready = await ensureChatGptReady(page, logger);
        if (!ready.ok && ready.reason === "cloudflare") {
          await writeNeedsUser(
            config,
            "cloudflare",
            ready.message ?? "Cloudflare challenge detected",
          );
          return "needs_user";
        }
        if (!ready.ok) {
          await writeNeedsUser(config, "login", ready.message ?? "Login required");
          return "needs_user";
        }

        await writeStatus(config, "running", "navigate", "checking model");
        await ensureModelSelected(page, logger);

        try {
          await waitForPromptInput(page, 30_000, logger);
        } catch (error) {
          await captureDebugArtifacts(page, config, logger, "prompt-input");
          throw error;
        }
        await ensureWideViewport(page);

        if (config.thinking) {
          try {
            const updated = await setThinkingMode(page, config.thinking);
            if (!updated) {
              logger("[thinking] toggle not available");
            }
          } catch (error) {
            logger(`[thinking] toggle failed: ${String(error)}`);
          }
        }

        const alreadySubmitted = await promptAlreadySubmitted(
          page,
          config.prompt,
        );
        if (!alreadySubmitted) {
          if (config.conversationUrl) {
            const generating = await isGenerating(page);
            if (generating) {
              throw new Error(
                "Previous response still generating. Wait for completion or cancel before sending follow-up.",
              );
            }
          } else {
            try {
              await waitForIdle(page, {
                timeoutMs: config.timeoutMs,
                pollMs: Math.min(config.pollMs, 1000),
              });
            } catch (error) {
              logger(`[prompt] idle wait failed: ${String(error)}`);
              throw error;
            }
          }
          // Upload attachments if any
          if (config.attachments && config.attachments.length > 0) {
            await writeStatus(
              config,
              "running",
              "submit",
              `uploading ${config.attachments.length} file(s)`,
            );
            try {
              await uploadAttachments(page, config.attachments, logger);
              logger(
                `[attachments] uploaded ${config.attachments.length} file(s)`,
              );
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger(`[attachments] upload failed: ${message}`);
              throw error;
            }
          }

          await writeStatus(config, "running", "submit", "submitting prompt");
          const expectedTurn = await getNextUserTurnNumber(page);
          const typedValue = await submitPrompt(page, config.prompt, logger);
          if (typedValue.trim() !== config.prompt.trim()) {
            logger(
              `[prompt] mismatch typed="${typedValue}" expected="${config.prompt}"`,
            );
          }
          const submitted = await waitForUserMessage(
            page,
            config.prompt,
            expectedTurn,
            8_000,
          );
          if (!submitted) {
            logger("[prompt] user message not detected; retrying submit");
            await submitPrompt(page, config.prompt, logger);
          }
          await sleep(1000);
          await maybeCaptureConversationUrl(page, config);
          await saveRunConfig(config.runPath, config);
          await waitForThinkingPanel(page, logger);
        }

        await writeStatus(config, "running", "waiting", "awaiting response");
        const completion = await waitForCompletionWithCancel(
          page,
          config,
          runDir,
          logger,
        );

        if (
          config.baseUrl.includes("127.0.0.1") ||
          config.baseUrl.includes("localhost") ||
          process.env.ORACLE_CAPTURE_HTML === "1"
        ) {
          await captureDebugArtifacts(page, config, logger, "completion");
        }

        config.conversationUrl = completion.conversationUrl;
        config.lastAssistantIndex = completion.assistantIndex;
        await saveRunConfig(config.runPath, config);

        await writeStatus(config, "running", "extract", "writing result");
        await saveResultMarkdown(config.resultPath, completion.content);
        await saveResultJson(config.resultJsonPath, {
          runId: config.runId,
          state: "completed",
          completedAt: nowIso(),
          conversationUrl: completion.conversationUrl,
          content: completion.content,
        });

        await writeStatus(config, "completed", "cleanup", "completed");
        logger(`[worker] completed run ${config.runId}`);
        return "completed";
      } catch (error) {
        if (!isDetachedFrameError(error) || pageAttempt >= 1 || !browser) {
          throw error;
        }
        logger(
          `[worker] detached frame detected; recreating page (${pageAttempt + 1}/2)`,
        );
        if (page) {
          try {
            await page.close();
          } catch (closeError) {
            logger(`[worker] page close failed: ${String(closeError)}`);
          }
        }
        page =
          config.browser === "chrome"
            ? await createHiddenPage(browser, config.runId, {
                allowVisible: config.allowVisible,
                logger,
              })
            : await (async () => {
                const context =
                  browser.contexts()[0] ?? (await browser.newContext());
                return context.newPage();
              })();
      }
    }
    throw new Error("Detached frame retry limit exceeded");
  } catch (error) {
    if (error instanceof NeedsUserError) {
      return "needs_user";
    }
    if (error instanceof CancelError) {
      await finalizeCanceled(config, logger, "Canceled by user");
      return "completed";
    }
    logger(`[worker] runAttempt error: ${String(error)}`);
    try {
      const recovered = await attemptRecovery(
        config,
        browser,
        page,
        logger,
        runDir,
        recoveryAttempt > 0,
      );
      if (recovered) {
        return "retry";
      }
    } catch (recoveryError) {
      if (recoveryError instanceof NeedsUserError) {
        return "needs_user";
      }
      throw recoveryError;
    }
    throw error;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (closeError) {
        logger(`[worker] page close failed: ${String(closeError)}`);
      }
    }
    if (browser) {
      try {
        const keepAlive = config.browser === "firefox" && keepFirefoxAlive;
        if (config.browser === "firefox" && keepAlive) {
          if (!config.allowVisible) {
            await runFirefoxSetupPhase(appName, firefoxPid, logger);
          }
          await disconnectBrowser(browser);
        } else if (config.browser === "chrome" && chromeReused) {
          await disconnectBrowser(browser);
        } else {
          await browser.close();
          if (config.browser === "firefox" && firefoxServer) {
            await firefoxServer.close().catch(() => null);
          }
        }
      } catch (closeError) {
        logger(`[worker] browser close failed: ${String(closeError)}`);
      }
    }
    if (config.browser === "firefox" && config.focusOnly && !keepFirefoxAlive) {
      await cleanupAutomationProfile(
        config.profile.profileDir ?? config.profile.userDataDir,
        logger,
      );
    }
  }
}

async function attemptRecovery(
  config: RunConfig,
  browser: import("playwright").Browser | null,
  page: import("playwright").Page | null,
  logger: (msg: string) => void,
  runDir: string,
  allowPersonalRestart: boolean,
): Promise<boolean> {
  if (await isCanceled(runDir)) {
    await finalizeCanceled(config, logger, "Canceled during run");
    return false;
  }
  if (!browser || !page) return false;

  await writeStatus(config, "running", "recovery", "checking browser health");
  logger("[recovery] health check");
  const debug = config.debugPort
    ? await checkDebugEndpoint(config.debugPort)
    : { ok: true };
  const runtime = await checkBrowserRuntime(browser);
  const pageHealth = await checkPageResponsive(page);

  logger(
    `[recovery] debug=${debug.ok} runtime=${runtime.ok} page=${pageHealth.ok}`,
  );
  if (debug.ok) {
    try {
      await page.evaluate(() => window.stop());
      await page.reload({ waitUntil: "domcontentloaded" });
      logger("[recovery] reload ok");
    } catch (error) {
      logger(`[recovery] reload failed: ${String(error)}`);
    }
    if (runtime.ok && pageHealth.ok) {
      return false;
    }
    const postRuntime = await checkBrowserRuntime(browser);
    const postPage = await checkPageResponsive(page);
    logger(
      `[recovery] post-reload runtime=${postRuntime.ok} page=${postPage.ok}`,
    );
    if (postRuntime.ok && postPage.ok) {
      return false;
    }
  }

  if (config.browser !== "chrome") {
    return false;
  }

  const oracleUserDataDir = oracleChromeDataDir();
  const personalRunning = allowPersonalRestart
    ? await isPersonalChromeRunning(oracleUserDataDir)
    : false;
  let approval:
    | { action: "restart"; approvedAt?: number }
    | { action: "done" }
    | { action: "canceled" }
    | null = null;
  if (allowPersonalRestart && personalRunning) {
    const reason = debug.ok
      ? "Personal Chrome unresponsive; approval required to restart"
      : "Personal Chrome debug endpoint unreachable; approval required to restart";
    await writeNeedsUser(
      config,
      "chrome_restart_approval",
      reason,
      "recovery",
    );
    approval = await waitForChromeRestartApproval({
      runId: config.runId,
      notifyTitle: "Approve personal Chrome restart",
      notifyMessage: `Oracle run ${config.runId} needs to restart your personal Chrome to continue.`,
      logger,
      onStatus: async (message) => {
        await writeNeedsUser(
          config,
          "chrome_restart_approval",
          message,
          "recovery",
        );
      },
      isCanceled: async () => isCanceled(runDir),
    });
    if (approval.action === "canceled") {
      throw new CancelError("Canceled by user");
    }
    if (approval.action === "done") {
      logger("[recovery] personal chrome restart already completed by another run");
      return true;
    }
  }
  await writeStatus(
    config,
    "running",
    "recovery",
    "Chrome stuck; restarting browser",
  );

  let terminated = true;
  if (config.browserPid) {
    const pid = config.browserPid;
    logger(`[recovery] attempting graceful shutdown for chrome pid ${pid}`);
    terminated = await shutdownChromePid(
      pid,
      logger,
      10_000,
      process.env.ORACLE_FORCE_KILL === "1",
    );
    if (!terminated) {
      logger(
        `[recovery] chrome pid ${pid} did not exit after graceful shutdown`,
      );
    }
  }

  if (!terminated) {
    if (allowPersonalRestart && personalRunning) {
      await writeNeedsUser(
        config,
        "chrome_restart_approval",
        "Personal Chrome restart failed; allow-kill required to force quit",
        "recovery",
      );
      throw new NeedsUserError("chrome_restart_approval", "Chrome restart failed");
    }
    throw new Error("Chrome restart failed");
  }
  if (approval && approval.action === "restart") {
    const personalPidsBefore = await listPersonalChromePids(oracleUserDataDir);
    if (personalPidsBefore.length) {
      for (const pid of personalPidsBefore) {
        logger(
          `[recovery] attempting graceful shutdown for personal chrome pid ${pid}`,
        );
        const graceful = await shutdownChromePid(pid, logger, 8_000, false);
        if (!graceful) {
          logger(
            `[recovery] personal chrome pid ${pid} still alive after graceful shutdown; forcing kill`,
          );
          await shutdownChromePid(pid, logger, 0, true);
        }
      }
    }
    await waitForPersonalChromeExit(oracleUserDataDir, 8_000);
    const personalPidsAfter = await listPersonalChromePids(oracleUserDataDir);
    if (shouldRestartPersonalChrome(personalPidsBefore, personalPidsAfter)) {
      try {
        await openPersonalChrome(logger);
      } catch (error) {
        logger(`[recovery] failed to reopen personal chrome: ${String(error)}`);
      }
    }
    await markChromeRestartDone({
      approvedAt: approval.approvedAt,
    });
  }
  return true;
}

async function shutdownChromePid(
  pid: number,
  logger: (msg: string) => void,
  timeoutMs = 10_000,
  forceKill = false,
): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    logger(`[recovery] graceful shutdown failed: ${String(error)}`);
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(250);
  }
  if (!forceKill) {
    logger("[recovery] chrome pid still alive; skipping SIGKILL (ORACLE_FORCE_KILL=1 to enable)");
    return false;
  }
  logger(`[recovery] force killing chrome pid ${pid}`);
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    logger(`[recovery] force kill failed: ${String(error)}`);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeStatus(
  config: RunConfig,
  state: StatusPayload["state"],
  stage: StatusPayload["stage"],
  message?: string,
): Promise<void> {
  await saveStatus(config.statusPath, {
    runId: config.runId,
    state,
    stage,
    message,
    updatedAt: nowIso(),
    attempt: config.attempt,
    conversationUrl: config.conversationUrl,
    focus: config.focus,
  });
}

async function writeNeedsUser(
  config: RunConfig,
  type: NonNullable<StatusPayload["needs"]>["type"],
  details: string,
  stage: StatusPayload["stage"] = "login",
): Promise<void> {
  await saveStatus(config.statusPath, {
    runId: config.runId,
    state: "needs_user",
    stage,
    message: details,
    updatedAt: nowIso(),
    attempt: config.attempt,
    conversationUrl: config.conversationUrl,
    needs: { type, details },
    focus: config.focus,
  });
}

async function promptAlreadySubmitted(
  page: import("playwright").Page,
  prompt: string,
): Promise<boolean> {
  const trimmed = prompt.trim();
  return page.evaluate((needle) => {
    const nodes = Array.from(
      document.querySelectorAll('[data-message-author-role="user"]'),
    ) as HTMLElement[];
    return nodes.some((node) => (node.innerText || "").trim() === needle);
  }, trimmed);
}

function assertChatGptUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${label} URL: ${url}`);
  }
  if (parsed.origin !== "https://chatgpt.com") {
    throw new Error(
      `Unsupported ${label} URL (${url}). Only https://chatgpt.com/ is supported.`,
    );
  }
}

async function captureDebugArtifacts(
  page: import("playwright").Page,
  config: RunConfig,
  logger: (msg: string) => void,
  label: string,
): Promise<void> {
  try {
    const debugDir = path.join(config.outDir, "debug");
    await fs.promises.mkdir(debugDir, { recursive: true });
    const html = await page.content().catch(() => "");
    const url = page.url();
    const meta = { url, capturedAt: nowIso(), label };
    await fs.promises.writeFile(
      path.join(debugDir, `${label}.html`),
      html,
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(debugDir, `${label}.json`),
      JSON.stringify(meta, null, 2),
      "utf8",
    );
    await page
      .screenshot({ path: path.join(debugDir, `${label}.png`) })
      .catch(() => null);
    const diagnostics = await page
      .evaluate(() => {
        const main = document.querySelector("main") as HTMLElement | null;
        const roleMain = document.querySelector(
          '[role="main"]',
        ) as HTMLElement | null;
        const testIds = Array.from(document.querySelectorAll("[data-testid]"))
          .map((el) => el.getAttribute("data-testid") || "")
          .filter(Boolean);
        const testIdCounts: Record<string, number> = {};
        for (const id of testIds) {
          testIdCounts[id] = (testIdCounts[id] ?? 0) + 1;
        }
        const topTestIds = Object.entries(testIdCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40)
          .map(([id, count]) => ({ id, count }));
        const buttonLabels = Array.from(document.querySelectorAll("button"))
          .map((button) => (button as HTMLButtonElement).innerText.trim())
          .filter(Boolean)
          .slice(0, 40);
        return {
          title: document.title,
          url: window.location.href,
          mainText: main?.innerText ?? "",
          roleMainText: roleMain?.innerText ?? "",
          bodyText: document.body?.innerText ?? "",
          articleCount: document.querySelectorAll("article").length,
          messageAuthorCount: document.querySelectorAll(
            "[data-message-author-role]",
          ).length,
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
        "utf8",
      );
      if (mainText) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-main.txt`),
          truncateText(mainText, 20000),
          "utf8",
        );
      }
      if (roleMainText) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-role-main.txt`),
          truncateText(roleMainText, 20000),
          "utf8",
        );
      }
      if (bodyText) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-body.txt`),
          truncateText(bodyText, 40000),
          "utf8",
        );
      }
    }
    if (label === "completion") {
      const messageHtml = await page.evaluate(() => {
        const nodes = Array.from(
          document.querySelectorAll('[data-message-author-role="assistant"]'),
        ) as HTMLElement[];
        const last = nodes[nodes.length - 1];
        return last?.outerHTML ?? "";
      });
      if (messageHtml) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-assistant.html`),
          messageHtml,
          "utf8",
        );
      }
      const conversation = await page.evaluate(async () => {
        const match = window.location.pathname.match(/\/c\/([a-z0-9-]+)/i);
        if (!match) return null;
        const response = await fetch(`/backend-api/conversation/${match[1]}`, {
          credentials: "include",
        });
        if (!response.ok) return { status: response.status };
        return await response.json();
      });
      if (conversation) {
        await fs.promises.writeFile(
          path.join(debugDir, `${label}-conversation.json`),
          JSON.stringify(conversation, null, 2),
          "utf8",
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

async function maybeCaptureConversationUrl(
  page: import("playwright").Page,
  config: RunConfig,
): Promise<void> {
  const url = page.url();
  if (
    url.includes("/c/") ||
    url.includes("/chat/") ||
    url.includes("/conversation/")
  ) {
    config.conversationUrl = url;
  }
}

function attachNetworkTracing(
  page: import("playwright").Page,
  logger: (msg: string) => void,
): void {
  if (process.env.ORACLE_TRACE_NETWORK !== "1") return;
  const shouldLog = (url: string) =>
    /backend-api|conversation|event-stream/i.test(url);
  page.on("response", (response) => {
    const url = response.url();
    if (!shouldLog(url)) return;
    const method = response.request().method();
    const status = response.status();
    logger(`[net] ${status} ${method} ${url}`);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!shouldLog(url)) return;
    logger(
      `[net] failed ${request.method()} ${url} ${request.failure()?.errorText ?? ""}`.trim(),
    );
  });
}

function buildFocusMessage(
  focus: NonNullable<RunConfig["focus"]>,
  allowVisible: boolean,
): string | undefined {
  if (focus.state === "visible" && !allowVisible) {
    if (focus.needsUser?.type)
      return `focus fallback: visible (${focus.needsUser.type})`;
    return `focus fallback: ${focus.reason ?? "visible"}`;
  }
  if (focus.needsUser?.type) {
    return `focus permissions: ${focus.needsUser.type}`;
  }
  return undefined;
}

function mergeFocusNeeds(
  config: RunConfig,
  needs?: NonNullable<RunConfig["focus"]>["needsUser"],
): void {
  if (!needs) return;
  if (!config.focus) {
    config.focus = {
      state: "visible",
      reason: "focus-unknown",
      needsUser: needs,
    };
    return;
  }
  if (!config.focus.needsUser) {
    config.focus.needsUser = needs;
  }
}

async function injectTextDocsCapture(
  page: import("playwright").Page,
  logger: (msg: string) => void,
): Promise<void> {
  const script = () => {
    const globalAny = window as any;
    if (globalAny.__oracleFetchPatched) return;
    globalAny.__oracleFetchPatched = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await originalFetch(...args);
      try {
        const input = args[0] as any;
        const url = typeof input === "string" ? input : (input?.url ?? "");
        if (url.includes("/textdocs")) {
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
    await page.addInitScript(script);
    await page.evaluate(script);
  } catch (error) {
    logger(`[debug] inject textdocs capture failed: ${String(error)}`);
  }
}

async function waitForCompletionWithCancel(
  page: import("playwright").Page,
  config: RunConfig,
  runDir: string,
  logger: (msg: string) => void,
): Promise<import("./browser/chatgpt.js").WaitForCompletionResult> {
  let done = false;
  const heartbeatTimer = setInterval(() => {
    if (done) return;
    writeStatus(config, "running", "waiting", "awaiting response").catch(
      () => null,
    );
  }, 30_000);
  heartbeatTimer.unref?.();
  const cancelWatcher = (async () => {
    while (!done) {
      if (await isCanceled(runDir)) {
        throw new CancelError("Canceled by user");
      }
      await sleep(1000);
    }
    return null as never;
  })();
  let resubmitted = false;

  const waitOnce = () =>
    Promise.race([
      waitForCompletion(page, {
        timeoutMs: config.timeoutMs,
        pollMs: config.pollMs,
        prompt: config.prompt,
        logger,
      }),
      cancelWatcher,
    ]);

  try {
    while (true) {
      try {
        return await waitOnce();
      } catch (error) {
        if (error instanceof ResponseStalledError) {
          await refreshAfterStall(page, config);
          continue;
        }
        if (error instanceof ResponseFailedError) {
          if (resubmitted) throw error;
          resubmitted = true;
          await resubmitPrompt(page, config, logger);
          await maybeCaptureConversationUrl(page, config);
          await saveRunConfig(config.runPath, config);
          continue;
        }
        if (error instanceof ResponseTimeoutError) {
          throw error;
        }
        throw error;
      }
    }
  } finally {
    done = true;
    clearInterval(heartbeatTimer);
  }
}

async function refreshAfterStall(
  page: import("playwright").Page,
  config: RunConfig,
): Promise<void> {
  await writeStatus(
    config,
    "running",
    "recovery",
    "refreshing after stalled response",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await ensureWideViewport(page);
  await sleep(1000);
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

async function resubmitPrompt(
  page: import("playwright").Page,
  config: RunConfig,
  logger: (msg: string) => void,
): Promise<void> {
  await writeStatus(config, "running", "submit", "resubmitting prompt");
  await waitForPromptInput(page, 30_000, logger);
  const expectedTurn = await getNextUserTurnNumber(page);
  const typedValue = await submitPrompt(page, config.prompt, logger);
  if (typedValue.trim() !== config.prompt.trim()) {
    // Best-effort; continue even if input doesn't echo exactly.
  }
  const submitted = await waitForUserMessage(
    page,
    config.prompt,
    expectedTurn,
    8_000,
  );
  if (!submitted) {
    await submitPrompt(page, config.prompt, logger);
  }
  await sleep(1000);
}

async function isCanceled(runDir: string): Promise<boolean> {
  return pathExists(path.join(runDir, CANCEL_FILE));
}

async function finalizeCanceled(
  config: RunConfig,
  logger: (msg: string) => void,
  message: string,
): Promise<void> {
  await saveResultJson(config.resultJsonPath, {
    runId: config.runId,
    state: "canceled",
    completedAt: nowIso(),
    conversationUrl: config.conversationUrl,
    error: message,
  });
  await writeStatus(config, "canceled", "cleanup", message);
  logger(`[worker] canceled: ${message}`);
}

async function finalizeFailed(
  config: RunConfig,
  logger: (msg: string) => void,
  message: string,
): Promise<void> {
  await saveResultJson(config.resultJsonPath, {
    runId: config.runId,
    state: "failed",
    completedAt: nowIso(),
    conversationUrl: config.conversationUrl,
    error: message,
  });
  await writeStatus(config, "failed", "cleanup", message);
  logger(`[worker] failed: ${message}`);
}

async function finalizeFocusOnly(
  config: RunConfig,
  logger: (msg: string) => void,
  message: string,
): Promise<void> {
  await saveResultJson(config.resultJsonPath, {
    runId: config.runId,
    state: "completed",
    completedAt: nowIso(),
    conversationUrl: config.conversationUrl,
    content: "",
  });
  await saveResultMarkdown(config.resultPath, "");
  await writeStatus(config, "completed", "cleanup", message);
  logger(`[worker] completed focus-only run ${config.runId}`);
}

function parseArgs(argv: string[]): { runDir?: string } {
  const args: { runDir?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--run-dir") {
      args.runDir = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});
