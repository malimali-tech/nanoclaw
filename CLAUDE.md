# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with a skill-based channel system. Feishu / Lark is currently the only built-in channel; it self-registers at startup via `src/channels/feishu.ts`. Messages route to `@mariozechner/pi-coding-agent` running in-process on the host. Each group has its own working directory and per-group session state.

**Tool isolation.** Agent tool calls are isolated per chat. The runtime is selected in `config/sandbox.default.json` (`runtime: "docker" | "sandbox-exec" | "off"`); default is **docker**. In docker mode each chat gets a dedicated container (`nanoclaw-tool-<group>`) with bind mounts that physically expose only that chat's group folder + global; bash forwards through `docker exec`. Read/Write/Edit/Grep/Find/Ls stay on the host (so binaries / images / NUL bytes work) but are wrapped with a per-chat path-guard that mirrors the container's mount surface. `sandbox-exec` is a fallback for environments without Docker (CI, dev laptops); it sandboxes only bash via `sandbox-exec` / `bubblewrap`.

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
| `src/agent/sandbox-config.ts` | Sandbox config loader (single global policy + runtime selector) |
| `src/agent/tool-runtime.ts` | Selects runtime (docker / sandbox-exec / off) and produces per-chat tool bindings |
| `src/agent/container-pool.ts` | Per-chat docker container lifecycle (aligned with SessionPool) |
| `src/agent/container-mounts.ts` | Per-chat bind-mount set (group folder, global, main-only project) |
| `src/agent/container-runtime.ts` | Thin `docker` CLI wrapper (info / image inspect / run / stop) |
| `src/agent/docker-bash.ts` | `BashOperations` that forwards via `docker exec` into the chat's container |
| `src/agent/host-fs-tools.ts` | Read/Write/Edit/Grep/Find/Ls Operations backed by host fs + path-guard |
| `src/agent/path-guard.ts` | Validates host paths against the chat's allowed roots |
| `src/agent/sandbox-bash.ts` | (sandbox-exec mode) Sandboxed `BashOperations` wrapper for pi's bash |
| `src/agent/types.ts` | Extension ctx and port interfaces |
| `container/Dockerfile` | Tool sandbox image (debian-slim + bash + ripgrep + git + curl) |
| `container/build.sh` | `docker build -t nanoclaw-tool:latest container/` |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `config/sandbox.default.json` | Runtime + policy file |

## LLM Provider

NanoClaw runs `@mariozechner/pi-coding-agent` in-process. Configure your provider via environment variables (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) or `~/.pi/agent/auth.json`. See [pi-mono docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) for the full provider list and authentication options.

Tool isolation is selected by `runtime` in `config/sandbox.default.json`. **Default: `docker`.** Initialization happens once at startup in `src/index.ts` via `ensureSandbox()` (which calls `initToolRuntime()`):

- **docker mode** (default): verify daemon reachable + image `nanoclaw-tool:latest` exists; create per-chat container on first session prompt (`ContainerPool.ensure`), tear down on session evict. Bash → `docker exec`. Read/Write/Edit/Grep/Find/Ls → host fs with `PathGuard` that mirrors the container's mount surface (own group folder + global + main-only project RO).
- **sandbox-exec mode** (fallback): `SandboxManager.initialize()` + self-check that `wrapWithSandbox` emits the OS wrapper. Bash only is sandboxed; fs tools run with pi defaults (no isolation). Use only when Docker is unavailable.
- **off mode**: pi defaults across the board. Dev only.

Build the image once before first run in docker mode: `./container/build.sh`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-macos-statusbar`). Feishu itself is baked into `main` here, not a skill.
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Modifying NanoClaw behavior (triggers, integrations, router) |
| `/debug` | Logs, troubleshooting, sandbox/agent issues |
| `/add-macos-statusbar` | Install macOS menu bar indicator (one-time, macOS only) |

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

