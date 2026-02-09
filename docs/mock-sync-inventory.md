# Mock Sync Inventory

Cross-reference of selectors across three sources: the spec (`docs/chatgpt-browser-interaction.md`), the implementation (`src/browser/`), and the mock (`scripts/mock-server.js`).

## Selector Inventory

### Core Interaction

| Element | Selector(s) | Spec | Impl | Mock | Notes |
|---|---|---|---|---|---|
| Prompt textarea | `#prompt-textarea` | ✅ | ✅ chatgpt.ts:46 | ✅ | ProseMirror contenteditable in real UI; plain textarea in mock |
| Send button | `[data-testid='send-button']`, `button[aria-label*='Send']` | ✅ | ✅ chatgpt.ts:48-49 | ✅ | Dual selector pair |
| Stop button | button containing "Stop" | ✅ | ✅ worker.ts (idle check) | ✅ | Mock has aria-label="Stop" |

### Model Selection

| Element | Selector(s) | Spec | Impl | Mock | Notes |
|---|---|---|---|---|---|
| Model display | `#page-header span` | ✅ | ✅ chatgpt.ts:215 | ❌ | Checked to skip model selection |
| Model switcher trigger | `[data-testid='model-switcher-dropdown-button']`, `button[aria-label*='Model selector']` | ✅ | ✅ chatgpt.ts:54-55 | ❌ | Pre-flight check depends on this |
| Model option (5.2 Pro) | `[data-testid='model-switcher-gpt-5-2-pro']` | ✅ | ✅ chatgpt.ts:56 | ❌ | |
| New chat button | `[data-testid='create-new-chat-button']` | ✅ | ✅ chatgpt.ts:57 | ❌ | Pre-flight check |

### File Attachments

| Element | Selector(s) | Spec | Impl | Mock | Notes |
|---|---|---|---|---|---|
| Plus button | `[data-testid='composer-plus-btn']`, `button[aria-label*='Add files']` | ✅ | ✅ attachments.ts:20-21 | ❌ | |
| File upload option | text "Add photos &" | ✅ | ✅ attachments.ts | ❌ | Menu item text match |
| File input | `input[type='file']` | ✅ | ✅ attachments.ts | ❌ | Multiple upload strategies use this |
| Remove file indicator | `button[aria-label='Remove file']` | ✅ | ✅ attachments.ts:24 | ❌ | Upload acceptance confirmation |
| Upload spinner | SVG with `<circle>` elements | ✅ | ✅ attachments.ts:304 | ❌ | |
| Upload complete | SVG with `<use href="...">` | ✅ | ✅ attachments.ts:308 | ❌ | |
| File container | `#thread-bottom-container` | ✅ | ✅ chatgpt.ts | ❌ | Filename verification scope |

### Conversation Turns

| Element | Selector(s) | Spec | Impl | Mock | Notes |
|---|---|---|---|---|---|
| Turn container | `[data-testid='conversation-turn-{N}']` | ✅ | ✅ chatgpt.ts:440+ | ✅ | Mock generates incrementing N |
| User message | `[data-message-author-role='user']` | ✅ | ✅ worker.ts:1072 | ✅ | |
| Assistant message | `[data-message-author-role='assistant']` | ✅ | ✅ chatgpt.ts:782+ | ✅ | |
| Thinking turn (intermediate) | `[data-testid='conversation-turn-{N}']` with NO `data-message-author-role` | ✅ | ✅ chatgpt.ts:980+ | ❌ | Real ChatGPT inserts these between user and assistant turns during extended thinking. Mock doesn't simulate this. |

### Completion Detection

| Element | Selector(s) | Spec | Impl | Mock | Notes |
|---|---|---|---|---|---|
| Copy button | `[data-testid='copy-turn-action-button']`, `button[aria-label='Copy']` | ✅ | ✅ chatgpt.ts:50-51 | ❌ | **Critical** — primary completion signal |
| Good/Bad response | `data-testid='good-response-turn-action-button'` etc. | ✅ | ❌ not used | ✅ | Mock has these but Oracle doesn't use them |

### Thinking Panel

