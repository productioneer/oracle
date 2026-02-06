# ChatGPT Browser Interaction Spec

Canonical reference for automating ChatGPT web UI. This is the up-to-date spec for browser interaction - selectors, phases, and flows. Implementation should use Playwright (see oracle-improvements.md).

> **See also**: [oracle-improvements.md](./oracle-improvements.md) for additional context: CLI design, recovery behavior, thinking output feature, and the thinking monitoring pattern for subagents.
>
> **Library details**: [playwright-notes.md](./playwright-notes.md) for implementation-specific patterns (file uploads, network idle, etc.).

**General rule**: Always wait for an element to exist before interacting with it.

**Viewport requirement**: Ensure `window.innerWidth >= 1024` before waiting for the thinking sidebar. If smaller, resize viewport/window to at least 1280×800 and log the adjustment. This keeps the thinking sidebar as a sidebar (not a modal).

**Selector philosophy**: Use both `data-testid` attributes AND ARIA labels/text where available. If both methods find elements but they disagree (different elements), log an error prompting the user to report this to the developer — it likely indicates a UI change that needs investigation.

**Selector change policy**: The selectors in this document are authoritative. Any changes, additions, or alternatives MUST be approved by the project owner before implementation. Do not add fallback selectors or alternative approaches without explicit approval. This policy exists because ad-hoc selector additions have historically caused unreliable, hard-to-debug code.

**Logging requirement**: Implement **extensive debug logging** around all selectors and UI expectations. Every selector wait/resolve should log the primary/secondary selectors, resolved selector, counts, and mismatch status. Every expectation about UI state (preflight checks, model selection, prompt entry verification, send action, thinking panel open/close, completion state) must log success/failure and key state transitions. The goal is fast root-cause isolation when the UI changes.

---

## Phase 0: Pre-Flight Checks

### 0.1 Verify Session State

Before any interaction, verify we have a valid logged-in session:

1. **Check for model selector**: Look for `[data-testid='model-switcher-dropdown-button']`
2. **Check for new chat button**: `[data-testid='create-new-chat-button']` should exist
3. **Check for 5.2 Pro availability**: Confirm in **Phase 1.2** when opening the model dropdown

**If any check fails**: Likely Cloudflare challenge or login required. Abort with clear error message prompting user to check their browser session. Do NOT attempt fallbacks or retries.

### 0.2 Wait for Idle (before any prompt submission)

Before submitting a prompt (especially follow-ups), ensure no generation is in progress:

```
Poll until NOT generating:
  - Stop button NOT visible
  - Update button NOT visible
  - No active streaming indicators
```

**If attempting to submit while generating**: Reject the request with error: "Previous response still generating. Wait for completion or cancel before sending follow-up."

---

## Phase 1: Initialize Chat

### 1.1 Navigate

- **New conversation**: Navigate to `https://chatgpt.com/` — this gives a fresh chat UI
- **Continue existing**: Navigate to `conversationUrl` (e.g., `https://chatgpt.com/c/abc123...`)

Note: Explicitly clicking the "New chat" button is unnecessary — navigating to the root URL achieves the same result.

### 1.2 Select Model (if needed)

- **Check first**: If `#page-header span` already contains "5.2 Pro", skip this step
- **Otherwise**:
  - **Click**: `[data-testid='model-switcher-dropdown-button']` (in `#page-header`)
  - **Wait for**: Dropdown to open
  - **Click**: `[data-testid='model-switcher-gpt-5-2-pro']`
  - **Verify**: `#page-header span` contains text "5.2 Pro"

---

## Phase 2: Compose Message

### 2.1 Focus Input

- **Wait for**: `#prompt-textarea` (contenteditable, uses ProseMirror)
- **Click**: The contenteditable element itself

### 2.2 Type Message

