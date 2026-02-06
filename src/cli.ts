#!/usr/bin/env node
import crypto from "crypto";
import path from "path";
import { Command } from "commander";
import {
  defaultRunsRoot,
  runDir,
  statusPath,
  resultPath,
  resultJsonPath,
  logPath,
  runConfigPath,
} from "./run/paths.js";
import { saveRunConfig, saveStatus } from "./run/state.js";
import { applyRunOverrides } from "./run/options.js";
import {
  buildThinkingState,
  computeThinkingIncrement,
  readThinkingState,
  saveThinkingState,
} from "./run/thinking.js";
import { cleanupRunsRoot } from "./run/cleanup.js";
import type { RunConfig, StatusPayload, ResultPayload } from "./run/types.js";
import {
  ensureDir,
  readJson,
  pathExists,
  writeJsonAtomic,
} from "./utils/fs.js";
import { nowIso, sleep } from "./utils/time.js";
import {
  oracleChromeDataDir,
  oracleFirefoxDataDir,
} from "./browser/profiles.js";
import { resolveFirefoxApp } from "./browser/firefox-app.js";
import { DEFAULT_BASE_URL } from "./browser/chatgpt.js";
import { readThinkingContent } from "./cli/thinking-reader.js";
import { parsePromptAttachments } from "./run/attachments.js";

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 1;
const NEEDS_USER_WAIT_MS = 30_000;
const NEEDS_USER_POLL_MS = 1000;
const RUN_ESTABLISH_WAIT_MS = 30_000;
const CONVERSATION_URL_WAIT_MS = 5_000;
const CONVERSATION_URL_POLL_MS = 250;
const PROMPT_SUBMIT_WAIT_MS = 60_000;
const PROMPT_SUBMIT_POLL_MS = 500;
const RUNS_TTL_MS = 48 * 60 * 60 * 1000;

// --- Structured error support ---

class OracleError extends Error {
  public readonly code: string;
  public readonly suggestion?: string;
  constructor(code: string, message: string, suggestion?: string) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
  }
}

let jsonMode = false;

const argv = [...process.argv];
const helpDevIndex = argv.indexOf("--help-dev");
if (helpDevIndex !== -1) {
  process.env.ORACLE_DEV = "1";
  argv[helpDevIndex] = "--help";
}
const DEV_MODE = process.env.ORACLE_DEV === "1";

const program = new Command();

program
  .name("oracle")
  .description(
    "Browser-based tool for AI agents to query GPT via ChatGPT web interface.",
  )
  .version("0.1.0");

const runCommand = program
  .command("run")
  .addHelpText(
    "before",
    "Prompt input: stdin (cat prompt.txt | oracle run) or -p/--prompt.\n",
  )
  .description(
    "Start a new run or continue an existing conversation. " +
      "Prompt can be provided via stdin (cat prompt.txt | oracle run). " +
      "Pass run_id as first argument to add a follow-up message to that conversation.",
  )
  .argument(
    "[args...]",
    "prompt (include @file refs inline), or run_id followed by prompt",
  )
  .addHelpText(
    "before",
    "Prompt can be provided via stdin (e.g. cat prompt.txt | oracle run).\n",
  )
  .option(
    "-p, --prompt <prompt>",
    "prompt text (supports inline @file refs: @src/main.ts, @file.ts:23-90)",
  )
  .option("--prompt-file <path>", "path to prompt file")
  .option(
    "--base-url <url>",
    "ChatGPT base URL (override ORACLE_BASE_URL/ORACLE_EVAL_BASE_URL)",
  )
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .option("--allow-visible", "Allow visible window for login", false)
  .option("--focus-only", "Run focus setup only (no navigation)", false)
  .option("--allow-kill", "Allow killing automation Chrome if stuck", false)
  .option("--effort <mode>", "effort level (extended or standard)")
  .option("--thinking <mode>", "deprecated alias for --effort")
  .option("--json", "Output machine-readable JSON", false);

if (DEV_MODE) {
  runCommand.option("--browser <browser>", "chrome or firefox", "chrome");
  runCommand.option(
    "--firefox-profile <path>",
    "Firefox profile path (defaults to ~/.oracle/firefox)",
  );
  runCommand.option(
    "--firefox-app <path>",
    "Firefox app bundle or binary path (Developer Edition / Nightly)",
  );
  runCommand.option(
    "--poll-ms <ms>",
    "Polling interval for streaming",
    String(DEFAULT_POLL_MS),
  );
  runCommand.option(
    "--timeout-ms <ms>",
    "Max wait time for completion",
    String(DEFAULT_TIMEOUT_MS),
  );
  runCommand.option(
    "--max-attempts <n>",
    "Max attempts",
    String(DEFAULT_MAX_ATTEMPTS),
  );
}