| Element | Selector(s) | Spec | Impl | Mock | Notes |
|---|---|---|---|---|---|
| "Pro thinking" text | text match `Pro thinking` | ✅ | ✅ chatgpt.ts:541 | ✅ | Mock has `#pro-thinking-header` |
| Thought time indicator | text matching `/Thought for \d+/` | ✅ | ✅ chatgpt.ts:588 | ✅ | Mock has static "Thought for 12 seconds" |
| Thinking sidebar close | `[data-testid='close-button']` | ✅ | ✅ chatgpt.ts:64,575 | ❌ | |
| Sources header | `[data-testid='bar-search-sources-header']` | ✅ | ✅ chatgpt.ts:63 | ✅ | |
| Thinking mode trigger | `button[aria-label*='Extended thinking']` / `button[aria-label*='Pro']` | ✅ | ✅ chatgpt.ts:60-61 | ⚠️ | Mock has button but without aria-labels |
| Thinking menu items | `[role='menuitemradio']` | ✅ | ✅ chatgpt.ts:62 | ✅ | |
| Composer footer | `[data-testid='composer-footer-actions']` | ✅ | ✅ chatgpt.ts:59 | ✅ | |

## Gap Summary

### Mock Missing (blocking test coverage)

**P1 — Completion detection:**
- Copy button (`[data-testid='copy-turn-action-button']`) — Oracle uses this as the primary signal that response generation is complete. Without it, mock tests can't verify the completion detection flow.

**P2 — Model selection flow:**
- Page header with model display (`#page-header span`)
- Model switcher dropdown (`model-switcher-dropdown-button`)
- Model option (`model-switcher-gpt-5-2-pro`)
- New chat button (`create-new-chat-button`) — pre-flight check

**P3 — File attachment flow:**
- Plus button, file input, remove indicator, upload state SVGs
- This is a complex multi-element flow. The mock would need to simulate the full upload lifecycle.

**P4 — Thinking panel close:**
- Sidebar close button (`[data-testid='close-button']`)
- Thinking mode trigger aria-labels (mock has buttons but missing aria-label attributes)

### Mock Has But Oracle Doesn't Use
- Good/Bad response action buttons — informational, not blocking

### ProseMirror vs Textarea
The real ChatGPT uses a ProseMirror contenteditable `#prompt-textarea`. The mock uses a plain `<textarea>`. This means:
- The mock can't catch typing-related regressions (for instance, a macOS minimize/suspend bug would not reproduce against the mock)
- Paste via synthetic `ClipboardEvent` (the primary text entry method) works differently — ProseMirror has a native paste handler that processes `ClipboardEvent`, while a plain textarea would not respond the same way
- Enter key behavior differs — ProseMirror maps Enter to "submit", Shift+Enter to line break; a plain textarea creates newlines on Enter

### Turn Structure Divergence
The mock generates simple alternating user/assistant turns. Real ChatGPT (with extended thinking) inserts intermediate "thinking" turns between user and assistant. These thinking turns have `data-testid="conversation-turn-{N}"` but NO `data-message-author-role` attribute. The implementation handles this via forward scanning (chatgpt.ts:980+), but mock tests can't verify this logic.

## Mock Sync Process

### When to Update
1. After any selector change in `docs/chatgpt-browser-interaction.md`
2. After adding/modifying selectors in `src/browser/chatgpt.ts` or `src/browser/attachments.ts`
3. When a production run reveals a UI change (new selector needed, existing one broken)

### How to Update
1. Re-run this inventory (compare spec ↔ impl ↔ mock)
2. Add missing elements to mock with correct `data-testid` and `aria-label` attributes
3. Ensure mock element behavior matches real UI lifecycle (for example, copy button appearing after streaming completes)
4. Run test suite against updated mock: `node --test tests/`

### Periodic Verification
Check real ChatGPT selectors by:
1. Open ChatGPT in a regular browser
2. Use DevTools to verify `data-testid` attributes still exist on expected elements
3. Compare against `docs/chatgpt-browser-interaction.md`
4. Update spec → impl → mock in that order if changes found

### Selector Stability Tiers
- **Stable** (low change risk): `#prompt-textarea`, `data-testid` attributes (OpenAI maintains these for their own testing)
- **Medium** (occasional changes): ARIA labels, text content matches
- **Volatile** (high change risk): CSS class names, DOM structure paths
