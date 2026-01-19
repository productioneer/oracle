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
  .description(
    "Start a new run or continue an existing conversation. " +
      "Pass run_id as first argument to add a follow-up message to that conversation.",
  )
  .argument(
    "[args...]",
    "prompt, or run_id followed by prompt to continue conversation",
  )
  .option(
    "-p, --prompt <prompt>",
    "prompt text (supports @file refs: @src/main.ts, @file.ts:23-90 for line ranges)",
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
  .option(
    "--thinking <mode>",
    "thinking effort (extended or standard)",
    "extended",
  )
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
  const {
    runId,
    prompt: rawPrompt,
    existing,
  } = await resolveRunInvocation(args, options);
  const runDirPath = runDir(runId, options.runsRoot);
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
  const pollMs =
    DEV_MODE && options.pollMs ? Number(options.pollMs) : DEFAULT_POLL_MS;
  const timeoutMs =
    DEV_MODE && options.timeoutMs
      ? Number(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const maxAttempts =
    DEV_MODE && options.maxAttempts
      ? Number(options.maxAttempts)
      : DEFAULT_MAX_ATTEMPTS;
  const thinking = resolveThinkingMode(options.thinking);

  let config: RunConfig;
  if (existing) {
    config = await readJson<RunConfig>(runConfigPath(runDirPath));
    if (DEV_MODE && options.browser) {
      const browser = options.browser === "firefox" ? "firefox" : "chrome";
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
    const browser =
      DEV_MODE && options.browser === "firefox" ? "firefox" : "chrome";
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

  await spawnWorker(runDirPath);

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
    const runDirPath = runDir(runId, options.runsRoot);
    const status = await readJson<StatusPayload>(statusPath(runDirPath));
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
    const runDirPath = runDir(runId, options.runsRoot);
    if (options.json) {
      const result = await readJson<ResultPayload>(resultJsonPath(runDirPath));
      writeJson(result);
      return;
    }
    const mdPath = resultPath(runDirPath);
    if (await pathExists(mdPath)) {
      const { promises: fs } = await import("fs");
      const markdown = await fs.readFile(mdPath, "utf8");
      // eslint-disable-next-line no-console
      console.log(markdown);
      return;
    }
    const content = await readJson<ResultPayload>(resultJsonPath(runDirPath));
    // eslint-disable-next-line no-console
    console.log(content.content ?? "");
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
    const runDirPath = runDir(runId, options.runsRoot);
    const config = await readJson<RunConfig>(runConfigPath(runDirPath));
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
    const runDirPath = runDir(runId, options.runsRoot);
    if (options.allowVisible || options.allowKill) {
      const config = await readJson<RunConfig>(runConfigPath(runDirPath));
      applyRunOverrides(config, {
        allowVisible: options.allowVisible ? true : undefined,
        allowKill: options.allowKill ? true : undefined,
      });
      await saveRunConfig(config.runPath, config);
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
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
    await writeJsonAtomic(path.join(runDirPath, "cancel.json"), {
      canceledAt: nowIso(),
    });
    // eslint-disable-next-line no-console
    console.log(`Canceled: ${runId}`);
  });

program
  .command("watch")
  .description("Watch a run until completion")
  .argument("<run_id>", "run id")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
    let lastState = "";
    while (true) {
      const status = await readJson<StatusPayload>(statusPath(runDirPath));
      if (`${status.state}:${status.stage}` !== lastState) {
        // eslint-disable-next-line no-console
        console.log(
          `${status.state} (${status.stage}) ${status.message ?? ""}`.trim(),
        );
        lastState = `${status.state}:${status.stage}`;
      }
      if (["completed", "failed", "canceled"].includes(status.state)) {
        break;
      }
      await sleep(1000);
    }
  });

program
  .command("open")
  .description("Open a visible browser window for a run (login / recovery)")
  .argument("<run_id>", "run id")
  .option("--runs-root <dir>", "Runs root directory", defaultRunsRoot())
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
    const config = await readJson<RunConfig>(runConfigPath(runDirPath));
    if (config.browser === "chrome" && !config.debugPort) {
      config.debugPort = await getFreePort();
      await saveRunConfig(config.runPath, config);
    }
    await openVisible(config);
    // eslint-disable-next-line no-console
    console.log(`Opened browser for ${runId}`);
  });

program.parseAsync(argv).catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
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
      throw new Error("run not found");
    }
  }

  const promptFromOptions = await loadPromptFromOptions(
    options.prompt,
    options.promptFile,
  );
  let prompt =
    promptFromOptions ?? (promptParts.length ? promptParts.join(" ") : null);
  if (!prompt) {
    prompt = await readPromptFromStdin();
  }
  if (!prompt) {
    throw new Error("Prompt is required");
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

async function loadPromptFromOptions(
  prompt?: string,
  promptFile?: string,
): Promise<string | null> {
  if (prompt !== undefined) {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("Prompt is empty");
    return prompt;
  }
  if (promptFile) {
    const content = (await readJsonOrText(promptFile))?.trim() ?? "";
    if (!content) throw new Error("Prompt file is empty");
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
  throw new Error(`Unknown thinking mode: ${input}`);
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

async function openVisible(config: RunConfig): Promise<void> {
  const { spawn } = await import("child_process");
  if (config.browser === "chrome") {
    const args: string[] = [];
    args.push("--no-first-run", "--no-default-browser-check");
    args.push(`--user-data-dir=${config.profile.userDataDir}`);
    if (config.profile.profileDir)
      args.push(`--profile-directory=${config.profile.profileDir}`);
    if (config.debugPort)
      args.push(`--remote-debugging-port=${config.debugPort}`);
    if (config.conversationUrl) args.push(config.conversationUrl);
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
    if (config.conversationUrl) args.push(config.conversationUrl);
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