runCommand.action(async (args, options) => {
  jsonMode = Boolean(options.json);
  await cleanupRuns(options.runsRoot);
  const {
    runId,
    prompt: rawPrompt,
    existing,
  } = await resolveRunInvocation(args, options);
  const runDirPath = runDir(runId, options.runsRoot);
  if (existing) {
    const status = await readStatusMaybe(runDirPath);
    if (status) {
      // Skip needs_user wait if override addresses it
      const canResolve =
        (options.allowKill && status.needs?.type === "kill_chrome") ||
        (options.allowVisible &&
          ["login", "cloudflare"].includes(status.needs?.type ?? ""));
      if (!canResolve) {
        await waitForNeedsUserResolution(runId, runDirPath, status);
      }
    }
  }
  await ensureDir(runDirPath);

  // Parse @file references and replace with [attached: filename]
  const parsed = parsePromptAttachments(rawPrompt);
  const prompt = parsed.prompt;
  const attachments =
    parsed.attachments.length > 0 ? parsed.attachments : undefined;
  const originalPrompt =
    parsed.prompt !== rawPrompt ? parsed.originalPrompt : undefined;

  const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
  const baseUrl = resolveBaseUrl(options.baseUrl);
  assertValidUrl(baseUrl, "base URL");
  const pollMs =
    DEV_MODE && options.pollMs
      ? parsePositiveInt(options.pollMs, "poll-ms")
      : DEFAULT_POLL_MS;
  const timeoutMs =
    DEV_MODE && options.timeoutMs
      ? parsePositiveInt(options.timeoutMs, "timeout-ms")
      : DEFAULT_TIMEOUT_MS;
  const maxAttempts =
    DEV_MODE && options.maxAttempts
      ? parsePositiveInt(options.maxAttempts, "max-attempts")
      : DEFAULT_MAX_ATTEMPTS;
  const thinking = resolveThinkingMode(options.effort ?? options.thinking);

  let config: RunConfig;
  if (existing) {
    config = await readJson<RunConfig>(runConfigPath(runDirPath));
    if (DEV_MODE && options.browser) {
      const browser = resolveBrowserOption(options.browser);
      config.browser = browser;
      config.profile = resolveProfile({
        browser,
        firefoxProfile: options.firefoxProfile,
      });
      config.firefoxApp =
        browser === "firefox"
          ? resolveFirefoxApp(options.firefoxApp)
          : undefined;
    }
    if (options.allowVisible) config.allowVisible = true;
    if (options.allowKill) config.allowKill = true;
    if (options.focusOnly) config.focusOnly = true;
    if (options.baseUrl) config.baseUrl = baseUrl;
    config.prompt = prompt;
    config.originalPrompt = originalPrompt;
    config.attachments = attachments;
    config.promptHash = promptHash;
    config.pollMs = pollMs;
    config.timeoutMs = timeoutMs;
    config.thinking = thinking;
    config.attempt = 1;
    config.maxAttempts = maxAttempts;
    config.outDir = runDirPath;
    config.statusPath = statusPath(runDirPath);
    config.resultPath = resultPath(runDirPath);
    config.resultJsonPath = resultJsonPath(runDirPath);
    config.logPath = logPath(runDirPath);
    config.runPath = runConfigPath(runDirPath);
    config.lastAssistantIndex = undefined;
    config.lastError = undefined;
    config.startedAt = undefined;
    config.completedAt = undefined;
  } else {
    const browser = DEV_MODE
      ? resolveBrowserOption(options.browser)
      : "chrome";
    const profile = resolveProfile({
      browser,
      firefoxProfile: options.firefoxProfile,
    });
    const firefoxApp =
      browser === "firefox" ? resolveFirefoxApp(options.firefoxApp) : undefined;
    config = {
      runId,
      createdAt: nowIso(),
      prompt,
      originalPrompt,
      promptHash,
      attachments,
      browser,
      profile,
      firefoxApp,
      headless: false,
      baseUrl,
      allowVisible: Boolean(options.allowVisible),
      focusOnly: Boolean(options.focusOnly),
      allowKill: Boolean(options.allowKill),
      pollMs,
      timeoutMs,
      thinking,
      attempt: 1,
      maxAttempts,
      outDir: runDirPath,
      statusPath: statusPath(runDirPath),
      resultPath: resultPath(runDirPath),
      resultJsonPath: resultJsonPath(runDirPath),
      logPath: logPath(runDirPath),
      runPath: runConfigPath(runDirPath),
    };
  }

  await saveRunConfig(config.runPath, config);
  await saveStatus(config.statusPath, {
    runId: config.runId,
    state: "starting",
    stage: "init",
    message: existing ? "queued (continue)" : "queued",
    updatedAt: nowIso(),
    attempt: config.attempt,
  });
  const initialStatusTimestamp = (await readJson<StatusPayload>(
    config.statusPath,
  )).updatedAt;

  await spawnWorker(runDirPath);
  await waitForRunEstablished(runId, runDirPath, initialStatusTimestamp);
  await waitForPromptSubmitted(runId, runDirPath);

  if (options.json) {
    writeJson({
      run_id: runId,
      run_dir: runDirPath,
      status_path: config.statusPath,
      result_path: config.resultPath,
      result_json_path: config.resultJsonPath,
    });
  } else {
    // eslint-disable-next-line no-console
    console.log(`Run started: ${runId}`);
    // eslint-disable-next-line no-console
    console.log(`Status: ${config.statusPath}`);
    // eslint-disable-next-line no-console
    console.log(`Result: ${config.resultPath}`);
  }
});

