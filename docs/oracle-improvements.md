# Oracle Improvements Spec

Findings and decisions from testing session. For Codex implementation.

> **Browser automation**: See [chatgpt-browser-interaction.md](./chatgpt-browser-interaction.md) for the canonical, up-to-date spec on ChatGPT browser interaction (selectors, phases, flows). That document supersedes the selector/navigation sections below for implementation purposes.
>
> **This document** contains additional context not in the browser spec: CLI design, recovery behavior, thinking output feature, conversation continuation, and the thinking monitoring pattern for subagents. All content remains valid.
>
> **Library-specific details**: See [playwright-notes.md](./playwright-notes.md) for library-specific implementation details (file uploads, network idle detection, etc.).

---

## Hard Constraints

### Domain Restriction

**Only use `https://chatgpt.com/`**. No alternative domains, no fallbacks.

- Do NOT use `chat.openai.com` (it just redirects anyway)
- Do NOT add fallback URLs
- If chatgpt.com doesn't work (Cloudflare, login required), fail with a clear error

### Automation Library

**Use Playwright.** Features:
- Built-in auto-waiting on all actions
- Better file upload API (`setInputFiles`)
- Native network idle detection (`waitForLoadState('networkidle')`)
- Cross-browser support if ever needed

### Chrome Window Invariants (macOS)

Required for correctness and zero-focus-steal behavior.

**Invariants:**
- Exactly **one** Chrome process for the oracle user-data-dir.
- Exactly **one** Chrome **window** exists after first launch; it must **never be windowless**.
- The window is **offscreen + minimized** by default, and **never steals focus** unless explicitly revealed for login.
- The window/viewport width is **>= 1024px** (prefer 1280+) so the thinking sidebar renders as a sidebar, not a modal.
- Use **CDP window bounds** to enforce hidden state; no UI-scripting or “restore focus” hacks.

**Launch requirements:**
- Do **not** use `--no-startup-window` (creates a first-window race and flicker).
- Do **not** rely on `--start-minimized` (not reliable).
- Include `--disable-session-crashed-bubble` to suppress "restore pages" prompts after unclean exits.
- Create the startup window offscreen via `--window-position=-32000,-32000` with width >= 1024px.

**Lifecycle requirements:**
- Keep a **persistent tab** (sentinel or ChatGPT tab) to keep the window alive.
- For Chrome CDP connections: **disconnect only**; do not `browser.close()` or `page.close()` if it would remove the last tab/window.

**Instrumentation:**
- Log window bounds and windowId at key phases (launch, attach, pre/post submit) to catch regressions.

---

## Run Retention

- CLI prunes run directories older than **48h**.
- Skip active runs (`starting`, `running`, `needs_user`).

---

## ChatGPT UI Navigation

### State Detection (No Timers)

| State | Observable Signals |
|-------|-------------------|
| **Generating** | Timer counting up (top right), Stop/Update buttons visible |
| **Complete** | Action buttons visible (thumbs up/down, copy, share) on last message |
| **Failed/Cancelled** | No timer, no stop button, no action buttons |

### Key Selectors

