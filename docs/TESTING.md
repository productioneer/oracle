# Testing & Selector Sync

## Real ChatGPT Validation

1. Run a prompt against the real interface:

```
node dist/cli.js run "Hello"
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

- Prompt input: `#prompt-textarea`
- Send button: `button[data-testid="send-button"]`
- Message wrappers: `[data-message-author-role="user|assistant"]`
- Stop button: button text/aria containing "Stop"
- Action buttons: `[data-testid="good-response-turn-action-button"]`, `[data-testid="bad-response-turn-action-button"]`

When ChatGPT changes:

1. Update selectors in `src/browser/chatgpt.ts`.
2. Update mock HTML so selectors stay aligned.
3. Re-run mock tests and a real ChatGPT validation.

## Long-Run Validation

Use the mock `stall=1` query to simulate a streaming stall and confirm refresh behavior:

```
ORACLE_DEV=1 node dist/cli.js run "stall" --base-url http://127.0.0.1:7777/?stall=1 --timeout-ms 120000
```

For a 2h+ streaming run, use `durationMs` on the mock server and raise the timeout:

```
ORACLE_DEV=1 node dist/cli.js run "long" --base-url http://127.0.0.1:7777/?durationMs=7200000 --timeout-ms 7800000
```

## Structured Output Extraction

Automated extraction tests validate JSON/XML/exact-string outputs using headless Chromium.

First, install the Playwright browser binary (one-time):

```
npx playwright install chromium
```

Then run the tests:

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
ORACLE_CAPTURE_HTML=1 node dist/cli.js run "Hello"
```