program
  .command("status")
  .description("Get status for a run")
  .argument("<run_id>", "run id")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .option("--json", "Output JSON", false)
  .action(async (runId, options) => {
    jsonMode = Boolean(options.json);
    await cleanupRuns(options.runsRoot);
    const { runDirPath, status: initialStatus } = await loadStatusForRun(
      runId,
      options.runsRoot,
    );
    const status = await waitForNeedsUserResolution(
      runId,
      runDirPath,
      initialStatus,
    );
    if (options.json) {
      writeJson(status);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `${status.state} (${status.stage}) ${status.message ?? ""}`.trim(),
    );
  });

program
  .command("result")
  .description("Print result for a run")
  .argument("<run_id>", "run id")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .option("--json", "Output JSON metadata", false)
  .action(async (runId, options) => {
    jsonMode = Boolean(options.json);
    await cleanupRuns(options.runsRoot);
    const runDirPath = await requireRunDir(runId, options.runsRoot);
    const jsonPath = resultJsonPath(runDirPath);
    const mdPath = resultPath(runDirPath);
    const hasJson = await pathExists(jsonPath);
    const hasMd = await pathExists(mdPath);
    if (!hasJson && !hasMd) {
      const initialStatus = await readStatusMaybe(runDirPath);
      if (initialStatus) {
        await waitForNeedsUserResolution(runId, runDirPath, initialStatus);
      }
      const hasJsonAfter = await pathExists(jsonPath);
      const hasMdAfter = await pathExists(mdPath);
      if (!hasJsonAfter && !hasMdAfter) {
        const latestStatus = await readStatusMaybe(runDirPath);
        const state = latestStatus?.state ?? "unknown";
        const stage = latestStatus?.stage ?? "unknown";
        throw new OracleError(
          "RESULT_NOT_AVAILABLE",
          `Result not available yet for run ${runId} (state=${state}, stage=${stage}). The run may still be in progress.`,
          `Wait for completion with "oracle watch ${runId}", or check status with "oracle status ${runId}"`,
        );
      }
    }
    if (options.json) {
      if (!(await pathExists(jsonPath))) {
        throw new OracleError(
          "RESULT_NOT_AVAILABLE",
          `Result metadata not available for run ${runId}. The run may not have completed yet.`,
          `Wait with "oracle watch ${runId}" or check "oracle status ${runId}"`,
        );
      }
      const result = await readJson<ResultPayload>(jsonPath);
      writeJson(result);
      if (result.state !== "completed" || result.error) {
        process.exitCode = 1;
      }
      return;
    }
    let resultPayload: ResultPayload | null = null;
    if (hasJson) {
      resultPayload = await readJson<ResultPayload>(jsonPath);
      if (resultPayload.error) {
        // eslint-disable-next-line no-console
        console.error(resultPayload.error);
        process.exitCode = 1;
        return;
      }
    }
    if (hasMd) {
      const { promises: fs } = await import("fs");
      const markdown = await fs.readFile(mdPath, "utf8");
      // eslint-disable-next-line no-console
      console.log(markdown);
      return;
    }
    if (resultPayload?.content) {
      // eslint-disable-next-line no-console
      console.log(resultPayload.content);
      return;
    }
    throw new OracleError(
      "RESULT_EMPTY",
      `Result content missing for run ${runId}. The run completed but produced no output — this is unusual and may indicate a browser extraction failure.`,
      `Check "oracle result ${runId} --json" for error details`,
    );
  });

program
  .command("thinking")
  .description(
    "Print thinking output for a run (works on active or completed runs)",
  )
  .argument("<run_id>", "run id")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .option(
    "--full",
    "Return full thinking output (default: incremental since last call)",
    false,
  )
  .action(async (runId, options) => {
    await cleanupRuns(options.runsRoot);
    const { runDirPath, config } = await loadRunConfigForRun(
      runId,
      options.runsRoot,
    );
    const initialStatus = await readStatusMaybe(runDirPath);
    const status = initialStatus
      ? await waitForNeedsUserResolution(runId, runDirPath, initialStatus)
      : null;
    const conversationUrl = status?.conversationUrl ?? config.conversationUrl;
    if (!conversationUrl) {
      const state = status?.state ?? "unknown";
      const stage = status?.stage ?? "unknown";
      throw new OracleError(
        "THINKING_NOT_AVAILABLE",
        `Thinking not available for run ${runId} (state=${state}, stage=${stage}). The run may not have started reasoning yet — ChatGPT needs to begin processing before thinking output is available.`,
        `Wait for the run to start with "oracle watch ${runId}" first, then retry`,
      );
    }
    config.conversationUrl = conversationUrl;
    const fullText = await readThinkingContent(config);
    const state = await readThinkingState(runDirPath);
    if (options.full) {
      await saveThinkingState(runDirPath, buildThinkingState(fullText));
      // eslint-disable-next-line no-console
      console.log(fullText);
      return;
    }
    const { chunk, nextState } = computeThinkingIncrement(fullText, state);
    await saveThinkingState(runDirPath, nextState);
    if (chunk) {
      // eslint-disable-next-line no-console
      console.log(chunk);
    }
  });

