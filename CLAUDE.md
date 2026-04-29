# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with a skill-based channel system. Feishu / Lark is currently the only built-in channel; it self-registers at startup via `src/channels/feishu.ts`. Messages route to `@mariozechner/pi-coding-agent` running in-process on the host. Each group has its own working directory and per-group session state. Bash commands from the agent run inside `sandbox-exec` (macOS) or `bubblewrap` (Linux); see `config/sandbox.default.json` for the default network/filesystem rules.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/agent/run.ts` | In-process pi-coding-agent runtime entry point |
| `src/agent/extension.ts` | NanoClaw IPC tools as a pi extension |
| `src/agent/session-pool.ts` | Per-group AgentSession pool with idle TTL |
| `src/agent/sandbox-config.ts` | Sandbox config loader (default + per-group override) |
| `src/agent/types.ts` | Extension ctx and port interfaces |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `config/sandbox.default.json` | Default sandbox profile (network + filesystem rules) |

## LLM Provider

NanoClaw runs `@mariozechner/pi-coding-agent` in-process. Configure your provider via environment variables (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) or `~/.pi/agent/auth.json`. See [pi-mono docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) for the full provider list and authentication options.

Bash commands run inside an OS-level sandbox (`sandbox-exec` on macOS, `bubblewrap` on Linux) configured by `config/sandbox.default.json` and per-group overrides at `groups/<group>/.pi/sandbox.json`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-feishu`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
```

The agent now runs in the main process — there is no container build step. Bash commands from the agent are sandboxed via `sandbox-exec` (macOS) or `bubblewrap` (Linux); see `config/sandbox.default.json`.

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

