#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');

function waitForReady(proc, token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server timeout')), timeoutMs);
    proc.stdout.on('data', (data) => {
      const text = data.toString('utf8');
      if (text.includes(token)) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function main() {
  const port = Number(process.env.ORACLE_EVAL_PORT || 7777);
  const baseUrl = `http://127.0.0.1:${port}/`;
  const env = { ...process.env, ORACLE_EVAL_BASE_URL: baseUrl, ORACLE_BASE_URL: baseUrl };
  const mockServer = spawn(process.execPath, [path.join(__dirname, '..', 'mock-server.js'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env,
  });

  try {
    await waitForReady(mockServer, `Mock ChatGPT listening on http://127.0.0.1:${port}`);
    if (!process.env.ORACLE_EVAL_SKIP_CODEX) {
      await runCommand(process.execPath, [path.join(__dirname, 'run-codex-agent-eval.js')], env);
    }
    if (!process.env.ORACLE_EVAL_SKIP_CLAUDE) {
      await runCommand(process.execPath, [path.join(__dirname, 'run-claude-agent-eval.js')], env);
    }
  } finally {
    mockServer.kill();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
