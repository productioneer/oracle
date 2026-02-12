#!/usr/bin/env node
/**
 * Comprehensive scenario-based agent eval runner.
 *
 * Starts a mock server, runs each scenario through Claude CLI,
 * validates results, and writes a summary report.
 *
 * Usage:
 *   node run-scenario-evals.js [--scenario <id>] [--port <n>]
 *
 * Environment:
 *   CLAUDE_MODEL      — model to use (default: opus)
 *   ORACLE_EVAL_AGENT_TIMEOUT_MS — per-scenario timeout (default: 180000)
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { scenarios } = require('./scenarios');

const repoRoot = path.resolve(__dirname, '..', '..');
const toolPath = path.join(__dirname, 'oracle-tool.md');

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeEnv(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (key.endsWith('_API_KEY')) delete next[key];
  }
  return next;
}

function extractRunId(text) {
  if (!text) return null;
  const jsonMatch = text.match(/"run_id"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  const lineMatch = text.match(/Run started:\s*([a-z0-9-]+)/i);
  if (lineMatch) return lineMatch[1];
  return null;
}

function waitForReady(proc, token, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server timeout')), timeoutMs);
    let buf = '';
    proc.stdout.on('data', (data) => {
      buf += data.toString('utf8');
      if (buf.includes(token)) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function runScenario(scenario, port, toolText, tmpDir) {
  const nonce = crypto.randomBytes(4).toString('hex');
  const extraOpts = scenario.extraOpts ? scenario.extraOpts(tmpDir) : {};
  const taskPrompt = scenario.task(nonce, extraOpts);

  const fullPrompt = `${toolText.trim()}

Task:
${taskPrompt}

Constraints:
No file edits except temp files for testing. Commands only. No chatgpt.com.`;

  const baseUrl = `http://127.0.0.1:${port}${scenario.mockUrl || '/'}`;
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
    '-p', '--print', '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--tools', 'Bash',
    '--no-session-persistence',
    '--allowedTools', 'Bash',
  ];
  if (repoRoot) args.push('--add-dir', repoRoot);

  const agentTimeoutMs = scenario.agentTimeoutMs || Number(process.env.ORACLE_EVAL_AGENT_TIMEOUT_MS || 180000);
  const startedAt = Date.now();
  let buffer = '';
  let rawOutput = '';
  let assistantText = '';
  let usage = null;
  let sessionId = null;
  let toolUseCount = 0;
  let oracleCommandCount = 0;
  let firstToolAt = null;
  const commandLines = [];
  const errors = [];

  const child = spawn('claude', args, { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });

  const timeoutId = setTimeout(() => {
    errors.push(`timeout after ${agentTimeoutMs}ms`);
    child.kill('SIGTERM');
  }, agentTimeoutMs);

  child.stdin.write(fullPrompt);
  child.stdin.end();

  const handleLine = (line) => {
    if (!line.trim()) return;
    rawOutput += `${line}\n`;
    let data;
    try { data = JSON.parse(line); } catch { return; }
    if (data.type === 'system' && data.subtype === 'init') {
      sessionId = data.session_id || sessionId;
    }
    if (data.type === 'assistant' && data.message && Array.isArray(data.message.content)) {
      if (data.message.usage && !usage) usage = data.message.usage;
      for (const item of data.message.content) {
        if (item.type === 'text') {
          assistantText += item.text || '';
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
    if (data.type === 'result' && data.usage) usage = data.usage;
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) errors.push(text);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

  clearTimeout(timeoutId);
  if (buffer.trim()) handleLine(buffer);
  const elapsedMs = Date.now() - startedAt;

  const result = {
    rawOutput,
    assistantText,
    commandLines,
    oracleCommandCount,
    toolUseCount,
    exitCode,
    errors,
  };

  const validation = scenario.validate(result, nonce);
  const allPassed = Object.values(validation).every(v => v === true);

  return {
    scenario_id: scenario.id,
    scenario_name: scenario.name,
    started_at: new Date(startedAt).toISOString(),
    duration_ms: elapsedMs,
    agent_timeout_ms: agentTimeoutMs,
    time_to_first_command_ms: firstToolAt ? firstToolAt - startedAt : null,
    session_id: sessionId,
    nonce,
    success: allPassed && exitCode === 0,
    validation,
    usage,
    command_count: toolUseCount,
    oracle_command_count: oracleCommandCount,
    command_lines: commandLines,
    final_text: assistantText.slice(0, 2000),
    exit_code: exitCode,
    errors: errors.slice(0, 10),
  };
}

async function main() {
  const port = Number(getArg('--port') || 7777);
  const scenarioFilter = getArg('--scenario');
  const toolText = await fs.readFile(toolPath, 'utf8');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-eval-'));

  // Filter scenarios if requested
  const toRun = scenarioFilter
    ? scenarios.filter(s => s.id === scenarioFilter)
    : scenarios;

  if (toRun.length === 0) {
    console.error(`No scenario matching: ${scenarioFilter}`);
    console.error(`Available: ${scenarios.map(s => s.id).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // Start mock server
  const mockServer = spawn(process.execPath, [
    path.join(__dirname, '..', 'mock-server.js'), '--port', String(port),
  ], { stdio: ['ignore', 'pipe', 'inherit'] });

  try {
    await waitForReady(mockServer, `Mock ChatGPT listening on http://127.0.0.1:${port}`);
    console.log(`Mock server ready on port ${port}`);
    console.log(`Running ${toRun.length} scenario(s)...\n`);

    const results = [];
    for (const scenario of toRun) {
      console.log(`--- ${scenario.id}: ${scenario.name} ---`);
      const result = await runScenario(scenario, port, toolText, tmpDir);
      results.push(result);

      // Print summary
      const icon = result.success ? '✓' : '✗';
      console.log(`${icon} ${scenario.id} (${result.duration_ms}ms, ${result.oracle_command_count} oracle cmds)`);
      if (!result.success) {
        const failed = Object.entries(result.validation)
          .filter(([, v]) => v !== true)
          .map(([k]) => k);
        console.log(`  Failed checks: ${failed.join(', ')}`);
        if (result.errors.length > 0) {
          console.log(`  Errors: ${result.errors[0]}`);
        }
      }
      console.log(`  Commands: ${result.command_lines.join(' | ')}`);
      console.log('');
    }

    // Write summary
    const summary = {
      run_at: nowIso(),
      total_scenarios: results.length,
      passed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      total_duration_ms: results.reduce((a, r) => a + r.duration_ms, 0),
      results,
    };

    const resultsDir = path.join(__dirname, 'results');
    await fs.mkdir(resultsDir, { recursive: true });
    const stamp = summary.run_at.replace(/[:.]/g, '-');
    const outPath = path.join(resultsDir, `scenarios-${stamp}.json`);
    await fs.writeFile(outPath, JSON.stringify(summary, null, 2));

    console.log('=== SUMMARY ===');
    console.log(`Passed: ${summary.passed}/${summary.total_scenarios}`);
    console.log(`Total time: ${(summary.total_duration_ms / 1000).toFixed(1)}s`);
    console.log(`Report: ${outPath}`);

    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    mockServer.kill();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
