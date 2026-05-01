<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  A lightweight personal AI assistant. Runs an in-process pi-coding-agent on the host, with bash commands sandboxed via `sandbox-exec` / `bubblewrap`. Built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

> **🔥 New Version Preview: Chat SDK + Approval Dialogs**
>
> A new version of NanoClaw is available for preview, featuring Vercel Chat SDK integration (15 messaging platforms from one codebase) and one-tap approval dialogs for sensitive agent actions. [Read the announcement →](https://venturebeat.com/orchestration/should-my-enterprise-ai-agent-do-that-nanoclaw-and-vercel-launch-easier-agentic-policy-setting-and-approval-dialogs-across-15-messaging-apps)
>
> <details>
> <summary>Try the preview</summary>
>
> ```bash
> gh repo fork qwibitai/nanoclaw --clone && cd nanoclaw
> git checkout v2
> claude
> ```
> Then run `/setup`. Feedback welcome on [Discord](https://discord.gg/VDdww8qS42). Expect breaking changes before merge to main.
>
> </details>

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. The coding agent runs in-process via [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), and agent tool calls are isolated **per chat** — by default each chat gets a dedicated Docker container (`nanoclaw-tool-<group>`) that bind-mounts only that chat's group folder. Cross-chat reads are physically prevented by the kernel rather than by an application-layer ACL. A lighter `sandbox-exec` / `bubblewrap` fallback is available for environments without Docker.

## Quick Start

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

Then run `/setup`. Claude Code handles everything: dependencies, authentication, sandbox configuration, and service setup.

> **Note:** Commands prefixed with `/` (like `/setup`, `/customize`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by per-chat isolation.** Each chat owns a dedicated Docker container with bind mounts that physically expose only that chat's group folder + global memory (main additionally gets project source RO with `.env` shadowed). Bash forwards into that container via `docker exec`. Read/Write/Edit/Grep/Find/Ls run on the host (so binary files / images / NUL bytes still work) but go through a per-chat path-guard that mirrors the same surface. Cross-chat file access is blocked by the kernel + the path-guard, not by an application-layer ACL. The runtime is selected in `config/sandbox.default.json` (`runtime: "docker"` is default; `"sandbox-exec"` is the no-Docker fallback).

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding new integrations to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) (e.g. `/add-macos-statusbar`, `/customize`) that transform your fork. You end up with clean code that does exactly what you need. Feishu itself isn't a skill in this fork — it's baked into `main`.

**Pi-coding-agent in-process.** NanoClaw embeds [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) directly — no subprocess, no container build. The provider is selected via standard environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) or `~/.pi/agent/auth.json`.

## What It Supports

- **Feishu / Lark messaging** - Talk to your assistant from Feishu (国内) or Lark (国际) groups via WebSocket long-connection — no public URL needed. This fork ships only the Feishu channel; other channels are upstream skills that don't apply here.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, working directory, and (in docker mode) its own tool sandbox container — one chat's files are physically invisible to another chat's bash.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run the agent and can message you back
- **Web access** - Search and fetch content from the Web
- **Per-chat tool sandbox** - Default: each chat = one Docker container, bash routed via `docker exec`, fs tools path-guarded on host. Fallback: `sandbox-exec` (macOS) / `bubblewrap` (Linux) for Docker-less environments. Selected by `runtime` in `config/sandbox.default.json`
- **Multi-provider** - Pi-coding-agent supports Anthropic, OpenAI, Gemini, and more — configure via env vars or `~/.pi/agent/auth.json`
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add a new capability (a different channel, an MCP integration, a workflow), don't create a PR that adds it to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll turn your branch into a skill that other users can merge into their fork on demand.

Users then run `/add-<your-skill>` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- **Default (docker mode):** Docker Desktop (macOS/Windows) or `docker` daemon (Linux). Then `./container/build.sh` once to build the `nanoclaw-tool:latest` image.
- **Fallback (sandbox-exec mode):** macOS: `sandbox-exec` (built-in). Linux: `bubblewrap` (`apt install bubblewrap` / `dnf install bubblewrap`). Set `"runtime": "sandbox-exec"` in `config/sandbox.default.json`.

## Architecture

```
Channels --> SQLite --> Polling loop --> pi-coding-agent (in-process, sandboxed bash) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. The agent runs in-process via `@mariozechner/pi-coding-agent`. Tool isolation is selected by `runtime` in `config/sandbox.default.json`:

- `docker` (default): one container per chat. `src/agent/container-pool.ts` owns lifecycle (created on first prompt via `SessionPool`, removed on idle eviction). `src/agent/container-mounts.ts` decides per-chat bind mounts. `src/agent/docker-bash.ts` forwards bash via `docker exec`. `src/agent/host-fs-tools.ts` keeps Read/Write/Edit/Grep/Find/Ls on the host (binary-correct) but wraps each call with `src/agent/path-guard.ts` against the chat's allowed roots.
- `sandbox-exec`: bash via `SandboxManager.wrapWithSandbox` (macOS sandbox-exec / Linux bubblewrap); fs tools run with pi defaults. Fallback for Docker-less environments.
- `off`: pi defaults across the board. Dev only.

`src/agent/tool-runtime.ts` is the single switching point.

For the full architecture details, see the [pi-mono migration design doc](docs/plans/2026-04-29-pi-mono-host-agent-design.md).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/agent/run.ts` - In-process pi-coding-agent runtime entry point
- `src/agent/extension.ts` - NanoClaw IPC tools as a pi extension
- `src/agent/session-pool.ts` - Per-group AgentSession pool with idle TTL
- `src/agent/sandbox-config.ts` - Runtime selector + policy loader
- `src/agent/tool-runtime.ts` - Initializes runtime + produces per-chat tool bindings
- `src/agent/container-pool.ts` / `container-mounts.ts` / `container-runtime.ts` - Docker mode
- `src/agent/docker-bash.ts` - Bash via `docker exec` (docker mode)
- `src/agent/host-fs-tools.ts` + `path-guard.ts` - Read/Write/Edit/Grep/Find/Ls on host with per-chat path-guard
- `src/agent/sandbox-bash.ts` - Bash via `SandboxManager.wrapWithSandbox` (sandbox-exec mode)
- `container/Dockerfile` + `container/build.sh` - Tool sandbox image
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory
- `config/sandbox.default.json` - Default sandbox profile (network/filesystem rules)

## FAQ

**Why no containers?**

NanoClaw originally spawned one Linux container per agent invocation, with the entire agent (LLM loop + tools + claude-code CLI) inside. The pi-mono migration moved the LLM loop to the host. Now in docker mode the container is just a per-chat **tool jail**: bash commands forward into it, but the LLM loop, credentials, and stateful extension tools (`send_message`, `schedule_task`) stay on the host. This drops the credential proxy, IPC channel, and agent-runner Node app the old setup needed (~1700 LOC), while keeping per-chat mount-physical isolation. Cost: a per-chat container (`sleep infinity`) and ~100ms per `docker exec` tool call.

**Can I run this on Linux or Windows?**

Yes. Default docker mode works wherever Docker / Docker Desktop runs (macOS, Linux, Windows via WSL2). The sandbox-exec fallback uses macOS's built-in `sandbox-exec` or Linux `bubblewrap` (`apt install bubblewrap` / `dnf install bubblewrap`). Run `/setup` to be guided.

**Is this secure?**

Default docker mode runs each chat's bash in its own container with bind-mounted access to that chat's group folder only — the kernel itself prevents cross-chat reads, not an in-process ACL. Read/Write/Edit/Grep/Find/Ls run on the host (so binaries and image previews work) but go through a per-chat path-guard mirroring the container's mount surface. The codebase is small enough that you can review the entire isolation path: `tool-runtime.ts` → `container-pool.ts` + `path-guard.ts`. On startup the runtime fails fast if Docker isn't reachable or the `nanoclaw-tool` image isn't built — no silent fallback to "unsandboxed". The sandbox-exec fallback similarly self-checks that `wrapWithSandbox` actually emits the OS wrapper.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw delegates provider selection to `@mariozechner/pi-coding-agent`. Set the standard env vars for whichever provider you want:

```bash
ANTHROPIC_API_KEY=...     # Anthropic
OPENAI_API_KEY=...        # OpenAI / OpenAI-compatible (DeepSeek, Qwen, etc.)
GEMINI_API_KEY=...        # Google Gemini
```

You can also keep credentials in `~/.pi/agent/auth.json`. For OpenAI-compatible local or self-hosted endpoints, override the base URL via the corresponding pi-mono env var (e.g. `OPENAI_BASE_URL`). See the [pi-coding-agent docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) for the full provider list and configuration options.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT
