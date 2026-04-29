---
name: debug
description: Debug NanoClaw agent and channel issues. Use when things aren't working — agent fails, authentication problems, sandbox issues, message routing not working. Covers logs, environment variables, sandbox, and common issues.
---

# NanoClaw Debugging

This guide covers debugging NanoClaw, which runs the coding agent in-process on the host via `@mariozechner/pi-coding-agent`. Bash commands are sandboxed at the OS level using `sandbox-exec` (macOS) or `bubblewrap` (Linux) — there is no container.

## Architecture Overview

```
Host process (Node.js)
─────────────────────────────────────────────────────────────
src/index.ts                    src/agent/
    │                                │
    │ message loop                   │ pi-coding-agent SessionPool
    │ channel registry               │ in-process per-group sessions
    │                                │
    ├── groups/{folder}/             # per-group cwd + CLAUDE.md
    ├── store/messages.db            # SQLite: groups, sessions, tasks
    └── logs/nanoclaw.log            # main app logs

Bash commands → sandbox-exec (macOS) / bwrap (Linux)
```

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Channels, routing, agent invocations |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Setup logs** | `logs/setup.log` | Output from `setup/` steps |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
#   <key>LOG_LEVEL</key>
#   <string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
#   Environment=LOG_LEVEL=debug
```

## Common Issues

### 1. Agent fails to start / "Invalid API key"

```
Invalid API key · Please run /login
```

**Fix:** Ensure `.env` has either an OAuth token or an API key:
```bash
cat .env  # Should show one of:
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  (subscription)
# ANTHROPIC_API_KEY=sk-ant-api03-...        (pay-per-use)
```

`.env` is loaded by Node's `--env-file-if-exists` flag in `npm start` / `npm run dev`, and forwarded into the in-process agent.

### 2. Sandbox failures

If bash commands fail with sandbox errors, verify the sandbox runtime is available:

- **macOS:** `which sandbox-exec` (ships with macOS).
- **Linux:** `which bwrap` — install with `sudo apt-get install bubblewrap` (or distro equivalent) if missing.

Inspect the sandbox config used at startup — see `src/agent/sandbox-config.ts`. Project-level overrides can be placed under `config/`.

### 3. Session resumption issues

Sessions are managed by `SessionPool` (`src/agent/session-pool.ts`) keyed per-group, with idle TTL eviction. If a group keeps spawning new sessions:

- Check `logs/nanoclaw.log` for session creation entries.
- Inspect `store/messages.db`:
  ```bash
  sqlite3 store/messages.db "SELECT * FROM sessions LIMIT 10;"
  ```
- To clear sessions for a group:
  ```bash
  sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = '{groupFolder}'"
  ```

### 4. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check `logs/nanoclaw.log` for MCP initialization errors. MCP servers are configured in `src/agent/`. Any binaries the server needs must be on the host PATH.

### 5. Channel not connecting

Channels self-register at startup (see `src/channels/registry.ts`). They auto-enable when their credentials are present in `.env`. After any `.env` change, restart the service.

- WhatsApp: check `store/auth/creds.json` exists.
- Token-based channels: check token values in `.env` and re-run the relevant `/add-*` skill if needed.

## Rebuilding After Changes

```bash
# Rebuild app
npm run build

# Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
systemctl --user restart nanoclaw                   # Linux
```

## Quick Diagnostic Script

```bash
echo "=== Checking NanoClaw Setup ==="

echo -e "\n1. Authentication configured?"
[ -f .env ] && (grep -q "CLAUDE_CODE_OAUTH_TOKEN=sk-" .env || grep -q "ANTHROPIC_API_KEY=sk-" .env) && echo "OK" || echo "MISSING - add CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to .env"

echo -e "\n2. Sandbox runtime available?"
if [ "$(uname)" = "Darwin" ]; then
  command -v sandbox-exec >/dev/null && echo "OK (sandbox-exec)" || echo "MISSING - sandbox-exec not on PATH"
else
  command -v bwrap >/dev/null && echo "OK (bwrap)" || echo "MISSING - install bubblewrap"
fi

echo -e "\n3. Build artefacts present?"
[ -f dist/index.js ] && echo "OK" || echo "MISSING - run npm run build"

echo -e "\n4. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run /setup"

echo -e "\n5. Recent app logs?"
ls -t logs/nanoclaw.log logs/nanoclaw.error.log 2>/dev/null | head -2 || echo "No logs yet"
```