program
  .command("resume")
  .description("Resume a run")
  .argument("<run_id>", "run id")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .option("--allow-visible", "Allow visible window for login", false)
  .option("--allow-kill", "Allow killing automation Chrome if stuck", false)
  .action(async (runId, options) => {
    await cleanupRuns(options.runsRoot);
    const runDirPath = await requireRunDir(runId, options.runsRoot);
    // Apply overrides FIRST so worker can use them for recovery
    if (options.allowVisible || options.allowKill) {
      const config = await readJson<RunConfig>(runConfigPath(runDirPath));
      applyRunOverrides(config, {
        allowVisible: options.allowVisible ? true : undefined,
        allowKill: options.allowKill ? true : undefined,
      });
      await saveRunConfig(config.runPath, config);
    }
    const initialStatus = await readStatusMaybe(runDirPath);
    // Skip needs_user wait if override addresses it
    const canResolve =
      (options.allowKill && initialStatus?.needs?.type === "kill_chrome") ||
      (options.allowVisible &&
        ["login", "cloudflare"].includes(initialStatus?.needs?.type ?? ""));
    const status =
      initialStatus && !canResolve
        ? await waitForNeedsUserResolution(runId, runDirPath, initialStatus)
        : initialStatus;
    if (status && ["completed", "failed", "canceled"].includes(status.state)) {
      throw new OracleError(
        "RUN_TERMINAL",
        `Cannot resume run ${runId}: already ${status.state}. The run has finished and cannot be resumed.`,
        `To continue the conversation, send a follow-up: echo "follow-up" | oracle run ${runId} --json`,
      );
    }
    await spawnWorker(runDirPath);
    // eslint-disable-next-line no-console
    console.log(`Resumed: ${runId}`);
  });

program
  .command("cancel")
  .description("Cancel a run")
  .argument("<run_id>", "run id")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .option("--json", "Output JSON", false)
  .action(async (runId, options) => {
    jsonMode = Boolean(options.json);
    await cleanupRuns(options.runsRoot);
    const runDirPath = await requireRunDir(runId, options.runsRoot);
    const initialStatus = await readStatusMaybe(runDirPath);
    const status = initialStatus
      ? await waitForNeedsUserResolution(runId, runDirPath, initialStatus)
      : null;
    if (status && ["completed", "failed", "canceled"].includes(status.state)) {
      throw new OracleError(
        "RUN_TERMINAL",
        `Cannot cancel run ${runId}: already ${status.state}. No action needed.`,
      );
    }
    const cancelPath = path.join(runDirPath, "cancel.json");
    if (await pathExists(cancelPath)) {
      throw new OracleError(
        "CANCEL_PENDING",
        `Run ${runId} already has a pending cancel request. Wait for it to take effect — check with "oracle status ${runId}".`,
      );
    }
    await writeJsonAtomic(cancelPath, {
      canceledAt: nowIso(),
    });
    if (options.json) {
      writeJson({ run_id: runId, canceled: true });
    } else {
      // eslint-disable-next-line no-console
      console.log(`Canceled: ${runId}`);
    }
  });

program
  .command("watch")
  .description("Watch a run until completion")
  .argument("<run_id>", "run id")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .option("--json", "Output JSON on completion", false)
  .action(async (runId, options) => {
    jsonMode = Boolean(options.json);
    await cleanupRuns(options.runsRoot);
    const runDirPath = await requireRunDir(runId, options.runsRoot);
    const statusFile = statusPath(runDirPath);
    if (!(await pathExists(statusFile))) {
      throw new OracleError(
        "STATUS_NOT_AVAILABLE",
        `Status not available for run ${runId}. The run may not have started yet — verify the run_id is correct with "oracle status ${runId}".`,
        `Verify the run_id or start a new run with: echo "prompt" | oracle run --json`,
      );
    }
    let lastState = "";
    let finalStatus: StatusPayload | null = null;
    while (true) {
      const status = await readJson<StatusPayload>(statusPath(runDirPath));
      if (status.state === "needs_user") {
        const resolved = await waitForNeedsUserResolution(
          runId,
          runDirPath,
          status,
        );
        if (`${resolved.state}:${resolved.stage}` !== lastState) {
          if (!options.json) {
            // eslint-disable-next-line no-console
            console.log(
              `${resolved.state} (${resolved.stage}) ${resolved.message ?? ""}`.trim(),
            );
          }
          lastState = `${resolved.state}:${resolved.stage}`;
        }
        if (["completed", "failed", "canceled"].includes(resolved.state)) {
          finalStatus = resolved;
          break;
        }
        continue;
      }
      if (`${status.state}:${status.stage}` !== lastState) {
        if (!options.json) {
          // eslint-disable-next-line no-console
          console.log(
            `${status.state} (${status.stage}) ${status.message ?? ""}`.trim(),
          );
        }
        lastState = `${status.state}:${status.stage}`;
      }
      if (["completed", "failed", "canceled"].includes(status.state)) {
        finalStatus = status;
        break;
      }
      await sleep(1000);
    }
    if (options.json && finalStatus) {
      writeJson(finalStatus);
      if (finalStatus.state !== "completed") {
        process.exitCode = 1;
      }
    }
  });

program
  .command("open")
  .description("Open a visible browser window for a run (login / recovery)")
  .argument("[run_id]", "run id (optional)")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .action(async (runId, options) => {
    await cleanupRuns(options.runsRoot);
    if (runId) {
      const { runDirPath, config } = await loadRunConfigForRun(
        runId,
        options.runsRoot,
      );
      const { status: initialStatus } = await loadStatusForRun(
        runId,
        options.runsRoot,
      );
      if (config.browser === "chrome" && !config.debugPort) {
        config.debugPort = await getFreePort();
        await saveRunConfig(config.runPath, config);
      }
      // open is for manual intervention — skip needs_user wait
      // Fall back to base URL only for needs_user states (login/recovery)
      let targetUrl: string;
      if (initialStatus?.state === "needs_user") {
        // Needs manual intervention — open base URL for login/recovery
        targetUrl =
          initialStatus.conversationUrl ?? config.conversationUrl ?? config.baseUrl;
      } else {
        const conversation = await waitForConversationUrl(
          runId,
          runDirPath,
          config,
          initialStatus,
          { skipNeedsUserWait: true },
        );
        targetUrl = conversation.url;
      }
      assertValidUrl(targetUrl, "target URL");
      await openVisible(config, targetUrl);
      // eslint-disable-next-line no-console
      console.log(`Opened browser for ${runId}`);
      return;
    }

    const targetUrl =
      process.env.ORACLE_DEV === "1"
        ? resolveBaseUrl(undefined)
        : DEFAULT_BASE_URL;
    assertValidUrl(targetUrl, "base URL");
    const config = buildDefaultOpenConfig(targetUrl);
    await openVisible(config, targetUrl);
    // eslint-disable-next-line no-console
    console.log(`Opened browser at ${targetUrl}`);
  });

program.parseAsync(argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) {
    const payload: Record<string, unknown> = {
      error: true,
      code: error instanceof OracleError ? error.code : "UNKNOWN_ERROR",
      message,
    };
    if (error instanceof OracleError && error.suggestion) {
      payload.suggestion = error.suggestion;
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.error(message);
  }
  process.exitCode = 1;
});

async function resolveRunInvocation(
  args: string[] | undefined,
  options: { runsRoot: string; prompt?: string; promptFile?: string },
): Promise<{ runId: string; prompt: string; existing: boolean }> {
  const argv = Array.isArray(args) ? args : [];
  let runId: string | null = null;
  let promptParts = argv;

  if (argv.length > 0 && isRunId(argv[0])) {
    runId = argv[0];
    promptParts = argv.slice(1);
    const runDirPath = runDir(runId, options.runsRoot);
    if (!(await pathExists(runConfigPath(runDirPath)))) {
      throw new OracleError(
        "RUN_NOT_FOUND",
        `Run not found: ${runId}. Run IDs look like "abc123-def456" — verify the ID is correct.`,
        `Start a new run with: echo "prompt" | oracle run --json`,
      );
    }
  }

  const promptFromOptions = await loadPromptFromOptions(
    options.prompt,
    options.promptFile,
  );
  let prompt: string | null = null;
  if (promptFromOptions !== null) {
    if (promptParts.length) {
      throw new OracleError(
        "INVALID_ARGS",
        "Cannot combine positional arguments with --prompt or --prompt-file. Use one method: positional args, --prompt, --prompt-file, or stdin.",
        `Examples: oracle run "prompt" --json, oracle run -p "prompt" --json, echo "prompt" | oracle run --json`,
      );
    }
    prompt = promptFromOptions;
  } else {
    prompt = promptParts.length ? promptParts.join(" ") : null;
  }
  if (!prompt) {
    prompt = await readPromptFromStdin();
  }
  if (!prompt) {
    throw new OracleError(
      "PROMPT_REQUIRED",
      "No prompt provided. Oracle needs a prompt to send to ChatGPT.",
      `Provide via: echo "prompt" | oracle run --json, or oracle run "prompt" --json, or oracle run -p "prompt" --json`,
    );
  }
  return {
    runId: runId ?? generateRunId(),
    prompt,
    existing: Boolean(runId),
  };
}

