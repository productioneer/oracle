#!/usr/bin/env node
import crypto from 'crypto';
import path from 'path';
import { Command } from 'commander';
import { defaultRunsRoot, runDir, statusPath, resultPath, resultJsonPath, logPath, runConfigPath } from './run/paths.js';
import { saveRunConfig, saveStatus } from './run/state.js';
import { applyRunOverrides, resolveStallMs } from './run/options.js';
import type { RunConfig, StatusPayload, ResultPayload } from './run/types.js';
import { ensureDir, readJson, pathExists, writeJsonAtomic } from './utils/fs.js';
import { nowIso, sleep } from './utils/time.js';
import { oracleChromeDataDir, oracleFirefoxDataDir } from './browser/profiles.js';
import { resolveFirefoxApp } from './browser/firefox-app.js';
import { DEFAULT_BASE_URL } from './browser/chatgpt.js';

const program = new Command();

program
  .name('oracle')
  .description('Browser-based tool for AI agents to query GPT via ChatGPT web interface.')
  .version('0.1.0');

program
  .command('run')
  .description('Start a new oracle run in the background')
  .option('-p, --prompt <prompt>', 'prompt text to submit')
  .option('--prompt-file <path>', 'path to prompt file')
  .option('--browser <browser>', 'chrome or firefox', 'chrome')
  .option('--base-url <url>', 'ChatGPT base URL (override ORACLE_BASE_URL/ORACLE_EVAL_BASE_URL)')
  .option('--firefox-profile <path>', 'Firefox profile path (defaults to ~/.oracle/firefox)')
  .option('--firefox-app <path>', 'Firefox app bundle or binary path (Developer Edition / Nightly)')
  .option('--runs-root <dir>', 'Runs root directory', defaultRunsRoot())
  .option('--allow-visible', 'Allow visible window for login', false)
  .option('--focus-only', 'Run focus setup only (no navigation)', false)
  .option('--allow-kill', 'Allow killing automation Chrome if stuck', false)
  .option('--poll-ms <ms>', 'Polling interval for streaming', '1500')
  .option('--stable-ms <ms>', 'Stable interval to finalize response', '8000')
  .option('--stall-ms <ms>', 'Stall interval while generating before recovery (defaults to 20% of timeout, min 2m, max 30m)')
  .option('--timeout-ms <ms>', 'Max wait time for completion', `${2 * 60 * 60 * 1000}`)
  .option('--max-attempts <n>', 'Max attempts', '3')
  .option('--json', 'Output machine-readable JSON', false)
  .action(async (options) => {
    const prompt = await loadPrompt(options.prompt, options.promptFile);
    const runId = generateRunId();
    const runDirPath = runDir(runId, options.runsRoot);
    await ensureDir(runDirPath);

    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    const browser = options.browser === 'firefox' ? 'firefox' : 'chrome';

    const profile = resolveProfile({
      browser,
      firefoxProfile: options.firefoxProfile,
    });
    const firefoxApp = browser === 'firefox' ? resolveFirefoxApp(options.firefoxApp) : undefined;

    const baseUrl = resolveBaseUrl(options.baseUrl);
    const config: RunConfig = {
      runId,
      createdAt: nowIso(),
      prompt,
      promptHash,
      browser,
      profile,
      firefoxApp,
      headless: false,
      baseUrl,
      allowVisible: Boolean(options.allowVisible),
      focusOnly: Boolean(options.focusOnly),
      allowKill: Boolean(options.allowKill),
      pollMs: Number(options.pollMs),
      stableMs: Number(options.stableMs),
      timeoutMs: Number(options.timeoutMs),
      stallMs: resolveStallMs(Number(options.timeoutMs), options.stallMs ? Number(options.stallMs) : undefined),
      attempt: 1,
      maxAttempts: Number(options.maxAttempts),
      outDir: runDirPath,
      statusPath: statusPath(runDirPath),
      resultPath: resultPath(runDirPath),
      resultJsonPath: resultJsonPath(runDirPath),
      logPath: logPath(runDirPath),
      runPath: runConfigPath(runDirPath),
    };

    await saveRunConfig(config.runPath, config);
    await saveStatus(config.statusPath, {
      runId: config.runId,
      state: 'starting',
      stage: 'init',
      message: 'queued',
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
  .command('status')
  .description('Get status for a run')
  .argument('<run_id>', 'run id')
  .option('--runs-root <dir>', 'Runs root directory', defaultRunsRoot())
  .option('--json', 'Output JSON', false)
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
    const status = await readJson<StatusPayload>(statusPath(runDirPath));
    if (options.json) {
      writeJson(status);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`${status.state} (${status.stage}) ${status.message ?? ''}`.trim());
  });

program
  .command('result')
  .description('Print result for a run')
  .argument('<run_id>', 'run id')
  .option('--runs-root <dir>', 'Runs root directory', defaultRunsRoot())
  .option('--json', 'Output JSON metadata', false)
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
    if (options.json) {
      const result = await readJson<ResultPayload>(resultJsonPath(runDirPath));
      writeJson(result);
      return;
    }
    const mdPath = resultPath(runDirPath);
    if (await pathExists(mdPath)) {
      const { promises: fs } = await import('fs');
      const markdown = await fs.readFile(mdPath, 'utf8');
      // eslint-disable-next-line no-console
      console.log(markdown);
      return;
    }
    const content = await readJson<ResultPayload>(resultJsonPath(runDirPath));
    // eslint-disable-next-line no-console
    console.log(content.content ?? '');
  });

