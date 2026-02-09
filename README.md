# Oracle

Give your AI agents access to ChatGPT. Oracle is a CLI tool that lets AI agents (Claude, Codex, etc.) query ChatGPT Pro via browser automation — completely hands-free, running in the background.

> **Early-stage software.** This project works and is actively used, but it automates a browser against a third-party website — things can break when ChatGPT's UI changes, and browser automation on your machine is inherently somewhat invasive. Review the code before running it, and use at your own risk.

> **macOS only** in its current version (uses AppleScript and macOS-specific Chrome management).

> **Built by AI.** The vast majority of this codebase was written by Claude and Codex (OpenAI), with human direction and review by [@seeekr](https://github.com/seeekr). Treat accordingly — it's been tested and works well, but hasn't had extensive manual code review.

## Why

AI agents sometimes need to consult other AI models. Oracle makes this possible by automating a real Chrome browser session against ChatGPT, with:

- **Zero focus steal** — Oracle Chrome runs offscreen and never interrupts your work
- **Personal Chrome isolation** — uses a dedicated browser profile at `~/.oracle/chrome`, completely separate from your personal Chrome
- **Long-running query support** — handles queries that take minutes to hours (ChatGPT Pro extended thinking)
- **Structured error handling** — all errors include codes, messages, and recovery suggestions in JSON
- **Conversation continuity** — follow-up messages to existing conversations

## Prerequisites

- **macOS** (Ventura or later)
- **Node.js** 18+
- **Google Chrome** installed
- **ChatGPT account** with a Pro subscription (extended thinking requires Pro)

## Install

```bash
git clone https://github.com/productioneer/oracle.git
cd oracle
npm install
npm run build
```

To make the `oracle` command available globally, add it to your PATH:

```bash
# Add to your shell profile (~/.zshrc, ~/.bashrc, etc.)
export PATH="/path/to/oracle/dist:$PATH"

# Or create a symlink
ln -s "$(pwd)/dist/cli.js" /usr/local/bin/oracle
```

## Quick Start

### 1. Log in to ChatGPT

On first use, open a visible browser window to log in:

```bash
oracle open
```

This opens Chrome with Oracle's dedicated profile. Log in to ChatGPT, then close the window. You only need to do this once — the session persists.

### 2. Run a query

```bash
# Start a run (returns immediately with a run_id)
echo "What is the mass of the Sun?" | oracle run --json

# Wait for completion
oracle watch <run_id>

# Get the result
oracle result <run_id>
```

### 3. Continue a conversation

```bash
echo "How does that compare to Jupiter?" | oracle run <run_id> --json
oracle watch <run_id>
oracle result <run_id>
```

## Agent Quick Start

Oracle is designed to be used by AI agents. Copy the instructions below into your agent's system prompt or memory file (for instance, Claude Code's `~/.claude/CLAUDE.md`):

<details>
<summary><strong>Click to expand agent instructions</strong></summary>

````markdown
## Oracle CLI

Query ChatGPT Pro via browser automation. Runs asynchronously — start a run, wait for completion, get the result.

### Standard Workflow (3 commands)

```bash
# 1. Start a run (returns run_id in JSON)
echo "your prompt" | oracle run --json

# 2. Wait for completion (blocks until done, prints status updates)
oracle watch <run_id>

# 3. Get the response text
oracle result <run_id>
```

### Important Notes

- **Always use `--json`** with `oracle run` to get structured output with the run_id.
- **`oracle watch` blocks** until the run completes — no need to poll manually.
- **`oracle result`** returns the response text on stdout. Use `--json` for structured metadata.
- Runs are stored under `~/.oracle/runs/<run_id>/`.

### All Commands

| Command | Purpose |
|---------|---------|
| `oracle run "<prompt>" --json` | Start new run, get run_id |
| `echo "prompt" \| oracle run --json` | Start run via stdin |
| `echo "follow-up" \| oracle run <run_id> --json` | Continue conversation |
| `oracle watch <run_id>` | Wait for completion |
| `oracle result <run_id>` | Get response text |
| `oracle result <run_id> --json` | Get response metadata (JSON) |
| `oracle status <run_id>` | Check current state |
| `oracle cancel <run_id>` | Cancel active run |
| `oracle thinking <run_id>` | Get thinking output (incremental) |
| `oracle thinking <run_id> --full` | Get full thinking output |

### Error Handling

All commands support `--json`. With `--json`, errors output structured JSON to stdout:
```json
{"error": true, "code": "ERROR_CODE", "message": "...", "suggestion": "..."}
```

