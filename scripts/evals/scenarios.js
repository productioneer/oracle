#!/usr/bin/env node
/**
 * Comprehensive Oracle CLI agent eval scenarios.
 *
 * Each scenario is a self-contained test: it provides a task prompt for the agent,
 * defines success criteria, and specifies what mock server configuration to use.
 *
 * The agent receives the oracle-tool.md documentation + the scenario task.
 * Success is judged by: correct command sequence, correct output parsing,
 * proper error handling, and efficiency (minimal commands).
 */

const scenarios = [
  // --- Happy Path ---
  {
    id: 'happy-path',
    name: 'Basic run → watch → result',
    mockUrl: '/?durationMs=500',
    task: (nonce) => `Use oracle to run prompt "eval-happy ${nonce}". Wait for completion. Return JSON: {"run_id":"...","result":"..."} with the echo text.`,
    validate: (result, nonce) => {
      const expected = `Echo: eval-happy ${nonce}`;
      return {
        echoFound: result.rawOutput.includes(expected) || result.assistantText.includes(expected),
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
        efficientCommands: result.oracleCommandCount <= 4,
      };
    },
    maxCommands: 4,
    expectedMinCommands: 3,
  },

  // --- Cancel Flow ---
  {
    id: 'cancel-flow',
    name: 'Start a run then cancel it',
    mockUrl: '/?scenario=stall&durationMs=999999',
    task: (nonce) => `Use oracle to run prompt "eval-cancel ${nonce}" with --json. Then immediately cancel the run. Return JSON: {"run_id":"...","canceled":true}.`,
    validate: (result) => {
      return {
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedCancel: result.commandLines.some(c => c.includes('oracle cancel')),
        reportedCanceled: result.assistantText.includes('cancel') || result.assistantText.includes('"canceled"'),
        efficientCommands: result.oracleCommandCount <= 3,
      };
    },
    maxCommands: 4,
    expectedMinCommands: 2,
  },

  // --- Status Checking ---
  {
    id: 'status-check',
    name: 'Check status before watching',
    mockUrl: '/?durationMs=500',
    task: (nonce) => `Use oracle to run prompt "eval-status ${nonce}" with --json. Then check the run status. Then watch it. Then get the result. Return JSON: {"run_id":"...","status":"...","result":"..."}.`,
    validate: (result) => {
      // Echo check: look for "Echo:" anywhere in output (nonce may be mangled by agent)
      const echoInOutput = result.rawOutput.includes('Echo:') || result.assistantText.includes('Echo:');
      return {
        echoFound: echoInOutput,
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedStatus: result.commandLines.some(c => c.includes('oracle status')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
      };
    },
    maxCommands: 6,
    expectedMinCommands: 4,
  },

  // --- Thinking Retrieval ---
  {
    id: 'thinking-retrieval',
    name: 'Retrieve thinking output',
    mockUrl: '/?durationMs=500',
    agentTimeoutMs: 240000,
    task: (nonce) => `Use oracle to run prompt "eval-thinking ${nonce}" with --json. Wait for completion. Get the thinking output (use "oracle thinking <run_id> --full" — it prints to stdout). Then get the result. Return JSON: {"run_id":"...","thinking":"...","result":"..."}.`,
    validate: (result, nonce) => {
      return {
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedThinking: result.commandLines.some(c => c.includes('oracle thinking')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
        echoFound: result.rawOutput.includes(`eval-thinking ${nonce}`) || result.assistantText.includes(`eval-thinking ${nonce}`),
      };
    },
    maxCommands: 6,
    expectedMinCommands: 4,
  },

  // --- Follow-up Messages ---
  {
    id: 'follow-up',
    name: 'Send a follow-up message to same conversation',
    mockUrl: '/?durationMs=500',
    task: (nonce) => `Use oracle to run prompt "eval-followup-1 ${nonce}" with --json. Wait for completion and get the result. Then send a follow-up message "eval-followup-2 ${nonce}" to the SAME run_id. Wait for that to complete and get its result too. Return JSON: {"run_id":"...","result1":"...","result2":"..."}.`,
    validate: (result, nonce) => {
      return {
        usedRunTwice: result.commandLines.filter(c => c.includes('oracle run')).length >= 2,
        followUpUsedRunId: result.commandLines.some(c => c.includes('oracle run') && c.match(/[a-z0-9]+-[a-f0-9]+/)),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
        echoFound1: result.rawOutput.includes(`eval-followup-1 ${nonce}`),
        echoFound2: result.rawOutput.includes(`eval-followup-2 ${nonce}`),
      };
    },
    maxCommands: 8,
    expectedMinCommands: 6,
  },

  // --- Invalid Input: Missing Prompt ---
  {
    id: 'error-no-prompt',
    name: 'Handle missing prompt error gracefully',
    mockUrl: '/?durationMs=500',
    task: () => `Try to use oracle to start a run WITHOUT providing any prompt (just "oracle run --json" with no prompt). Observe the error. Then start a proper run with prompt "recovery test", watch it, and get the result. Return JSON: {"error_code":"...","recovery_result":"..."}.`,
    validate: (result) => {
      return {
        sawError: result.commandLines.some(c => c.match(/oracle run\b.*--json/) && !c.includes('"') && !c.includes("'")),
        recoveredWithPrompt: result.commandLines.some(c => c.includes('oracle run') && c.includes('recovery test')),
        reportedErrorCode: result.assistantText.includes('PROMPT_REQUIRED') || result.assistantText.includes('No prompt') || result.rawOutput.includes('PROMPT_REQUIRED'),
      };
    },
    maxCommands: 8,
    expectedMinCommands: 4,
  },

  // --- Invalid Input: Bad Run ID ---
  {
    id: 'error-bad-run-id',
    name: 'Handle invalid run_id gracefully',
    mockUrl: '/?durationMs=500',
    task: () => `Try to check the status of a non-existent oracle run with id "nonexistent-fakeid" using "oracle status nonexistent-fakeid --json". Observe and report the error. Return JSON: {"error_code":"...","message":"..."}.`,
    validate: (result) => {
      return {
        triedBadId: result.commandLines.some(c => c.includes('nonexistent-fakeid')),
        reportedError: result.assistantText.includes('RUN_NOT_FOUND') || result.assistantText.includes('not found'),
        didNotRetry: result.commandLines.filter(c => c.includes('nonexistent-fakeid')).length <= 2,
      };
    },
    maxCommands: 3,
    expectedMinCommands: 1,
  },

  // --- Attachment Handling ---
  {
    id: 'attachment-ref',
    name: 'Run with @file reference',
    mockUrl: '/?durationMs=500',
    task: (nonce, opts) => `Create a small temp file at ${opts.tempFile} with content "test data ${nonce}". Then use oracle to run a prompt that references it: "Analyze @${opts.tempFile}" with --json. Wait for completion and get the result. Return JSON: {"run_id":"...","result":"..."}.`,
    validate: (result) => {
      return {
        createdFile: result.commandLines.some(c => c.includes('echo') || c.includes('cat') || c.includes('printf') || c.includes('write')),
        usedAtRef: result.commandLines.some(c => c.includes('oracle run') && c.includes('@')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
      };
    },
    maxCommands: 6,
    expectedMinCommands: 4,
    extraOpts: (tmpDir) => ({ tempFile: `${tmpDir}/eval-attachment.txt` }),
  },

  // --- Response Failure (browser-level) ---
  {
    id: 'response-failure',
    name: 'Handle browser-level response failure',
    mockUrl: '/?scenario=fail&durationMs=20000',
    task: (nonce) => `Use oracle to run prompt "eval-fail ${nonce}" with --json. Then watch the run with "oracle watch <run_id> --json". The response may fail at the browser level. Report the outcome. Return JSON: {"run_id":"...","state":"...","error":"..."}.`,
    validate: (result) => {
      return {
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        sawFailed: result.rawOutput.includes('"failed"') || result.rawOutput.includes('failed') ||
                   result.assistantText.includes('failed'),
        reportedState: result.assistantText.includes('failed') || result.assistantText.includes('error'),
        efficientCommands: result.oracleCommandCount <= 5,
      };
    },
    maxCommands: 6,
    expectedMinCommands: 2,
  },

  // --- Error Text in Response ---
  {
    id: 'error-text-response',
    name: 'Detect ChatGPT error message in response text',
    mockUrl: '/?scenario=error_text',
    task: (nonce) => `Use oracle to run prompt "eval-errtext ${nonce}" with --json. Watch it, then get the result. Examine the response text carefully — it may contain an error from ChatGPT rather than a real answer. Report what you find. Return JSON: {"run_id":"...","result":"...","is_chatgpt_error":true|false}.`,
    validate: (result) => {
      return {
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
        detectedError: result.assistantText.toLowerCase().includes('error') &&
                       (result.assistantText.includes('is_chatgpt_error') || result.assistantText.includes('true')),
      };
    },
    maxCommands: 5,
    expectedMinCommands: 3,
  },

  // --- Multiple File Attachments ---
  {
    id: 'multi-file-attachment',
    name: 'Run with multiple @file references',
    mockUrl: '/?durationMs=500',
    task: (nonce, opts) => `Create three small temp files:
- ${opts.tempFile1} with content "alpha data ${nonce}"
- ${opts.tempFile2} with content "beta data ${nonce}"
- ${opts.tempFile3} with content "gamma data ${nonce}"
Then use oracle to run a prompt that references all three: "Analyze @${opts.tempFile1} @${opts.tempFile2} @${opts.tempFile3}" with --json. Wait for completion and get the result. Return JSON: {"run_id":"...","result":"..."}.`,
    validate: (result) => {
      return {
        createdFiles: result.commandLines.filter(c =>
          c.includes('echo') || c.includes('cat') || c.includes('printf') || c.includes('write') || c.includes('>')
        ).length >= 1,
        usedMultipleAtRefs: (() => {
          const runCmd = result.commandLines.find(c => c.includes('oracle run'));
          if (!runCmd) return false;
          const atCount = (runCmd.match(/@/g) || []).length;
          return atCount >= 3;
        })(),
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
      };
    },
    maxCommands: 8,
    expectedMinCommands: 5,
    extraOpts: (tmpDir) => ({
      tempFile1: `${tmpDir}/eval-multi-1.txt`,
      tempFile2: `${tmpDir}/eval-multi-2.txt`,
      tempFile3: `${tmpDir}/eval-multi-3.txt`,
    }),
  },

  // --- File Range Inline ---
  {
    id: 'file-range-inline',
    name: 'Run with @file:N-M line range syntax',
    mockUrl: '/?durationMs=500',
    task: (nonce, opts) => `Create a temp file at ${opts.tempFile} with 20 lines of content (line 1: "line-1 ${nonce}", line 2: "line-2 ${nonce}", etc. up to line 20). Then use oracle to run a prompt that references lines 5-10 of that file: "Review @${opts.tempFile}:5-10" with --json. Wait for completion and get the result. Return JSON: {"run_id":"...","result":"..."}.`,
    validate: (result, nonce) => {
      return {
        createdFile: result.commandLines.some(c =>
          c.includes('echo') || c.includes('printf') || c.includes('>') || c.includes('write') || c.includes('for') || c.includes('seq')
        ),
        usedLineRange: result.commandLines.some(c =>
          c.includes('oracle run') && c.match(/:5-10\b/)
        ),
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
      };
    },
    maxCommands: 6,
    expectedMinCommands: 4,
    extraOpts: (tmpDir) => ({ tempFile: `${tmpDir}/eval-range.txt` }),
  },

  // --- Invalid File Reference ---
  {
    id: 'error-invalid-file-ref',
    name: 'Handle invalid @file reference gracefully',
    mockUrl: '/?durationMs=500',
    task: (nonce) => `Try to use oracle to run a prompt that references a non-existent file: "Analyze @/tmp/oracle-nonexistent-${nonce}.txt" with --json. Observe and report the error. Then run a proper prompt "recovery ${nonce}" with --json, watch it, and get the result. Return JSON: {"file_error":"...","recovery_run_id":"...","recovery_result":"..."}.`,
    validate: (result, nonce) => {
      return {
        triedBadFile: result.commandLines.some(c =>
          c.includes('oracle run') && c.includes('nonexistent')
        ),
        sawFileError: result.rawOutput.includes('not found') || result.rawOutput.includes('File not found') ||
                      result.assistantText.includes('not found') || result.assistantText.includes('File not found'),
        recoveredWithPrompt: result.commandLines.some(c =>
          c.includes('oracle run') && c.includes('recovery')
        ),
        didNotRetryBadFile: result.commandLines.filter(c =>
          c.includes('nonexistent')
        ).length <= 2,
      };
    },
    maxCommands: 8,
    expectedMinCommands: 4,
  },

  // --- Concurrent Runs ---
  {
    id: 'concurrent-runs',
    name: 'Start and manage two concurrent runs',
    mockUrl: '/?durationMs=1000',
    task: (nonce) => `Start TWO oracle runs concurrently:
1. Run prompt "eval-concurrent-A ${nonce}" with --json
2. Run prompt "eval-concurrent-B ${nonce}" with --json
Then watch both runs and get both results. Return JSON: {"run_id_a":"...","run_id_b":"...","result_a":"...","result_b":"..."}.
Important: Start both runs before watching either one.`,
    validate: (result, nonce) => {
      const runCommands = result.commandLines.filter(c => c.includes('oracle run'));
      const watchCommands = result.commandLines.filter(c => c.includes('oracle watch'));
      const resultCommands = result.commandLines.filter(c => c.includes('oracle result'));
      return {
        startedTwoRuns: runCommands.length >= 2,
        watchedBoth: watchCommands.length >= 2,
        gotBothResults: resultCommands.length >= 2,
        echoFoundA: result.rawOutput.includes(`eval-concurrent-A ${nonce}`) || result.assistantText.includes('concurrent-A'),
        echoFoundB: result.rawOutput.includes(`eval-concurrent-B ${nonce}`) || result.assistantText.includes('concurrent-B'),
      };
    },
    maxCommands: 10,
    expectedMinCommands: 6,
  },

  // --- Cancel Completed Run ---
  {
    id: 'error-cancel-completed',
    name: 'Handle cancel on already-completed run',
    mockUrl: '/?durationMs=300',
    task: (nonce) => `Use oracle to run prompt "eval-cancel-done ${nonce}" with --json. Watch it to completion. Then try to cancel it (it should fail since it is already completed). Report the error. Return JSON: {"run_id":"...","result":"...","cancel_error":"..."}.`,
    validate: (result) => {
      return {
        usedRun: result.commandLines.some(c => c.includes('oracle run')),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
        triedCancel: result.commandLines.some(c => c.includes('oracle cancel')),
        sawTerminalError: result.rawOutput.includes('RUN_TERMINAL') || result.rawOutput.includes('already') ||
                          result.assistantText.includes('RUN_TERMINAL') || result.assistantText.includes('already completed'),
      };
    },
    maxCommands: 6,
    expectedMinCommands: 4,
  },

  // --- Prompt File Option ---
  {
    id: 'prompt-file',
    name: 'Run with --prompt-file option',
    mockUrl: '/?durationMs=500',
    task: (nonce, opts) => `Create a temp file at ${opts.promptFile} containing the text "eval-promptfile ${nonce}". Then use oracle with the --prompt-file flag to start a run: "oracle run --prompt-file ${opts.promptFile} --json". Watch it and get the result. Return JSON: {"run_id":"...","result":"..."}.`,
    validate: (result, nonce) => {
      const expected = `eval-promptfile ${nonce}`;
      return {
        createdPromptFile: result.commandLines.some(c =>
          c.includes('echo') || c.includes('printf') || c.includes('>') || c.includes('write')
        ),
        usedPromptFile: result.commandLines.some(c =>
          c.includes('oracle run') && c.includes('--prompt-file')
        ),
        usedWatch: result.commandLines.some(c => c.includes('oracle watch')),
        usedResult: result.commandLines.some(c => c.includes('oracle result')),
        echoFound: result.rawOutput.includes(expected) || result.assistantText.includes(expected),
      };
    },
    maxCommands: 6,
    expectedMinCommands: 4,
    extraOpts: (tmpDir) => ({ promptFile: `${tmpDir}/eval-prompt.txt` }),
  },
];

module.exports = { scenarios };
