# Oracle Improvements Spec

Findings and decisions from testing session. For Codex implementation.

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
| Action buttons | `[data-testid="good-response-turn-action-button"]`, `[data-testid="bad-response-turn-action-button"]` |
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

Default: **Extended** (use `--thinking standard` to override)

---

## Completion Detection

**Replace `stableMs` timer with deterministic check:**

```javascript
function isResponseComplete(page) {
  const actionBtn = document.querySelector(
    '[data-testid="good-response-turn-action-button"], ' +
    '[data-testid="bad-response-turn-action-button"]'
  );
  if (!actionBtn) return false;
  const style = window.getComputedStyle(actionBtn);
  return style.display !== 'none' &&
         style.visibility !== 'hidden' &&
         style.opacity !== '0';
}
```

---

## Response Extraction

**Direct selector only, no fallbacks:**

```javascript
function getLastAssistantResponse() {
  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (msgs.length === 0) return null;
  return msgs[msgs.length - 1].innerText;
}
```

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
