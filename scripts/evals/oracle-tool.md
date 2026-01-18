# Oracle CLI (agent-facing)

Mock eval only (no chatgpt.com). `ORACLE_EVAL_BASE_URL` is already set; do not override it.

Fast path:
- Start: oracle run --prompt "<text>" --json
- Wait: oracle watch <run_id>
- Result: oracle result <run_id> --json

Notes:
- Runs under ~/.oracle/runs/<run_id>
- Mock server: no login needed.
