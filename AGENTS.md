# Oracle

Browser-based tool for AI agents to query GPT via ChatGPT web interface.

## Authoritative Sources

- **DNA (requirements)**: DNA.md (internal)
- **Research (approaches)**: research notes (internal)
- **Reference implementation**: github.com/steipete/oracle (for ideas only, not template)

## Testing

Use real ChatGPT freely:
- GPT-5.2 Instant — cheap, fast, use for UI testing
- GPT-5.2 / GPT-5.2 Thinking — for longer flow tests
- GPT-5.2 Pro — only for final validation, sparingly

Don't be conservative. Test against real interface. Iterate until it works.

## Known Issues (2026-01-17)

- Firefox (Dev Edition automation) currently blocked by Cloudflare; login to chatgpt.com fails consistently. Pausing Firefox work until this clears.

## Agent SDK Auth Policy (2026-01-17)

- Agent SDK evals must NOT use API keys for auth. Strip all `*_API_KEY` env vars before invoking Codex/Claude agents.
- Agents must authenticate via their own CLI/session state only (no API key fallback).
