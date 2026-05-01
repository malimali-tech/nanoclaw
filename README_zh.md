<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  一个轻量级的个人 AI 助手。pi-coding-agent 在主进程内运行，bash 命令通过 <code>sandbox-exec</code> / <code>bubblewrap</code> 沙箱化。代码量小到可以完全读懂，可以按你的需求随意改造。
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

> **关于本 fork：** 这个 fork 只内置飞书 / Lark 一个 channel。上游 nanoclaw 的多 channel 技能（add-whatsapp / add-telegram / add-slack / add-discord）这里都没有，相应的运行时代码与设置流程也已移除。

---

## 为什么有这个项目

[OpenClaw](https://github.com/openclaw/openclaw) 是个令人印象深刻的项目，但把一个近 50 万行代码、53 个配置文件、70+ 依赖、安全靠应用层白名单 + 配对码、所有东西跑在一个共享内存 Node 进程里的软件接入我的生活——我睡不着。

NanoClaw 提供同样的核心功能，但代码库小到可以完全读懂：一个进程，几个源文件。Coding agent 通过 [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 在主进程内运行，bash 命令在 OS 层用 `sandbox-exec`（macOS）或 `bubblewrap`（Linux）做内核级沙箱——不是仅仅通过权限检查。

## 快速开始

```bash
gh repo fork malimali-tech/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>不用 GitHub CLI</summary>

1. 在 GitHub 上 Fork [malimali-tech/nanoclaw](https://github.com/malimali-tech/nanoclaw)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

然后运行 `/setup`。Claude Code 会处理一切：依赖安装、凭据配置、沙箱设置、服务启动。

> **注意：** 以 `/` 开头的命令（`/setup`、`/customize` 等）是 [Claude Code 技能](https://code.claude.com/docs/en/skills)。请在 `claude` CLI 提示符里输入，不是普通 shell。还没装 Claude Code 可在 [claude.com/product/claude-code](https://claude.com/product/claude-code) 获取。

## 设计哲学

**小到能读懂。** 一个进程，几个源文件，没有微服务。想搞清楚整个 NanoClaw 是怎么运转的？让 Claude Code 带你过一遍代码就行。

**通过隔离保障安全。** Agent 跑出来的 bash 命令在 OS 级沙箱里运行——macOS 的 `sandbox-exec`、Linux 的 `bubblewrap`——配置由 `config/sandbox.default.json` 决定，每个群组还能在 `groups/<group>/.pi/sandbox.json` 做独立 override。文件系统和网络访问由策略控制，不是只靠权限检查。

**为单一用户打造。** NanoClaw 不是一个大而全的框架，而是恰好符合你需求的一份代码。Fork 一份，让 Claude Code 按你的偏好改造它。

**定制即代码改动。** 没有配置爆炸。想要不同的行为？改代码。代码足够小，改起来安全。

**AI 原生。**
- 没有安装向导，由 Claude Code 引导。
- 没有监控面板，问 Claude 当前在跑什么。
- 没有调试工具，描述问题让 Claude 修。

**技能优于功能。** 与其往代码库里加新集成，不如以 [Claude Code 技能](https://code.claude.com/docs/en/skills) 形式贡献（例如 `/add-karpathy-llm-wiki`、`/add-parallel`）来改造你的 fork。Feishu 在这个 fork 里直接 baked into `main`，不再走技能路径。

**Pi-coding-agent 进程内运行。** NanoClaw 直接嵌入 [`@mariozechner/pi-coding-agent`](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)——没有子进程、没有容器构建。Provider 通过标准环境变量选择（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`…）或 `~/.pi/agent/auth.json`。

## 支持的能力

- **飞书 / Lark 消息** — 通过 WebSocket 长连接和飞书（国内）或 Lark（国际）群对话，无需公网 URL。本 fork 仅内置飞书 channel；上游其他 channel 在这里不可用。
- **群组隔离的上下文** — 每个群组都有独立的 `CLAUDE.md` 记忆和工作目录；bash 命令受群组级沙箱配置约束。
- **主频道（main）** — 你的私有频道（self-chat），用于管理控制；其他群组完全隔离。
- **计划任务** — 周期性运行 agent，并能给你回发消息。
- **网络访问** — 在沙箱允许的域名范围内搜索和抓取网页。
- **OS 级沙箱** — bash 命令通过 `sandbox-exec`（macOS）或 `bubblewrap`（Linux）执行；规则在 `config/sandbox.default.json`，每群可在 `groups/<group>/.pi/sandbox.json` 覆盖。
- **多 Provider** — pi-coding-agent 支持 Anthropic、OpenAI、Gemini、DeepSeek 等，通过 .env 或 `~/.pi/agent/auth.json` 配置。

## 使用方法

用触发词（默认 `@Andy`）跟助手对话：

```
@Andy 每个工作日早 9 点给我一份销售流水概览（可以读我的 Obsidian vault）
@Andy 每周五回顾一下过去一周的 git 历史，发现和 README 不一致就更新 README
@Andy 每周一早 8 点，从 Hacker News 和 TechCrunch 收集 AI 进展，给我一份简报
```

在主频道（self-chat）可以管理群组和任务：
```
@Andy 列出所有群组的计划任务
@Andy 暂停"周一简报"任务
@Andy 加入"家庭群"
```

## 定制

NanoClaw 没有配置文件，要改什么直接告诉 Claude Code：

- "把触发词改成 @Bob"
- "以后回答都简短直接一点"
- "我说早上好的时候加个自定义问候"
- "每周存一份对话总结"

或者运行 `/customize` 走引导式流程。

代码足够小，让 Claude 改不会失控。

## 贡献

**别加功能，加技能。**

想加新能力（比如另一个 channel、一个 MCP 集成、一个工作流）？不要直接往主仓库里加，而是 Fork → 在分支上写代码 → 开 PR。我们会把它做成一个其他用户可按需 merge 的技能。

用户只要在自己的 fork 上运行 `/add-<your-skill>`，就能拿到一份只做他们需要的事的整洁代码，而不是一个试图支持所有用例的臃肿系统。

## 系统要求

- macOS、Linux、或 Windows（通过 WSL2）
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- macOS：`sandbox-exec`（系统自带）。Linux：`bubblewrap`（`apt install bubblewrap` / `dnf install bubblewrap`）。

## 架构

```
Channels --> SQLite (元数据) + log.jsonl (消息) --> 轮询循环 --> pi-coding-agent (进程内 + sandbox 化 bash) --> 回复
```

单 Node.js 进程。Channel 通过技能添加并在启动时自注册——orchestrator 连接所有凭据齐全的 channel。Agent 在主进程内通过 `@mariozechner/pi-coding-agent` 运行；bash 命令包裹在 `sandbox-exec`（macOS）/ `bubblewrap`（Linux）里，规则来自 `config/sandbox.default.json`（可被群级覆盖）。每个群组有独立的消息队列和会话池。

完整迁移设计参见 [docs/plans/2026-04-29-pi-mono-host-agent-design.md](docs/plans/2026-04-29-pi-mono-host-agent-design.md)。

关键文件：
- `src/index.ts` — orchestrator：状态、消息循环、agent 调用
- `src/channels/registry.ts` — channel 自注册表
- `src/channels/feishu.ts` — 飞书 / Lark channel 实现
- `src/router.ts` — 消息格式化与出站路由
- `src/group-log.ts` — 每群的 `log.jsonl` 追加 / 尾读 / cursor
- `src/agent/run.ts` — 进程内 pi-coding-agent 运行入口
- `src/agent/extension.ts` — NanoClaw 的 IPC 工具（pi extension）
- `src/agent/session-pool.ts` — 每群一个 AgentSession，带 idle TTL
- `src/agent/sandbox-config.ts` — sandbox 配置加载（默认 + 每群覆盖）
- `src/task-scheduler.ts` — 计划任务调度器
- `src/db.ts` — SQLite（scheduled_tasks / sessions / registered_groups / router_state）
- `groups/*/CLAUDE.md` — 每群的记忆
- `config/sandbox.default.json` — 默认沙箱 profile（网络 / 文件系统规则）

## FAQ

**为什么不用容器了？**

NanoClaw 早期为每条消息启一个 Linux 容器跑 agent。pi-mono 迁移之后改成进程内执行 + bash OS 级沙箱（macOS 的 `sandbox-exec`、Linux 的 `bubblewrap`）：更快，不再有每条消息的冷启动，文件系统和网络隔离仍然在内核层。

**Linux / Windows 上能跑吗？**

可以。macOS 用系统自带的 `sandbox-exec`。Linux 需要装 `bubblewrap`（`apt install bubblewrap` / `dnf install bubblewrap`）。Windows 通过 WSL2（走 Linux 路径）。`/setup` 一把搞定。

**安全吗？**

Agent 的 bash 命令在 OS 级沙箱里运行，文件系统和网络访问受限——规则声明在 `config/sandbox.default.json`，可以按需收紧。代码库小，整个攻击面、包括沙箱怎么调用，都能完整 review。

**为什么没有配置文件？**

不想要配置爆炸。每个用户都应该把代码改成正好符合自己需求，而不是去配一个通用系统。如果你偏好配置文件，让 Claude 给你加。

**能用第三方或本地模型吗？**

能。NanoClaw 把 provider 选择委托给 `@mariozechner/pi-coding-agent`。在 .env 里设你想用的环境变量：

```bash
ANTHROPIC_API_KEY=...     # Anthropic
OPENAI_API_KEY=...        # OpenAI / OpenAI-兼容（DeepSeek、Qwen 等）
GEMINI_API_KEY=...        # Google Gemini
DEEPSEEK_API_KEY=...      # DeepSeek
```

也可以用 `~/.pi/agent/auth.json` 存凭据。OpenAI 兼容的本地或自托管端点用对应的 base URL 环境变量（如 `OPENAI_BASE_URL`）。完整 provider 列表见 [pi-coding-agent 文档](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)。

**怎么调试？**

问 Claude Code。"调度器为什么没跑？""最近的日志里有什么？""这条消息为什么没回复？" 这就是 NanoClaw 的 AI 原生方式。

**装不上怎么办？**

设置过程中 Claude 会动态修复问题。如果还是不行，运行 `claude` 然后 `/debug`。如果 Claude 发现了一个可能影响其他人的问题，欢迎开 PR 改 setup SKILL.md。

**什么样的代码改动会被合并？**

仅安全修复、bug 修复、和对基础配置的清晰改进。其他东西（新能力、OS 兼容性、硬件支持、增强）都应该作为技能贡献。

这样基础系统保持最小，每个用户可以按自己的需要定制，不必背着自己用不到的功能。

## 社区

有疑问或想法？[加入 Discord](https://discord.gg/VDdww8qS42)。

## 更新日志

破坏性变更和迁移说明见 [CHANGELOG.md](CHANGELOG.md)，完整发布历史见 [文档站 changelog](https://docs.nanoclaw.dev/changelog)。

## 许可

MIT
