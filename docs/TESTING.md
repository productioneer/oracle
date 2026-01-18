# Testing & Selector Sync

## Real ChatGPT Validation

1. Run a prompt against the real interface:

```
node dist/cli.js run --prompt "Hello"
```

Note: Chrome always uses the dedicated Oracle profile at `~/.oracle/chrome`. If you're not logged in yet, use `oracle open`.

2. If `needs_user: login`, run:

```
node dist/cli.js open <run_id>
```

Login, then resume:

```
node dist/cli.js resume <run_id>
```

## Mock Sync Process

The mock server (`scripts/mock-server.js`) mirrors core UI hooks used by automation:

- Prompt input: `textarea#prompt-textarea`
- Message wrappers: `[data-message-author-role="user|assistant"]`
- Stop button: `button[aria-label="Stop generating"]`

When ChatGPT changes:

1. Update selectors in `src/browser/chatgpt.ts`.
2. Update mock HTML so selectors stay aligned.
3. Re-run mock tests and a real ChatGPT validation.

## Long-Run Validation

Use the mock `stall=1` query to simulate a streaming stall and confirm recovery:

```
node dist/cli.js run --prompt "stall" --base-url http://127.0.0.1:7777/?stall=1 --stall-ms 30000 --timeout-ms 120000
```

For a 2h+ streaming run, use `durationMs` on the mock server and raise the timeout:

```
node dist/cli.js run --prompt "long" --base-url http://127.0.0.1:7777/?durationMs=7200000 --timeout-ms 7800000
```

## Structured Output Extraction

Automated extraction tests validate JSON/XML/exact-string outputs using headless Chromium:

```
npm test
```

## Agent SDK Evals (Codex + Claude)

Runs oracle via the mock ChatGPT server (no chatgpt.com). Uses real agents:

```
npm run eval:agents
```

Individual runs:

```
npm run eval:codex
npm run eval:claude
```

Notes:
- Uses the mock server on `127.0.0.1:7777`.
- Codex eval uses `@openai/codex-sdk` (bundled codex binary). Ensure Codex credentials are configured.
- Claude eval shells out to `claude` CLI. Ensure Claude Code is installed and logged in.
- Results are written to `scripts/evals/results/`.
- Eval harness strips any `*_API_KEY` variables from the agent process environment.
- Optional: set `ORACLE_EVAL_SKIP_CLAUDE=1` or `ORACLE_EVAL_SKIP_CODEX=1` to run one agent.
- Optional: set `ORACLE_EVAL_AGENT_TIMEOUT_MS` to cap agent runtime.

## Debug Capture

Set `ORACLE_CAPTURE_HTML=1` to save `completion.html`/`completion.png` for real ChatGPT runs:

```
ORACLE_CAPTURE_HTML=1 node dist/cli.js run --prompt "Hello"
```