| Element | Selector |
|---------|----------|
| Send button | `button[data-testid="send-button"]` |
| Stop button | Button with text "Stop" or `aria-label*="Stop"` |
| Action buttons (completion) | `[data-testid="copy-turn-action-button"]` |
| Assistant message | `[data-message-author-role="assistant"]` (use last one) |
| Thinking effort dropdown | Button near textarea (contenteditable, #prompt-textarea) containing "Pro" or "Extended thinking", inside data-testid="composer-footer-actions" |
| Thinking options | `[role="menuitemradio"]` with text "Standard" or "Extended" |

### Thinking Effort Toggle

Button text indicates current state:
- "Pro" → Standard thinking
- "Extended thinking" → Extended thinking

To set Extended:
1. Check if button text already contains "Extended" → done
2. Otherwise: click button → click `[role="menuitemradio"]` containing "Extended"

Default: **Extended** (use `--effort standard` to override)

---

## Completion Detection

**Use copy button + stability check:**

```javascript
function isResponseComplete(page) {
  // Primary indicator: copy button visible
  const copyBtn = document.querySelector('[data-testid="copy-turn-action-button"]');
  if (!copyBtn) return false;
  const style = window.getComputedStyle(copyBtn);
  return style.display !== 'none' &&
         style.visibility !== 'hidden' &&
         style.opacity !== '0';
}
```

Additionally, poll every 500ms-1s and wait until response `innerText` is unchanged for 2 seconds.

---

## Response Extraction

**Direct selector only, no fallbacks:**

```javascript
function getLastAssistantResponse() {
  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (msgs.length === 0) return null;
  return msgs[msgs.length - 1].innerText; // innerText respects CSS visibility
}
```

- Use `innerText` (not `textContent`) to get only visible text
- Remove `stripUiLabels` function
- Remove fallback to body text parsing
- If element not found, return null/fail clearly

---

## Recovery Behavior

| Situation | Action |
|-----------|--------|
| Stop button visible but stuck | Refresh page only, do NOT resubmit |
| Clearly failed/cancelled | Can resubmit once |
| Max retries | 1 (not 3) |

Additional recovery constraints:
- If restarting Chrome, attempt CDP `Browser.close` and wait for clean exit before any SIGTERM/SIGKILL; avoid "restore pages" prompts.

---

## Follow-Up Message Handling

When attempting to send a follow-up message to an existing conversation:

1. **Check generation state first**: If model is still generating (Stop/Update visible), reject the request
2. **Error message**: "Previous response still generating. Wait for completion or cancel before sending follow-up."
3. **No implicit waiting**: The API should NOT silently wait for completion — caller must explicitly wait or cancel

This prevents:
- Accidentally interrupting an ongoing generation
- Race conditions with concurrent requests
- Ambiguous state where it's unclear if the previous message completed

The caller (agent) is responsible for:
- Using `oracle status` to check if previous run is complete
- Using `oracle cancel` if they want to abort and send new message
- Waiting appropriately before sending follow-ups

---

## CLI Design

### Public Interface

```bash
# Basic usage
oracle run "prompt"                    # new query
oracle run <run_id> "prompt"           # continue conversation
echo "prompt" | oracle run             # stdin support
echo "prompt" | oracle run <run_id>    # stdin + continue

# Status & results
oracle status <run_id>
oracle result <run_id>
oracle thinking <run_id>               # incremental (default)
oracle thinking <run_id> --full        # complete thinking

# Control
oracle cancel <run_id>
```

### Run Command Behavior

- `oracle run` blocks until the prompt is actually submitted (the run reaches waiting and the conversation URL is available), so `oracle open <run_id>` works immediately.
- If a run enters `needs_user`, the command waits up to 30 seconds for it to clear, then errors with a message instructing escalation to the user.

### Smart Positional Arg Detection

First positional arg to `oracle run` needs disambiguation:

```
oracle run <arg1> [arg2]
```

Detection logic:
1. If `arg1` matches run_id pattern (e.g., `/^[a-z0-9]+-[a-z0-9]+$/`) → treat as run_id, `arg2` is prompt
   - If run doesn't exist → fail with clear error "run not found"
2. Otherwise → `arg1` is the prompt (new conversation)

This allows natural usage:
- `oracle run "What is 2+2?"` → new query
- `oracle run mkk7jmdg-9f118ed3 "Follow up"` → continue conversation
- `oracle run nonexistent-runid "test"` → error: "run not found" (not treated as prompt)

### Hidden Dev Flags

Only show with `ORACLE_DEV=1` or `--help-dev`:
- `--poll-ms` (default: 15000, was 1500)
- `--stable-ms` (remove entirely, use action buttons)
- `--stall-ms` (remove entirely, use UI state)
- `--timeout-ms` (remove or set very high, no practical timeout)
- `--browser firefox` (not production ready)
- `--firefox-profile`, `--firefox-app`

### Defaults

| Setting | Value |
|---------|-------|
| Poll interval | 15 seconds |
| Thinking effort | Extended |
| Browser | Chrome only (Firefox hidden) |

---

## Thinking Output Feature

### Command

```bash
oracle thinking <run_id>          # incremental (default)
oracle thinking <run_id> --full   # complete output
```

### Incremental Mode

- Oracle tracks read position internally per run
- Each call returns only new content since last read
- State stored in run directory

### Selectors for Thinking Content

| Element | How to Find |
|---------|-------------|
| "Thought for X" header | `div` containing regex `/thought for \d+/i` |
| Pro thinking section | `div` starting with "Pro thinking" |
| Sources section | `[data-testid="bar-search-sources-header"]` |

Click "Thought for X" element to expand thinking sidebar if collapsed.

---

## Conversation Continuation

- Store `conversationUrl` in run directory (already done)
- Accept `run_id` as first positional arg to `oracle run`
- Navigate to existing conversation URL before submitting new prompt
- All messages stored in same run folder

---

## Thinking Monitoring Pattern with Subagents (for Claude agent using oracle)

Sub-agent can monitor thinking progress in order to determine if research is going off in the wrong direction, and give signal to early abort research and retry with new prompt or amend with additional user message containing any missing or corrected info.

```
Main Agent                          Sub-Agent (Sonnet)
    |                                     |
    |-- oracle run "query" (background)   |
    |-- launch monitor sub-agent -------->|
    |                                     |
    | [goes silent]                       |-- sleep 60s
    |                                     |-- oracle thinking <run_id>
    |                                     |-- analyze: on track?
    |                                     |-- if YES: loop silently
    |                                     |-- if NO: return alert
    |                                     |
    |<-- [woken up only if problem] ------|
```

- Sub-agent reads incremental thinking (few tokens)
- Only reports to main agent if intervention needed
- Main agent context stays clean