function isRunId(value: string): boolean {
  return /^[a-z0-9]+-[a-z0-9]+$/.test(value);
}

async function cleanupRuns(runsRoot: string): Promise<void> {
  try {
    await cleanupRunsRoot(runsRoot, { ttlMs: RUNS_TTL_MS });
  } catch {
    // best-effort cleanup only
  }
}

async function loadPromptFromOptions(
  prompt?: string,
  promptFile?: string,
): Promise<string | null> {
  if (prompt !== undefined) {
    const trimmed = prompt.trim();
    if (!trimmed)
      throw new OracleError(
        "PROMPT_EMPTY",
        "Prompt is empty (contains only whitespace). Provide a non-empty prompt.",
        `Example: oracle run -p "What is quantum computing?" --json`,
      );
    return prompt;
  }
  if (promptFile) {
    if (!(await pathExists(promptFile))) {
      throw new OracleError(
        "PROMPT_FILE_NOT_FOUND",
        `Prompt file not found: ${promptFile}. Verify the path exists and is readable.`,
      );
    }
    const content = (await readJsonOrText(promptFile))?.trim() ?? "";
    if (!content)
      throw new OracleError(
        "PROMPT_FILE_EMPTY",
        `Prompt file is empty: ${promptFile}. The file exists but contains no text.`,
        `Write your prompt to the file first, then retry.`,
      );
    return content;
  }
  return null;
}

async function readPromptFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const data = await new Promise<string>((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
  });
  const trimmed = data.trim();
  return trimmed ? data : null;
}

async function readJsonOrText(filePath: string): Promise<string> {
  const raw = (await pathExists(filePath))
    ? await import("fs").then((fsModule) =>
        fsModule.promises.readFile(filePath, "utf8"),
      )
    : "";
  return raw;
}

function generateRunId(): string {
  const rand = crypto.randomBytes(4).toString("hex");
  return `${Date.now().toString(36)}-${rand}`;
}

function resolveProfile(input: {
  browser: "chrome" | "firefox";
  firefoxProfile?: string;
}): RunConfig["profile"] {
  if (input.browser === "firefox") {
    const resolvedProfile = input.firefoxProfile ?? oracleFirefoxDataDir();
    return {
      kind: "firefox",
      userDataDir: resolvedProfile,
      profileDir: resolvedProfile,
    };
  }
  return {
    kind: "chrome",
    userDataDir: oracleChromeDataDir(),
  };
}

function resolveBaseUrl(input?: string): string {
  if (input) return input;
  const env = process.env.ORACLE_BASE_URL ?? process.env.ORACLE_EVAL_BASE_URL;
  if (env && env.trim()) return env.trim();
  return DEFAULT_BASE_URL;
}

function resolveThinkingMode(input?: string): RunConfig["thinking"] {
  const normalized = (input ?? "extended").trim().toLowerCase();
  if (normalized === "standard") return "standard";
  if (normalized === "extended") return "extended";
  throw new OracleError(
    "INVALID_OPTION",
    `Unknown effort mode: "${input}". Valid values: "extended" (deep reasoning, default) or "standard" (faster, less thorough).`,
    `Use: oracle run --effort extended "prompt" --json`,
  );
}

