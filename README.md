# Oracle

Browser-based tool for AI agents to query GPT via the ChatGPT web interface.

## Quick Start

```bash
npm install
npm run build

# run a prompt (background)
node dist/cli.js run "Hello"

# check status
node dist/cli.js status <run_id>

# watch until completion
node dist/cli.js watch <run_id>

# get result
node dist/cli.js result <run_id>

# continue a conversation
node dist/cli.js run <run_id> "Follow up"

# stdin prompt
echo "Hello" | node dist/cli.js run
```

## Core Commands

- `oracle run` — start a run (blocks until prompt is submitted).
- `oracle status` — read `status.json`.
- `oracle watch` — poll until completion.
- `oracle result` — print result content/metadata.
- `oracle thinking` — print thinking output (incremental by default, `--full` for complete).
- `oracle resume` — restart a run using existing state.
- `oracle cancel` — cancel a run.
- `oracle open` — open visible browser window for login/recovery.

## Mock ChatGPT Interface (Evaluation)

Start the mock server:

```bash
node scripts/mock-server.js --port 7777
```

Use it as the base URL (requires `ORACLE_DEV=1` for localhost URLs):

```bash
ORACLE_DEV=1 node dist/cli.js run "Hello" --base-url http://127.0.0.1:7777/
```

Simulate long wait / stuck streaming:

```
http://127.0.0.1:7777/?stall=1
```

You can set `ORACLE_DEV=1` to expose `--timeout-ms` for long-run testing.

## Notes

- Chrome focus-safe launch uses `open -n -g` with offscreen window positioning (`--window-position=-32000,-32000`) plus AppleScript hiding.
- Default effort is Extended; use `--effort standard` to override.
- Firefox support uses Playwright (headful, WebDriver BiDi protocol). Focus prevention is best-effort.
- On macOS, Firefox automation requires Firefox Developer Edition or Nightly (distinct bundle ID) to avoid controlling your personal Firefox. Install one or pass `--firefox-app /Applications/Firefox\ Developer\ Edition.app` (or set `ORACLE_FIREFOX_APP`). Keep that app reserved for Oracle; if its window title doesn't match the Oracle automation homepage, focus suppression is skipped to avoid touching personal windows.
- Firefox focus on macOS uses an AppleScript ladder (background launch → hide → minimize). If permissions are blocked, the window may stay visible and `status.json` will include a `focus` section with `state` and `needsUser` details.
- Firefox on macOS runs a setup-first phase before any tab work: profile window size is pre-set to a tiny setup size, then the window is hidden/minimized, waits briefly, and only then resizes to a normal working size before navigation.
- Firefox automation runs reuse a long-lived instance (hidden) to avoid repeated window flash. Quit Firefox to reset, or remove `~/.oracle/firefox/oracle-connection.json` if reuse gets stuck.
- macOS permissions: granting Automation (controlling Firefox) and Accessibility (System Events) to the terminal/osascript process may be required for focus suppression.
- Runs persist state under `~/.oracle/runs/<run_id>` by default.
- Chrome always uses the dedicated Oracle profile at `~/.oracle/chrome` (isolated from your main Chrome).
- Firefox uses a dedicated Oracle profile at `~/.oracle/firefox` by default (override with `--firefox-profile`).
- If login/Cloudflare is detected, `status.json` will be set to `needs_user`. All commands wait up to 30s for it to clear, then error with “please escalate to your user.” Use `oracle open` (no run id) to login, then `oracle resume <run_id>`.
- If `needs_user: kill_chrome` is set, resume with `oracle resume <run_id> --allow-kill` after reviewing the prompt.
- Use `--focus-only` to test Firefox focus suppression without navigating to ChatGPT. Focus-only runs do not pool Firefox; the automation instance is closed after each run.
- Debug artifacts (HTML/PNG) are written to `~/.oracle/runs/<run_id>/debug` when prompt input fails or when running against localhost.
- If Chrome is stuck and you pass `--allow-kill`, Oracle requests graceful shutdown first (SIGTERM, waits ~10s). If Chrome doesn't exit, set `ORACLE_FORCE_KILL=1` to enable SIGKILL.

## Development

```bash
npm run dev -- run --prompt "Hello"
```

## Testing

`npm test` runs automated extraction tests (JSON/XML/exact-string) using headless Chromium. For mock UI smoke testing, use `npm run test:mock`. For real UI validation, run against ChatGPT directly.

Agent SDK evals (Codex + Claude; mock ChatGPT): `npm run eval:agents`.

See `docs/TESTING.md` for selector sync and long-run validation.