program
  .command('resume')
  .description('Resume a run')
  .argument('<run_id>', 'run id')
  .option('--runs-root <dir>', 'Runs root directory', defaultRunsRoot())
  .option('--allow-visible', 'Allow visible window for login', false)
  .option('--allow-kill', 'Allow killing automation Chrome if stuck', false)
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
  .command('cancel')
  .description('Cancel a run')
  .argument('<run_id>', 'run id')
  .option('--runs-root <dir>', 'Runs root directory', defaultRunsRoot())
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
    await writeJsonAtomic(path.join(runDirPath, 'cancel.json'), { canceledAt: nowIso() });
    // eslint-disable-next-line no-console
    console.log(`Canceled: ${runId}`);
  });

program
  .command('watch')
  .description('Watch a run until completion')
  .argument('<run_id>', 'run id')
  .option('--runs-root <dir>', 'Runs root directory', defaultRunsRoot())
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
    let lastState = '';
    while (true) {
      const status = await readJson<StatusPayload>(statusPath(runDirPath));
      if (`${status.state}:${status.stage}` !== lastState) {
        // eslint-disable-next-line no-console
        console.log(`${status.state} (${status.stage}) ${status.message ?? ''}`.trim());
        lastState = `${status.state}:${status.stage}`;
      }
      if (['completed', 'failed', 'canceled'].includes(status.state)) {
        break;
      }
      await sleep(1000);
    }
  });

program
  .command('open')
  .description('Open a visible browser window for a run (login / recovery)')
  .argument('<run_id>', 'run id')
  .option('--runs-root <dir>', 'Runs root directory', defaultRunsRoot())
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
    const config = await readJson<RunConfig>(runConfigPath(runDirPath));
    if (config.browser === 'chrome' && !config.debugPort) {
      config.debugPort = await getFreePort();
      await saveRunConfig(config.runPath, config);
    }
    await openVisible(config);
    // eslint-disable-next-line no-console
    console.log(`Opened browser for ${runId}`);
  });

program.parseAsync(process.argv).catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function loadPrompt(prompt?: string, promptFile?: string): Promise<string> {
  if (prompt) {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error('Prompt is empty');
    return prompt;
  }
  if (promptFile) {
    const content = (await readJsonOrText(promptFile))?.trim() ?? '';
    if (!content) throw new Error('Prompt file is empty');
    return content;
  }
  throw new Error('Prompt is required (--prompt or --prompt-file)');
}

async function readJsonOrText(filePath: string): Promise<string> {
  const raw = await pathExists(filePath) ? await import('fs').then((fsModule) => fsModule.promises.readFile(filePath, 'utf8')) : '';
  return raw;
}

function generateRunId(): string {
  const rand = crypto.randomBytes(4).toString('hex');
  return `${Date.now().toString(36)}-${rand}`;
}

function resolveProfile(input: {
  browser: 'chrome' | 'firefox';
  firefoxProfile?: string;
}): RunConfig['profile'] {
  if (input.browser === 'firefox') {
    const resolvedProfile = input.firefoxProfile ?? oracleFirefoxDataDir();
    return {
      kind: 'firefox',
      userDataDir: resolvedProfile,
      profileDir: resolvedProfile,
    };
  }
  return {
    kind: 'chrome',
    userDataDir: oracleChromeDataDir(),
  };
}

function resolveBaseUrl(input?: string): string {
  if (input) return input;
  const env = process.env.ORACLE_BASE_URL ?? process.env.ORACLE_EVAL_BASE_URL;
  if (env && env.trim()) return env.trim();
  return DEFAULT_BASE_URL;
}

async function spawnWorker(runDirPath: string): Promise<void> {
  const baseDir = path.resolve(__dirname, '..');
  const distWorker = path.join(baseDir, 'dist', 'worker.js');
  const useDist = await pathExists(distWorker);
  const { spawn } = await import('child_process');

  const command = useDist ? 'node' : 'npx';
  const args = useDist
    ? [distWorker, '--run-dir', runDirPath]
    : ['tsx', path.join(baseDir, 'src', 'worker.ts'), '--run-dir', runDirPath];

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function writeJson(payload: unknown): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function openVisible(config: RunConfig): Promise<void> {
  const { spawn } = await import('child_process');
  if (config.browser === 'chrome') {
    const args: string[] = [];
    args.push('--no-first-run', '--no-default-browser-check');
    args.push(`--user-data-dir=${config.profile.userDataDir}`);
    if (config.profile.profileDir) args.push(`--profile-directory=${config.profile.profileDir}`);
    if (config.debugPort) args.push(`--remote-debugging-port=${config.debugPort}`);
    if (config.conversationUrl) args.push(config.conversationUrl);
    spawn('open', ['-n', '-a', 'Google Chrome', '--args', ...args], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  if (config.browser === 'firefox') {
    const args: string[] = [];
    if (config.profile.profileDir) {
      args.push('-profile', config.profile.profileDir);
    }
    if (config.conversationUrl) args.push(config.conversationUrl);
    const appPath = config.firefoxApp?.appPath ?? 'Firefox';
    spawn('open', ['-n', '-a', appPath, '--args', ...args], { stdio: 'ignore', detached: true }).unref();
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
