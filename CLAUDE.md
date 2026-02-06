# CLAUDE.md — Oracle

## Auth

Never use API keys for main agents (Claude, Codex). Always use built-in, pre-configured subscription auth.

## Browser Scope

Firefox is excluded from scope for now — not worth pursuing given Cloudflare blocks it on login.

## Oracle Chrome Profile

Do NOT modify the Oracle Chrome profile (`~/.oracle/chrome`) — no deleting lock files, no removing caches, no "cleaning up" anything. Hands off.

## Production Testing

When doing production verification against real ChatGPT:
- Use `--allow-visible` so the human can observe browser behavior and give fast feedback
- Do NOT spam the ChatGPT website — minimize queries to avoid trouble with OpenAI/Cloudflare
