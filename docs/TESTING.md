# Testing & Selector Sync

## Real ChatGPT Validation

1. Run a prompt against the real interface:

```
node dist/cli.js run --prompt "Hello" --profile-name "<Profile>" --user-data-dir "$HOME/Library/Application Support/Google/Chrome"
```

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

## Debug Capture

Set `ORACLE_CAPTURE_HTML=1` to save `completion.html`/`completion.png` for real ChatGPT runs:

```
ORACLE_CAPTURE_HTML=1 node dist/cli.js run --prompt "Hello"
```
