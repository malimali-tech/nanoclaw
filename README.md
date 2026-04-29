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

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. The coding agent runs in-process via [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent), and bash commands are isolated at the OS level using `sandbox-exec` (macOS) or `bubblewrap` (Linux) — not merely behind permission checks.

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

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-feishu`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Bash commands from the agent run inside an OS-level sandbox — `sandbox-exec` on macOS, `bubblewrap` on Linux — configured by `config/sandbox.default.json` with optional per-group overrides. Filesystem and network access are restricted by policy, not just by permission checks.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding new channels or integrations to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) (e.g. a hypothetical `/add-slack`) that transform your fork. You end up with clean code that does exactly what you need.

**Pi-coding-agent in-process.** NanoClaw embeds [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) directly — no subprocess, no container build. The provider is selected via standard environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) or `~/.pi/agent/auth.json`.

**Optional Docker tool sandbox.** For stronger isolation, set `runtime: 'docker'` in `config/sandbox.default.json` to forward all 7 pi-coding-agent tools (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) into a long-running `nanoclaw-sandbox` Debian container via `docker exec`. The pi-mono LLM loop and your provider credentials never leave the host — only file/shell operations cross into the container, which mounts the repo read-only and shadows `.env` so the agent cannot read host LLM keys. NanoClaw does not auto-create the container; you manage its lifecycle with `./scripts/sandbox.sh {create,start,stop,remove,status,shell}`. The default remains `runtime: 'sandbox-runtime'` (OS-level `sandbox-exec` / `bubblewrap`); Docker is opt-in. See [docs/plans/2026-04-29-docker-tool-sandbox-design.md](docs/plans/2026-04-29-docker-tool-sandbox-design.md) for the full design.

## What It Supports

- **Feishu / Lark messaging** - Talk to your assistant from Feishu (国内) or Lark (国际) groups via WebSocket long-connection — no public URL needed. Other channels can be added back later as skills.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory and working directory; bash commands are sandboxed with a per-group sandbox profile.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run the agent and can message you back
- **Web access** - Search and fetch content from the Web
- **OS-level sandbox** - Bash commands run via `sandbox-exec` (macOS) or `bubblewrap` (Linux); rules live in `config/sandbox.default.json` with per-group overrides at `groups/<group>/.pi/sandbox.json`
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

If you want to add a new channel (e.g. Slack), don't create a PR that adds it to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll create a `skill/<channel>` branch from your PR that other users can merge into their fork.

Users then run `/add-<channel>` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- macOS: `sandbox-exec` (built-in). Linux: `bubblewrap` (`apt install bubblewrap` / `dnf install bubblewrap`).

## Architecture

```
Channels --> SQLite --> Polling loop --> pi-coding-agent (in-process, sandboxed bash) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. The agent runs in-process via `@mariozechner/pi-coding-agent`; bash commands are wrapped in `sandbox-exec` (macOS) or `bubblewrap` (Linux) using rules from `config/sandbox.default.json` (with optional per-group overrides). Per-group message queue with concurrency control.

For the full architecture details, see the [pi-mono migration design doc](docs/plans/2026-04-29-pi-mono-host-agent-design.md).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/agent/run.ts` - In-process pi-coding-agent runtime entry point
- `src/agent/extension.ts` - NanoClaw IPC tools as a pi extension
- `src/agent/session-pool.ts` - Per-group AgentSession pool with idle TTL
- `src/agent/sandbox-config.ts` - Sandbox config loader (default + per-group override)
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory
- `config/sandbox.default.json` - Default sandbox profile (network/filesystem rules)

## FAQ

**Why no containers?**

NanoClaw used to spawn one Linux container per agent invocation. The pi-mono migration moved to host-side execution with OS-level sandboxing of bash commands (`sandbox-exec` on macOS, `bubblewrap` on Linux). It's faster, has no per-message cold start, and the security boundary still isolates filesystem and network access at the kernel level.

**Can I run this on Linux or Windows?**

Yes. macOS uses the built-in `sandbox-exec`. Linux requires `bubblewrap` (`apt install bubblewrap` / `dnf install bubblewrap`). Windows works via WSL2 (Linux path). Just run `/setup`.

**Is this secure?**

Bash commands from the agent run in an OS-level sandbox with restricted filesystem and network access — defined declaratively in `config/sandbox.default.json` with per-group overrides. You can audit and tighten the rules. The codebase is small enough that you can review the entire surface area, including how the sandbox is invoked.

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
