# Oracle

Browser-based tool for AI agents to query GPT via the ChatGPT web interface.

## Quick Start

```bash
npm install
npm run build

# run a prompt (background)
node dist/cli.js run --prompt "Hello"

# check status
node dist/cli.js status <run_id>

# watch until completion
node dist/cli.js watch <run_id>

# get result
node dist/cli.js result <run_id>
```

## Core Commands

- `oracle run` — start a run (background worker).
- `oracle status` — read `status.json`.
- `oracle watch` — poll until completion.
- `oracle result` — print result content/metadata.
- `oracle resume` — restart a run using existing state.
- `oracle cancel` — cancel a run.
- `oracle open` — open visible browser window for login/recovery.

## Mock ChatGPT Interface (Evaluation)

Start the mock server:

```bash
node scripts/mock-server.js --port 7777
```

Use it as the base URL:

```bash
node dist/cli.js run --prompt "Hello" --base-url http://127.0.0.1:7777/
```

Simulate long wait / stuck streaming:

```
http://127.0.0.1:7777/?stall=1
```

You can also set `--stall-ms` and `--timeout-ms` when running to test recovery vs. long waits.

## Notes

- Chrome focus-safe launch uses `open -n -g` and `--no-startup-window` with hidden CDP targets.
- Firefox support uses Puppeteer WebDriver BiDi (headful). Focus prevention is best-effort.
- Runs persist state under `~/.oracle/runs/<run_id>` by default.
- Chrome always uses the dedicated Oracle profile at `~/.oracle/chrome` (isolated from your main Chrome).
- Firefox uses a dedicated Oracle profile at `~/.oracle/firefox` by default (override with `--firefox-profile`).
- If login/Cloudflare is detected, `status.json` will be set to `needs_user` and you can run `oracle open <run_id>` to login, then `oracle resume <run_id>`.
- If `needs_user: kill_chrome` is set, resume with `oracle resume <run_id> --allow-kill` after reviewing the prompt.
- Debug artifacts (HTML/PNG) are written to `~/.oracle/runs/<run_id>/debug` when prompt input fails or when running against localhost.
- If Chrome is stuck and you pass `--allow-kill`, Oracle requests graceful shutdown first (waits ~10s) before force killing the automation Chrome.

## Development

```bash
npm run dev -- run --prompt "Hello"
```

## Testing

`npm test` runs automated extraction tests (JSON/XML/exact-string) using headless Chromium. For mock UI smoke testing, use `npm run test:mock`. For real UI validation, run against ChatGPT directly.

See `docs/TESTING.md` for selector sync and long-run validation.
