#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_BASE_URL = 'http://127.0.0.1:7777/';

function nowIso() {
  return new Date().toISOString();
}

function sanitizeEnv(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.endsWith('_API_KEY')) {
      delete next[key];
    }
  }
  return next;
}

function makeNonce() {
  return crypto.randomBytes(4).toString('hex');
}

function extractRunId(text) {
  if (!text) return null;
  const jsonMatch = text.match(/"run_id"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  const lineMatch = text.match(/Run started:\s*([a-z0-9-]+)/i);
  if (lineMatch) return lineMatch[1];
  return null;
}

function buildPrompt(toolText, nonce) {
  return `${toolText.trim()}

Task:
Use oracle to run prompt "oracle-eval ${nonce}". Wait for completion.
Return JSON: {"run_id":"...","result":"..."} with the echo text.

Constraints:
No file edits. Commands only. No chatgpt.com.`;
}

async function writeResult(summary) {
  const resultsDir = path.join(__dirname, 'results');
  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = summary.started_at.replace(/[:.]/g, '-');
  const outPath = path.join(resultsDir, `claude-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const toolPath = path.join(__dirname, 'oracle-tool.md');
  const toolText = await fs.readFile(toolPath, 'utf8');
  const nonce = makeNonce();
  const expected = `Echo: oracle-eval ${nonce}`;
  const prompt = buildPrompt(toolText, nonce);

  const baseUrl = process.env.ORACLE_EVAL_BASE_URL || DEFAULT_BASE_URL;
  const oracleHome = process.env.HOME ? path.join(process.env.HOME, '.oracle') : null;
  const env = sanitizeEnv({
    PATH: `${path.join(__dirname, 'bin')}:${process.env.PATH || ''}`,
    HOME: process.env.HOME || '',
    TMPDIR: process.env.TMPDIR || '',
    ORACLE_EVAL_BASE_URL: baseUrl,
    ORACLE_BASE_URL: baseUrl,
    ORACLE_EVAL_TIMEOUT_MS: process.env.ORACLE_EVAL_TIMEOUT_MS || '120000',
    ORACLE_DEV: '1',
  });

  const args = [
    '--model', process.env.CLAUDE_MODEL || 'opus',
    '-p',
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--tools', 'Bash',
    '--no-session-persistence',
  ];
  args.push('--allowedTools', 'Bash');
  if (repoRoot) args.push('--add-dir', repoRoot);
  if (oracleHome) args.push('--add-dir', oracleHome);

  const startedAt = Date.now();
  const startedAtIso = nowIso();
  const agentTimeoutMs = Number(process.env.ORACLE_EVAL_AGENT_TIMEOUT_MS || 180000);
  let buffer = '';
  let rawOutput = '';
  let assistantText = '';
  let usage = null;
  let sessionId = null;
  let toolUseCount = 0;
  let oracleCommandCount = 0;
  let firstToolAt = null;
  let sawEcho = false;
  const commandLines = [];
  const errors = [];

  const child = spawn('claude', args, {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const timeoutId = setTimeout(() => {
    errors.push(`timeout after ${agentTimeoutMs}ms`);
    child.kill('SIGTERM');
  }, agentTimeoutMs);

  child.stdin.write(prompt);
  child.stdin.end();

  const handleLine = (line) => {
    if (!line.trim()) return;
    rawOutput += `${line}\n`;
    let data;
    try {
      data = JSON.parse(line);
    } catch (error) {
      return;
    }
    if (data.type === 'system' && data.subtype === 'init') {
      sessionId = data.session_id || sessionId;
    }
    if (data.type === 'assistant' && data.message && Array.isArray(data.message.content)) {
      if (data.message.usage && !usage) usage = data.message.usage;
      for (const item of data.message.content) {
        if (item.type === 'text') {
          assistantText += item.text || '';
          if (item.text && item.text.includes(expected)) sawEcho = true;
        }
        if (item.type === 'tool_use') {
          toolUseCount += 1;
          if (!firstToolAt) firstToolAt = Date.now();
          const input = item.input || {};
          const command = input.command || input.cmd || (typeof input === 'string' ? input : null);
          if (command) {
            commandLines.push(command);
            if (command.includes('oracle')) oracleCommandCount += 1;
          }
        }
      }
    }
    if (data.type === 'tool_result') {
      const blob = JSON.stringify(data);
      if (blob.includes(expected)) sawEcho = true;
    }
    if (data.type === 'result' && data.usage) {
      usage = data.usage;
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
      idx = buffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => {
    errors.push(chunk.toString('utf8').trim());
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  clearTimeout(timeoutId);
  if (buffer.trim()) handleLine(buffer);
  const elapsedMs = Date.now() - startedAt;
  if (!sawEcho && rawOutput.includes(expected)) sawEcho = true;

  const runId = extractRunId(assistantText) || extractRunId(rawOutput);
  const success = sawEcho && oracleCommandCount > 0 && exitCode === 0;

  await writeResult({
    agent: 'claude',
    started_at: startedAtIso,
    duration_ms: elapsedMs,
    agent_timeout_ms: agentTimeoutMs,
    time_to_first_command_ms: firstToolAt ? firstToolAt - startedAt : null,
    session_id: sessionId,
    nonce,
    expected,
    success,
    run_id: runId,
    usage,
    command_count: toolUseCount,
    oracle_command_count: oracleCommandCount,
    command_lines: commandLines,
    final_text: assistantText,
    exit_code: exitCode,
    errors,
  });

  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
