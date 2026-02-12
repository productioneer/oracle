# Oracle CLI

Query ChatGPT Pro via browser automation. Runs asynchronously — start a run, wait for completion, get the result.

**Oracle runs remotely.** It has ONLY the information in your prompt and attached files — no access to your local filesystem, environment, or context. Include all necessary context in the prompt, and use `@file` references to attach relevant files.

`ORACLE_EVAL_BASE_URL` is already set; do not override it. Mock server: no login needed.

## Standard Workflow (3 commands)

```bash
# 1. Start a run (returns run_id in JSON)
echo "your prompt" | oracle run --json

# 2. Wait for completion (blocks until done, prints status updates)
oracle watch <run_id>

# 3. Get the response text
oracle result <run_id>
```

## Important Notes

- **Always use `--json`** with `oracle run` to get structured output with the run_id.
- **`oracle watch` blocks** until the run completes — no need to poll manually.
- **`oracle result`** returns the response text on stdout. Use `--json` for structured metadata.
- Runs are stored under `~/.oracle/runs/<run_id>/`.

## All Commands

| Command | Purpose |
|---------|---------|
| `oracle run "<prompt>" --json` | Start new run, get run_id |
| `echo "prompt" \| oracle run --json` | Start run via stdin |
| `echo "follow-up" \| oracle run <run_id> --json` | Continue conversation |
| `oracle watch <run_id>` | Wait for completion |
| `oracle result <run_id>` | Get response text |
| `oracle result <run_id> --json` | Get response metadata (JSON) |
| `oracle status <run_id>` | Check current state |
| `oracle status <run_id> --json` | Check state (JSON output) |
| `oracle cancel <run_id>` | Cancel active run |
| `oracle cancel <run_id> --json` | Cancel (JSON output) |
| `oracle thinking <run_id>` | Get thinking output (incremental) |
| `oracle thinking <run_id> --full` | Get full thinking output |

## Error Handling

All commands support `--json`. With `--json`, errors output structured JSON to stdout:
```json
{"error": true, "code": "ERROR_CODE", "message": "...", "suggestion": "..."}
```

Common error codes:
- `PROMPT_REQUIRED` — no prompt provided (pass as arg, stdin, or --prompt-file)
- `RUN_NOT_FOUND` — invalid run_id or run expired (runs expire after 48h)
- `RUN_TERMINAL` — run already completed/failed/canceled (cannot resume/cancel)
- `RESULT_NOT_AVAILABLE` — result not ready yet (use `oracle watch` first)
- `STATUS_NOT_AVAILABLE` — status file not yet written (run may still be starting)
- `NEEDS_USER` — requires manual intervention (login, Cloudflare). Escalate to user.

**`oracle watch --json` terminal states:**
When `watch --json` completes, it outputs the final status. Check the `state` field:
- `"state":"completed"` — success. Use `oracle result <run_id>` to get the response.
- `"state":"failed"` — the response failed at the browser level (e.g., ChatGPT error). Report the failure. The `message` field explains what happened.
- `"state":"canceled"` — the run was canceled.

A non-completed state sets exit code 1.

**Response text may contain ChatGPT errors:**
Even when state is "completed", the response text from `oracle result` may be a ChatGPT error message (e.g., "An error occurred while generating a response"). Inspect the result text — if it looks like a generic error rather than a real answer, report it as a ChatGPT error.

**Recovery rules:**
- If `oracle run` fails, the error message explains what happened and what to do.
- If `oracle watch` reports `needs_user`, escalate to the user immediately.
- If `oracle watch --json` reports `"state":"failed"`, report the failure to the user. Do not retry automatically.
- If `oracle result` says result not available, use `oracle watch <run_id>` to wait for completion.
- On persistent failures (same query fails >2 times), alert the human — do not keep retrying.

## @file References

Include file contents in prompts: `@path/to/file.ts` uploads as attachment, `@file.ts:23-90` inlines specific lines.