Common error codes:
- `PROMPT_REQUIRED` — no prompt provided
- `RUN_NOT_FOUND` — invalid run_id or run expired (runs expire after 48h)
- `RUN_TERMINAL` — run already completed/failed/canceled
- `RESULT_NOT_AVAILABLE` — result not ready yet (use `oracle watch` first)
- `NEEDS_USER` — requires manual intervention (login, Cloudflare). Escalate to user.

### `oracle watch --json` terminal states

When `watch --json` completes, check the `state` field:
- `"state":"completed"` — success. Use `oracle result <run_id>` to get the response.
- `"state":"failed"` — browser-level failure. Report it.
- `"state":"canceled"` — the run was canceled.

**Response text may contain ChatGPT errors** — even when state is "completed", inspect the result text. If it looks like a generic error rather than a real answer, report it.

### Recovery

- If `oracle watch` reports `needs_user`, escalate to the user immediately.
- If `oracle watch --json` reports `"state":"failed"`, report the failure. Do not retry automatically.
- On persistent failures (same query fails >2 times), alert the human.

### @file References

Include file contents in prompts: `@path/to/file.ts` uploads as attachment, `@file.ts:23-90` inlines specific lines.
````

</details>

## Commands

| Command | Description |
|---------|-------------|
| `oracle run` | Start a new run or continue a conversation |
| `oracle watch` | Watch a run until completion |
| `oracle status` | Check run status |
| `oracle result` | Get the response text |
| `oracle thinking` | Get thinking/reasoning output |
| `oracle resume` | Resume a paused run |
| `oracle cancel` | Cancel an active run |
| `oracle open` | Open a visible browser for login/recovery |

All commands support `--json` for machine-readable output. Use `oracle <command> --help` for full options.

## How It Works

1. **`oracle run`** launches a detached Chrome worker process with Oracle's dedicated profile
2. The worker navigates to ChatGPT, submits your prompt, and waits for the response
3. Chrome runs offscreen (`--window-position=-32000,-32000`) with AppleScript hiding — it never steals focus
4. State is persisted to `~/.oracle/runs/<run_id>/` as JSON files
5. **`oracle watch`** polls until completion; **`oracle result`** extracts the response

Oracle uses [Playwright](https://playwright.dev/) for browser automation.

## Personal Chrome Isolation

Oracle always uses a separate Chrome profile at `~/.oracle/chrome` — your personal Chrome is never touched. When your personal Chrome is also running, Oracle takes extra care:

- Skips app-level hiding to avoid accidentally hiding your personal Chrome windows
- Oracle's Chrome window is parked offscreen instead
- Set `ORACLE_FORCE_APP_HIDE=1` to force full hiding (may affect personal Chrome windows)

## macOS Permissions

Oracle uses AppleScript to manage Chrome windows. On first run, macOS may prompt you to grant your terminal (Terminal.app, iTerm2, etc.) **Accessibility** and **Automation** permissions in **System Settings > Privacy & Security**. Allow these — without them, Oracle can't hide the Chrome window or prevent focus stealing.

## Login & Recovery

If ChatGPT requires login or hits a Cloudflare challenge, the run enters a `needs_user` state. To resolve:

```bash
# Open a visible browser to log in
oracle open

# Then resume the run
oracle resume <run_id>
```

If Chrome is stuck:

```bash
oracle resume <run_id> --allow-kill
```

## Configuration

| Environment Variable | Description |
|---------------------|-------------|
| `ORACLE_BASE_URL` | Override ChatGPT URL |
| `ORACLE_DEV` | Enable dev mode (exposes `--timeout-ms`, `--browser`, etc.) |
| `ORACLE_FORCE_APP_HIDE` | Force app-level Chrome hiding |
| `ORACLE_FORCE_KILL` | Enable SIGKILL for stuck Chrome (use with `--allow-kill`) |
| `ORACLE_CAPTURE_HTML` | Save debug HTML/PNG snapshots |

## Development

```bash
# Run from source
npm run dev -- run "Hello"

# Run tests
npm test

# Run agent evals (mock ChatGPT)
npm run eval:agents
```

See [docs/TESTING.md](docs/TESTING.md) for testing details.

## Disclaimer

Oracle automates a real Chrome browser against ChatGPT. This means it interacts with your ChatGPT account and manages Chrome processes on your machine. While it uses a dedicated Chrome profile and takes care to not interfere with your personal browser, browser automation is inherently somewhat unpredictable — ChatGPT's UI can change without notice, and things may break.

Please also ensure your usage complies with OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/).

## Acknowledgments

Inspired by [@steipete/oracle](https://github.com/steipete/oracle) by Peter Steinberger — an API-based Oracle CLI. This project takes a different approach: browser automation instead of API calls, designed specifically for agents that need ChatGPT Pro's extended thinking capabilities via the web interface.

## License

[MIT](LICENSE)
