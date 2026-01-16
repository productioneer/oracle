#!/usr/bin/env node
import crypto from 'crypto';
import path from 'path';
import { Command } from 'commander';
import { defaultRunsRoot, runDir, statusPath, resultPath, resultJsonPath, logPath, runConfigPath } from './run/paths.js';
import { saveRunConfig, saveStatus } from './run/state.js';
import type { RunConfig, StatusPayload, ResultPayload } from './run/types.js';
import { ensureDir, readJson, pathExists, writeJsonAtomic } from './utils/fs.js';
import { nowIso, sleep } from './utils/time.js';
import { chromeUserDataDirMac, listChromeProfilesMac, firefoxProfilesMac, oracleChromeDataDir } from './browser/profiles.js';
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
  .option('--base-url <url>', 'ChatGPT base URL', DEFAULT_BASE_URL)
  .option('--profile-name <name>', 'Chrome profile name (UI-visible)')
  .option('--profile-dir <dir>', 'Chrome profile directory name, e.g. "Profile 2"')
  .option('--user-data-dir <dir>', 'Chrome user data dir', oracleChromeDataDir())
  .option('--firefox-profile <path>', 'Firefox profile path')
  .option('--runs-root <dir>', 'Runs root directory', defaultRunsRoot())
  .option('--allow-visible', 'Allow visible window for login', false)
  .option('--allow-kill', 'Allow killing automation Chrome if stuck', false)
  .option('--poll-ms <ms>', 'Polling interval for streaming', '1500')
  .option('--stable-ms <ms>', 'Stable interval to finalize response', '8000')
  .option('--stall-ms <ms>', 'Stall interval while generating before recovery', '120000')
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

    let userDataDir = options.userDataDir as string;
    if (options.profileName && userDataDir === oracleChromeDataDir()) {
      userDataDir = chromeUserDataDirMac();
    }

    const profile = resolveProfile({
      browser,
      profileName: options.profileName,
      profileDir: options.profileDir,
      userDataDir,
      firefoxProfile: options.firefoxProfile,
    });

    const config: RunConfig = {
      runId,
      createdAt: nowIso(),
      prompt,
      promptHash,
      browser,
      profile,
      headless: false,
      baseUrl: options.baseUrl,
      allowVisible: Boolean(options.allowVisible),
      allowKill: Boolean(options.allowKill),
      pollMs: Number(options.pollMs),
      stableMs: Number(options.stableMs),
      stallMs: Number(options.stallMs),
      timeoutMs: Number(options.timeoutMs),
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
  .action(async (runId, options) => {
    const runDirPath = runDir(runId, options.runsRoot);
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
  .command('profiles')
  .description('List available browser profiles')
  .option('--user-data-dir <dir>', 'Chrome user data dir', chromeUserDataDirMac())
  .option('--json', 'Output JSON', false)
  .action(async (options) => {
    const chromeProfiles = listChromeProfilesMac(options.userDataDir);
    const firefoxProfiles = firefoxProfilesMac();
    if (options.json) {
      writeJson({ chrome: chromeProfiles, firefox: firefoxProfiles });
      return;
    }
    // eslint-disable-next-line no-console
    console.log('Chrome profiles:');
    for (const profile of chromeProfiles) {
      // eslint-disable-next-line no-console
      console.log(`- ${profile.name} (${profile.dir})`);
    }
    // eslint-disable-next-line no-console
    console.log('Firefox profiles:');
    for (const profile of firefoxProfiles) {
      // eslint-disable-next-line no-console
      console.log(`- ${profile.name} (${profile.path})`);
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
  profileName?: string;
  profileDir?: string;
  userDataDir?: string;
  firefoxProfile?: string;
}): RunConfig['profile'] {
  if (input.browser === 'firefox') {
    const profiles = firefoxProfilesMac();
    const resolvedProfile = input.firefoxProfile ?? profiles[0]?.path;
    if (!resolvedProfile) {
      throw new Error('Firefox profile not found. Provide --firefox-profile or create one.');
    }
    return {
      kind: 'firefox',
      userDataDir: resolvedProfile,
      profileDir: resolvedProfile,
      profileName: input.profileName ?? profiles[0]?.name,
    };
  }

  if (input.profileName) {
    const profiles = listChromeProfilesMac(input.userDataDir ?? chromeUserDataDirMac());
    const matches = profiles.filter((profile) => profile.name === input.profileName);
    if (matches.length !== 1) {
      throw new Error(`Profile name "${input.profileName}" matched ${matches.length} profiles`);
    }
    return {
      kind: 'chrome',
      userDataDir: input.userDataDir ?? chromeUserDataDirMac(),
      profileDir: matches[0].dir,
      profileName: matches[0].name,
    };
  }

  return {
    kind: 'chrome',
    userDataDir: input.userDataDir ?? chromeUserDataDirMac(),
    profileDir: input.profileDir,
    profileName: input.profileName,
  };
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
    spawn('open', ['-n', '-a', 'Firefox', '--args', ...args], { stdio: 'ignore', detached: true }).unref();
  }
}
