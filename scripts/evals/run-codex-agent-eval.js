#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

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
  const outPath = path.join(resultsDir, `codex-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(summary, null, 2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

async function main() {
  const { Codex } = await import('@openai/codex-sdk');
  const repoRoot = path.resolve(__dirname, '..', '..');
  const workingDir = process.env.ORACLE_EVAL_WORKDIR || os.tmpdir();
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
    ORACLE_EVAL_BASE_URL: baseUrl,
    ORACLE_BASE_URL: baseUrl,
    ORACLE_EVAL_TIMEOUT_MS: process.env.ORACLE_EVAL_TIMEOUT_MS || '120000',
  });

  const codex = new Codex({ env });
  const thread = codex.startThread({
    workingDirectory: workingDir,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    webSearchEnabled: false,
    webSearchMode: 'disabled',
    networkAccessEnabled: false,
    additionalDirectories: oracleHome ? [oracleHome] : undefined,
  });

  const startedAt = Date.now();
  const startedAtIso = nowIso();
  const agentTimeoutMs = Number(process.env.ORACLE_EVAL_AGENT_TIMEOUT_MS || 180000);
  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), agentTimeoutMs);
  const seenCommands = new Set();
  const seenOracleCommands = new Set();
  let threadId = null;
  let firstCommandAt = null;
  let commandCount = 0;
  let oracleCommandCount = 0;
  let sawEcho = false;
  let finalText = '';
  let usage = null;
  const commandOutputs = [];
  const commandLines = [];
  const errors = [];

  try {
    const { events } = await thread.runStreamed(prompt, { signal: abort.signal });
    for await (const event of events) {
      if (event.type === 'thread.started') {
        threadId = event.thread_id;
      }
      if (event.type === 'turn.failed') {
        errors.push(event.error?.message || 'turn.failed');
      }
      if (event.type === 'error') {
        errors.push(event.message);
      }
      if (event.type === 'turn.completed') {
        usage = event.usage;
      }
      if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
        const item = event.item;
        if (item.type === 'command_execution') {
          if (!seenCommands.has(item.id)) {
            seenCommands.add(item.id);
            commandCount += 1;
          }
          if (item.command && !seenOracleCommands.has(item.id) && item.command.includes('oracle')) {
            seenOracleCommands.add(item.id);
            oracleCommandCount += 1;
          }
          if (!firstCommandAt) firstCommandAt = Date.now();
          if (event.type === 'item.completed') {
            if (item.command) commandLines.push(item.command);
            if (item.aggregated_output) {
              commandOutputs.push(item.aggregated_output);
              if (item.aggregated_output.includes(expected)) sawEcho = true;
            }
          }
        }
        if (event.type === 'item.completed' && item.type === 'agent_message') {
          finalText = item.text || finalText;
          if (item.text && item.text.includes(expected)) sawEcho = true;
        }
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsedMs = Date.now() - startedAt;
  const runId = extractRunId(commandOutputs.join('\n')) || extractRunId(finalText) || null;
  const success = sawEcho && oracleCommandCount > 0;

  await writeResult({
    agent: 'codex',
    started_at: startedAtIso,
    duration_ms: elapsedMs,
    agent_timeout_ms: agentTimeoutMs,
    time_to_first_command_ms: firstCommandAt ? firstCommandAt - startedAt : null,
    thread_id: threadId,
    working_directory: workingDir,
    nonce,
    expected,
    success,
    run_id: runId,
    usage,
    command_count: commandCount,
    oracle_command_count: oracleCommandCount,
    command_lines: commandLines,
    final_text: finalText,
    errors,
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