async function spawnWorker(runDirPath: string): Promise<void> {
  const baseDir = path.resolve(__dirname, "..");
  const distWorker = path.join(baseDir, "dist", "worker.js");
  const useDist = await pathExists(distWorker);
  const { spawn } = await import("child_process");

  const command = useDist ? "node" : "npx";
  const args = useDist
    ? [distWorker, "--run-dir", runDirPath]
    : ["tsx", path.join(baseDir, "src", "worker.ts"), "--run-dir", runDirPath];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function writeJson(payload: unknown): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function openVisible(config: RunConfig, targetUrl?: string): Promise<void> {
  const { spawn } = await import("child_process");
  if (!targetUrl) {
    throw new Error("Open requires an explicit URL");
  }
  const url = targetUrl;
  if (config.browser === "chrome") {
    const args: string[] = [];
    args.push("--no-first-run", "--no-default-browser-check");
    args.push(`--user-data-dir=${config.profile.userDataDir}`);
    if (config.profile.profileDir)
      args.push(`--profile-directory=${config.profile.profileDir}`);
    if (config.debugPort)
      args.push(`--remote-debugging-port=${config.debugPort}`);
    if (url) args.push(url);
    spawn("open", ["-n", "-a", "Google Chrome", "--args", ...args], {
      stdio: "ignore",
      detached: true,
    }).unref();
    return;
  }
  if (config.browser === "firefox") {
    const args: string[] = [];
    if (config.profile.profileDir) {
      args.push("-profile", config.profile.profileDir);
    }
    if (url) args.push(url);
    const appPath = config.firefoxApp?.appPath ?? "Firefox";
    spawn("open", ["-n", "-a", appPath, "--args", ...args], {
      stdio: "ignore",
      detached: true,
    }).unref();
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require("net").createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function readStatusMaybe(
  runDirPath: string,
): Promise<StatusPayload | null> {
  const statusFile = statusPath(runDirPath);
  if (!(await pathExists(statusFile))) return null;
  return readJson<StatusPayload>(statusFile);
}

async function waitForRunEstablished(
  runId: string,
  runDirPath: string,
  initialUpdatedAt: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < RUN_ESTABLISH_WAIT_MS) {
    await sleep(NEEDS_USER_POLL_MS);
    const status = await readStatusMaybe(runDirPath);
    if (!status) continue;
    const established =
      status.updatedAt !== initialUpdatedAt || status.state !== "starting";
    if (established) {
      await waitForNeedsUserResolution(runId, runDirPath, status);
      return;
    }
  }
  throw new OracleError(
    "RUN_NOT_STARTED",
    `Run ${runId} did not start within ${Math.round(RUN_ESTABLISH_WAIT_MS / 1000)}s. The worker process may have failed to launch — Chrome may not be installed, or the Oracle Chrome profile at ~/.oracle/chrome/ may be missing or corrupted.`,
    `Check that Chrome is installed and try: oracle open (to verify browser access)`,
  );
}

async function waitForPromptSubmitted(
  runId: string,
  runDirPath: string,
): Promise<void> {
  let configTimeoutMs = PROMPT_SUBMIT_WAIT_MS;
  try {
    const config = await readJson<RunConfig>(runConfigPath(runDirPath));
    if (Number.isFinite(config.timeoutMs) && config.timeoutMs > 0) {
      configTimeoutMs = Math.max(configTimeoutMs, config.timeoutMs);
    }
  } catch {
    // fall back to default
  }
  const start = Date.now();
  let status = await readStatusMaybe(runDirPath);
  while (Date.now() - start < configTimeoutMs) {
    if (status?.state === "needs_user") {
      status = await waitForNeedsUserResolution(runId, runDirPath, status);
    }
    if (status) {
      if (["completed", "failed", "canceled"].includes(status.state)) {
        await waitForConversationUrl(runId, runDirPath, await readJson<RunConfig>(runConfigPath(runDirPath)), status);
        return;
      }
      const stageReady =
        status.stage === "waiting" ||
        status.stage === "extract" ||
        status.stage === "cleanup";
      if (stageReady) {
        const config = await readJson<RunConfig>(runConfigPath(runDirPath));
        await waitForConversationUrl(runId, runDirPath, config, status);
        return;
      }
    }
    await sleep(PROMPT_SUBMIT_POLL_MS);
    status = await readStatusMaybe(runDirPath);
  }
  const state = status?.state ?? "unknown";
  const stage = status?.stage ?? "unknown";
  throw new OracleError(
    "PROMPT_NOT_SUBMITTED",
    `Run ${runId} did not submit the prompt within ${Math.round(configTimeoutMs / 1000)}s (state=${state}, stage=${stage}). The browser may be slow, stuck, or ChatGPT may be unresponsive.`,
    `Check status with "oracle status ${runId}", or cancel and retry with "oracle cancel ${runId}"`,
  );
}

async function waitForNeedsUserResolution(
  runId: string,
  runDirPath: string,
  status: StatusPayload,
): Promise<StatusPayload> {
  if (status.state !== "needs_user") return status;
  const start = Date.now();
  let latest = status;
  while (Date.now() - start < NEEDS_USER_WAIT_MS) {
    await sleep(NEEDS_USER_POLL_MS);
    const next = await readStatusMaybe(runDirPath);
    if (next) {
      latest = next;
      if (next.state !== "needs_user") return next;
    }
  }
  const type = latest.needs?.type ?? "unknown";
  const details = latest.needs?.details ?? latest.message ?? "";
  const stage = latest.stage ?? "unknown";
  const suffix = details ? ` — ${details}` : "";
  const typeHints: Record<string, string> = {
    login:
      "The user needs to log in to ChatGPT. Ask them to run: oracle open",
    cloudflare:
      "Cloudflare challenge detected. Ask the user to open a browser and solve it: oracle open",
    kill_chrome:
      "Chrome is stuck and needs to be restarted. Resume with: oracle resume " +
      runId +
      " --allow-kill",
    chrome_restart_approval:
      "Chrome restart needs user approval. The user should check their notifications.",
    profile:
      "Browser profile is in use by another process. Close the other browser or wait for it to finish.",
    firefox_app:
      "Firefox Developer Edition or Nightly not found. Install it or specify the path with --firefox-app.",
  };
  const hint = typeHints[type] ?? "Please escalate this issue to your user.";
  throw new OracleError(
    "NEEDS_USER",
    `Run ${runId} requires user intervention (type: ${type}, stage: ${stage})${suffix}. ${hint}`,
    hint,
  );
}

async function waitForConversationUrl(
  runId: string,
  runDirPath: string,
  config: RunConfig,
  status: StatusPayload | null,
  options: { skipNeedsUserWait?: boolean } = {},
): Promise<{ url: string; status: StatusPayload | null }> {
  const start = Date.now();
  let latestStatus = status;
  let latestConfig = config;
  while (Date.now() - start < CONVERSATION_URL_WAIT_MS) {
    if (latestStatus?.state === "needs_user" && !options.skipNeedsUserWait) {
      latestStatus = await waitForNeedsUserResolution(
        runId,
        runDirPath,
        latestStatus,
      );
    }
    const url = latestStatus?.conversationUrl ?? latestConfig.conversationUrl;
    if (url) return { url, status: latestStatus };
    if (
      latestStatus &&
      ["completed", "failed", "canceled"].includes(latestStatus.state)
    ) {
      const state = latestStatus.state;
      const stage = latestStatus.stage ?? "unknown";
      throw new OracleError(
        "NO_CONVERSATION_URL",
        `Run ${runId} has no conversation URL (state=${state}, stage=${stage}). The run ended before navigating to ChatGPT successfully.`,
        `Check "oracle status ${runId}" for details, or start a new run`,
      );
    }
    await sleep(CONVERSATION_URL_POLL_MS);
    latestStatus = await readStatusMaybe(runDirPath);
    try {
      latestConfig = await readJson<RunConfig>(runConfigPath(runDirPath));
    } catch {
      // keep last config
    }
  }
  const state = latestStatus?.state ?? "unknown";
  const stage = latestStatus?.stage ?? "unknown";
  throw new OracleError(
    "NO_CONVERSATION_URL",
    `Run ${runId} timed out waiting for a conversation URL (state=${state}, stage=${stage}). The browser may not have navigated to ChatGPT successfully.`,
    `Check "oracle status ${runId}" for details, or cancel and start a new run`,
  );
}

async function requireRunDir(
  runId: string,
  runsRoot: string,
): Promise<string> {
  const runDirPath = runDir(runId, runsRoot);
  if (!(await pathExists(runConfigPath(runDirPath)))) {
    throw new OracleError(
      "RUN_NOT_FOUND",
      `Run not found: ${runId}. The run_id may be incorrect, or the run data was cleaned up (runs expire after 48h).`,
      `Start a new run with: echo "prompt" | oracle run --json`,
    );
  }
  return runDirPath;
}

async function loadRunConfigForRun(
  runId: string,
  runsRoot: string,
): Promise<{ runDirPath: string; config: RunConfig }> {
  const runDirPath = await requireRunDir(runId, runsRoot);
  const config = await readJson<RunConfig>(runConfigPath(runDirPath));
  return { runDirPath, config };
}

async function loadStatusForRun(
  runId: string,
  runsRoot: string,
): Promise<{ runDirPath: string; status: StatusPayload }> {
  const runDirPath = await requireRunDir(runId, runsRoot);
  const statusFile = statusPath(runDirPath);
  if (!(await pathExists(statusFile))) {
    throw new OracleError(
      "STATUS_NOT_AVAILABLE",
      `Status not available for run ${runId}. The worker process may not have started yet or the run_id may be incorrect.`,
      `Wait a moment and retry, or verify the run_id with a new run: echo "prompt" | oracle run --json`,
    );
  }
  const status = await readJson<StatusPayload>(statusFile);
  return { runDirPath, status };
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new OracleError(
      "INVALID_OPTION",
      `Invalid value for ${label}: "${value}". Must be a positive integer (e.g., 15000).`,
    );
  }
  return parsed;
}

function resolveBrowserOption(input?: string): "chrome" | "firefox" {
  if (!input) return "chrome";
  const normalized = input.trim().toLowerCase();
  if (normalized === "chrome" || normalized === "firefox") return normalized;
  throw new OracleError(
    "INVALID_OPTION",
    `Unknown browser: "${input}". Valid values: "chrome" or "firefox".`,
  );
}

function assertValidUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OracleError(
      "INVALID_URL",
      `Invalid ${label}: "${value}". Expected a valid HTTP or HTTPS URL (e.g., https://chatgpt.com/).`,
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new OracleError(
      "INVALID_URL",
      `Invalid ${label}: "${value}". URL must use http:// or https:// protocol (got ${parsed.protocol}).`,
    );
  }
}

function buildDefaultOpenConfig(targetUrl: string): RunConfig {
  return {
    runId: "open",
    createdAt: nowIso(),
    prompt: "",
    promptHash: "",
    browser: "chrome",
    profile: {
      kind: "chrome",
      userDataDir: oracleChromeDataDir(),
    },
    headless: false,
    baseUrl: targetUrl,
    allowVisible: true,
    focusOnly: false,
    allowKill: false,
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    thinking: "extended",
    attempt: 1,
    maxAttempts: 1,
    outDir: "",
    statusPath: "",
    resultPath: "",
    resultJsonPath: "",
    logPath: "",
    runPath: "",
  };
}