- **Type into**: `#prompt-textarea`
- **Primary method**: Synthetic `ClipboardEvent` paste (instant, works with ProseMirror)
- **Fallback**: Character-by-character `keyboard.type()` with Shift+Enter for newlines
- **Important**: ProseMirror maps Enter to "submit message". Newlines must use Shift+Enter.
- See [Appendix: Text Entry Research](#appendix-text-entry-research) for details

### 2.3 Verify Prompt Entry

After typing, verify the prompt was entered correctly:

1. **Read back**: Get `innerText` from `#prompt-textarea`
2. **Compare**: Should match the intended prompt (trimmed, whitespace normalized)
3. **If mismatch**: Clear and retry, or abort with error

### 2.4 Select Thinking Mode (if needed)

- **Find trigger**: Inside `[data-testid='composer-footer-actions']`, look for either:
  - `button[aria-label*="Extended thinking"]` (Extended mode currently selected)
  - `button[aria-label*="Pro"]` (Standard mode currently selected)
- **Check first**: If desired mode already selected (button label matches), skip
- **Otherwise**:
  - **Click**: Trigger to open dropdown
  - **Wait for**: Dropdown with options
  - **Click**: `[role="menuitemradio"]` containing text "Standard" or "Extended"
  - **Verify**: Button label changed to expected value
    - Selecting "Standard" → button label becomes "Pro"
    - Selecting "Extended" → button label becomes "Extended thinking"

### 2.5 Add Attachments (optional)

1. **Click**: `[data-testid='composer-plus-btn']`
2. **Wait for & Click**: File upload option (`::-p-text(Add photos &)` in the menu)
3. **Fill**: `div.pointer-events-auto input[type="file"]` (single file input on page)
4. **Wait for file accepted**: `aria/Remove file` button appears
5. **Wait for upload complete**:
   - **Uploading**: SVG contains `<circle>` elements (animated spinner)
   - **Done**: SVG contains `<use>` element with `href` to CDN sprite (file icon)
6. **Verify filename**: Exact filename string (trimmed) appears as `innerText` of some element within `#thread-bottom-container`

For multiple files, repeat steps 1-6.

**Native file chooser requirement:** The OS file chooser dialog must **not** remain open after file selection. If it does, treat as a failure and retry using a different upload strategy (e.g., `page.waitForEvent('filechooser')` + `fileChooser.setFiles(...)`, or direct `input.setInputFiles(...)` without opening the native dialog). Log which strategy was used and confirm the prompt input can receive keystrokes after upload.

---

## Phase 3: Send & Wait for Response

### 3.1 Send Message

- **Click**: `[data-testid='send-button']`

### 3.2 Verify User Turn

After sending, verify the prompt appears in the conversation:

1. **Wait for**: `[data-testid='conversation-turn-{N}']` where N is `max(existing turn numbers) + 1`
2. **Verify**: The turn contains `div[data-message-author-role="user"]`
3. **Verify content**: `innerText` of the user message matches the submitted prompt

This confirms the message was actually sent, not just that the button was clicked.

> **Note on turn numbering**: Turn numbers are NOT guaranteed to alternate odd/even. ChatGPT may insert intermediate turns (for instance, a "thinking" turn) that have a `conversation-turn-{N}` wrapper but NO `data-message-author-role` attribute. The next user turn is always `max + 1`, regardless of parity. See [Turn Structure with Thinking](#turn-structure-with-thinking) below.

### 3.4 Wait for Thinking Panel

This step ensures we can monitor/extract thinking content.

1. **Wait ~15-20 seconds** for "Pro thinking" text to appear
2. **If it appears**: also verify the sidebar close button (`[data-testid='close-button']`) is visible, then proceed
3. **If it doesn't appear**:
   - Look for element matching `/Thought for \d+/` (e.g., "Thought for 1m 20s")
   - **Click** it to open the thinking sidebar
   - **Wait ~10 seconds** for "Pro thinking" to appear
   - **Retry up to 2 times** if needed
4. **Verify**: `[data-testid='close-button']` appears (sidebar close button)
5. **Optional additional verification**: Sources button appears (`button` containing "Sources")

### 3.5 Wait for Response Turn

- **Scan forward** from the expected assistant turn number, checking `conversation-turn-{N}` through `conversation-turn-{N+3}` for one that contains `[data-message-author-role="assistant"]`
- The assistant turn is NOT always `expectedTurn` exactly — ChatGPT may insert one or more intermediate "thinking" turns before the actual assistant response turn
- See [Turn Structure with Thinking](#turn-structure-with-thinking) for details

### 3.6 Wait for Response Complete

1. **Wait for**: `[data-testid='copy-turn-action-button']` inside the conversation turn
2. **Poll every 500ms-1s**: Check if response text has stabilized
3. **Response complete when**:
   - Copy button is present
   - Response content exists
   - Content unchanged for 2 seconds

### 3.7 Extract Response

- **Location**: `[data-message-author-role="assistant"]` (use last one if multiple)
- **Method**: Get `innerText` of the element (visible text only, respects CSS)
- The actual text content is within a child element of this subtree

---

## Key Selectors

Elements have primary and secondary selectors for robustness. Use both; error if they disagree.

| Element | Primary (data-testid) | Secondary (ARIA/text) |
|---------|----------------------|----------------------|
| Model dropdown trigger | `[data-testid='model-switcher-dropdown-button']` | `button[aria-label*="Model selector"]` |
| Model option (5.2 Pro) | `[data-testid='model-switcher-gpt-5-2-pro']` | — |
| Prompt textarea | `#prompt-textarea` | `.ProseMirror`, `[contenteditable="true"]` |
| Thinking mode trigger | (in `[data-testid='composer-footer-actions']`) | `button[aria-label*="Extended thinking"]` or `button[aria-label*="Pro"]` |
| Thinking dropdown options | `[role="menuitemradio"]` | containing text "Standard" or "Extended" |
| Attachments button | `[data-testid='composer-plus-btn']` | `button[aria-label*="Add files"]` |
| File upload option | — | text "Add photos &" in menu |
| File input | `div.pointer-events-auto input[type="file"]` | `input[type="file"]` (single on page) |
| File accepted indicator | — | `button[aria-label="Remove file"]` |
| Send button | `[data-testid='send-button']` | `button[aria-label*="Send"]` |
| Conversation turn | `[data-testid='conversation-turn-{N}']` | — |
| Copy button (completion) | `[data-testid='copy-turn-action-button']` | `button[aria-label="Copy"]` |
| Response content | `[data-message-author-role="assistant"]` | `article` containing element with text "ChatGPT said" |
| Thinking indicator | — | element matching `/Thought for \d+/` |
| Sources button | — | `button` containing text "Sources" |
| Sidebar toggle (open) | — | `button[aria-label="Open sidebar"]` |
| Sidebar toggle (close) | — | `button[aria-label="Close sidebar"]` |
| Thinking sidebar close | `[data-testid='close-button']` | — |
| File container | `#thread-bottom-container` | — |
| User message | `[data-message-author-role="user"]` | — |
| Stop button (generating) | — | button containing text "Stop" |
| Update button (generating) | — | button containing text "Update" |

### Reference Selectors (not currently used)

| Element | Selector |
|---------|----------|
| New chat button | `[data-testid='create-new-chat-button']` or `a[href="/"]` containing "New chat" |
| Chat history list | `nav[aria-label="Chat history"]` |
| Individual past chats | `a[href^="/c/"]` |

---

## State Detection

### Generation State

| State | Observable Signals |
|-------|-------------------|
| **Generating** | Stop button visible, Update button visible, streaming indicators active |
| **Complete** | Copy button visible, Good/Bad response buttons visible, no Stop/Update |
| **Failed/Cancelled** | No Stop button, no Copy button, error message may appear |

### File Upload State

```
Accepted:    "Remove file" button (aria/Remove file) exists
Uploading:   SVG contains <circle> elements
Complete:    SVG contains <use href="...cdn-sprite...">
```

---

## Turn Structure with Thinking

When ChatGPT uses extended thinking (Pro mode), the DOM turn structure is NOT a simple alternation of user and assistant turns. ChatGPT inserts intermediate "thinking" turns that break the odd/even assumption.

### Example DOM Structure (with thinking)

```
conversation-turn-1  →  data-message-author-role="user"      (user message)
conversation-turn-2  →  NO data-message-author-role           (thinking turn — "Pro thinking")
conversation-turn-3  →  data-message-author-role="assistant"  (assistant response)
```

### Key observations

1. **Thinking turns have no `data-message-author-role`**: They contain the thinking panel UI but lack the role attribute that user and assistant turns have.
2. **Turn numbering is sequential but not role-alternating**: `max + 1` is always the next turn number, regardless of whether the last turn was user, thinking, or assistant.
3. **The assistant response may be 1-3 turns after the expected position**: After sending a user message, the assistant response might be at `expectedTurn`, `expectedTurn + 1`, `expectedTurn + 2`, or `expectedTurn + 3` depending on how many intermediate turns ChatGPT inserts.
4. **Forward scanning is required**: When looking for the assistant response, scan forward from the expected position and check each turn for `[data-message-author-role="assistant"]`.

### Impact on automation

- `getNextUserTurnNumber()`: Use `max(existing turn numbers) + 1`, not odd/even logic
- `getCompletionSnapshot()`: Scan forward up to 3 turns to find the assistant response
- Turn verification: Check for `data-message-author-role` to identify turn type, not turn number parity

## Notes

- Radix IDs (`#radix-_r_77_` etc.) are auto-generated and unreliable — use aria labels or text content instead
- The thinking panel usually auto-opens, but clicking "Thought for X" is the fallback
- Response polling with stability check prevents reading incomplete responses

---

## Appendix: Text Entry Methods (Validated)

Validated results from testing against ChatGPT's ProseMirror contenteditable editor (February 2026).

### Method Comparison

| Method | Reliability | Speed | Notes |
|--------|-------------|-------|-------|
| Synthetic `ClipboardEvent` paste | **High** ✅ | **Instant** | Primary method. ProseMirror handles paste natively. |
| `page.keyboard.type()` + Shift+Enter | **High** ✅ | Slow (30ms/char) | Reliable fallback. Must use Shift+Enter for newlines. |
| `page.fill()` | **Does not work** ❌ | — | ProseMirror ignores Playwright's `fill()` — no state update. |
| `page.evaluate()` + innerHTML | **Does not work** ❌ | — | Bypasses ProseMirror state; editor doesn't recognize content. |
| `dispatchEvent(InputEvent)` | **Does not work** ❌ | — | ProseMirror ignores synthetic input events. |
| `execCommand('insertText')` | Deprecated | — | Don't use. |

### Primary Method: Synthetic Paste

ProseMirror's paste handler works with synthetic `ClipboardEvent` objects. This is instant regardless of text length — critical for large prompts (for instance, when file content is inlined due to the 10-file attachment limit).

```javascript
await page.evaluate((content) => {
  const el = document.activeElement;
  if (!el) return;
  const dt = new DataTransfer();
  dt.setData("text/plain", content);
  const event = new ClipboardEvent("paste", {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(event);
}, text);
```

**Note**: ProseMirror calls `preventDefault()` on paste events, so `dispatchEvent()` returns `false`. This is normal — the paste IS processed. Do not use the return value as a success indicator. Instead, readback `innerText` from the editor to verify.

### Fallback Method: Keyboard Typing

Character-by-character keyboard typing with Shift+Enter for newlines. Slower but more reliable if paste ever breaks.

```javascript
await page.locator('#prompt-textarea').click();
const lines = text.split("\n");
for (let i = 0; i < lines.length; i++) {
  if (lines[i]) await page.keyboard.type(lines[i], { delay: 30 });
  if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
}
```

**Critical**: ProseMirror maps Enter to "submit message" (sends the prompt). Newlines MUST use Shift+Enter, which ProseMirror maps to a line break within the message.

### Retry Strategy

1. **Attempt 1**: Paste via synthetic `ClipboardEvent`
2. **Readback check**: Compare `innerText` of `#prompt-textarea` against expected prompt
3. **Attempt 2 (if mismatch)**: Clear input, fall back to keyboard typing with Shift+Enter
4. **Final check**: Readback again; abort if still mismatched
