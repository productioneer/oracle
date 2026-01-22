# ChatGPT Browser Interaction Spec

Canonical reference for automating ChatGPT web UI. This is the up-to-date spec for browser interaction - selectors, phases, and flows. Implementation should use Playwright (see oracle-improvements.md).

> **See also**: [oracle-improvements.md](./oracle-improvements.md) for additional context: CLI design, recovery behavior, thinking output feature, and the thinking monitoring pattern for subagents.
>
> **Library details**: [playwright-notes.md](./playwright-notes.md) (recommended) or [puppeteer-notes.md](./puppeteer-notes.md) for implementation-specific patterns (file uploads, network idle, etc.).

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
- See [Appendix: Text Entry Research](#appendix-text-entry-research) for method options

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
3. **Fill**: `div.pointer-events-auto input` (single file input on page)
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

1. **Wait for**: `[data-testid='conversation-turn-{N}']` where N is the next odd number (1, 3, 5...)
2. **Verify**: The turn contains `div[data-message-author-role="user"]`
3. **Verify content**: `innerText` of the user message matches the submitted prompt

This confirms the message was actually sent, not just that the button was clicked.

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

- **Wait for**: `[data-testid='conversation-turn-{N}']`
  - N = highest even number (user turns are odd, assistant turns are even)
  - Turn 2 = first response, Turn 4 = second response, etc.

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
| File input | — | `input[type="file"]` (single on page) |
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

## Notes

- Radix IDs (`#radix-_r_77_` etc.) are auto-generated and unreliable — use aria labels or text content instead
- The thinking panel usually auto-opens, but clicking "Thought for X" is the fallback
- Response polling with stability check prevents reading incomplete responses

---

## Appendix: Text Entry Research

Research on text entry methods for ProseMirror contenteditable editors. **Not yet validated** - needs testing against the actual ChatGPT implementation.

### Method Comparison (from research)

| Method | Expected Reliability | Notes |
|--------|---------------------|-------|
| `page.keyboard.type()` with delay | Likely high | Triggers full event chain (keydown → keypress → input → keyup) |
| `pressSequentially()` | Likely high | Playwright equivalent, configurable delay |
| `page.fill()` | Uncertain | May not trigger all ProseMirror events |
| `page.evaluate()` + innerHTML | Likely low | Bypasses editor validation/state management |
| `dispatchEvent(InputEvent)` | Likely low | Rich editors often ignore synthetic events |
| `execCommand('insertText')` | Deprecated | Don't use |

### Why Keyboard Simulation May Be Best

ProseMirror and similar rich text editors:
- Validate input through their own state management (not just DOM)
- Expect specific event sequences from real keyboard input
- Often ignore or mishandle synthetic events

### Suggested Approach (untested)

```javascript
// 1. Focus the editor
await page.click('#prompt-textarea');

// 2. Type with keyboard simulation and small delay
await page.keyboard.type('Your message here', { delay: 30 });
```

The delay (30-50ms) ensures events are processed in sequence. This may be slower than direct injection but more likely to work reliably with ProseMirror's event handling.

### Open Questions

- Does `page.fill()` actually work with ChatGPT's ProseMirror?
- Is there a faster method that still triggers proper editor state updates?
- Can we inject text via ProseMirror's API directly (if exposed)?
