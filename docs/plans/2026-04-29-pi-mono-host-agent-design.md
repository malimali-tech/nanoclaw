# Provider 重构：迁移到 host-side pi-coding-agent + sandbox-runtime

**Status:** Approved
**Date:** 2026-04-29

## Background

NanoClaw 当前 provider 层（`container/agent-runner/src/providers.ts`）支持三种模式：
1. `anthropic` —— Claude Agent SDK + Claude Code CLI（OneCLI 注入凭证）。
2. `openclaude` —— Claude Agent SDK + `@gitlawb/openclaude` CLI 子进程。
3. `open-agent-sdk` —— 容器内进程跑 `@codeany/open-agent-sdk`。

三套都跑在 per-message 启动的容器里，容器同时承担 Node runtime、LLM 客户端、文件系统隔离三重职责。架构包袱：MCP IPC 文件、容器构建脚本、provider 分支、cold start 开销、CLI 子进程。

目标是用单一 provider 替换三种模式，并让架构本身变干净。

## Decision

迁移到 **host-side `@mariozechner/pi-coding-agent` SDK + `@anthropic-ai/sandbox-runtime`** 架构：

- pi SDK 在 NanoClaw 主进程内 in-process 运行（`createAgentSession()`）。
- 所有内置工具（read/bash/edit/write/grep/find/ls）跑在 host，bash 命令通过 sandbox-runtime 包进 macOS `sandbox-exec` / Linux `bubblewrap` 内核级沙盒。
- per-group `AgentSession` 实例 lazy 创建 + idle TTL eviction（默认 10 min）。
- NanoClaw 自定义 IPC 工具（`send_message` 等 8 个）改为 pi extension，闭包持引用直接调主进程模块，删除 file-based IPC。
- 容器整层（`container/`、`container-runner.ts`、`ipc.ts`、`ipc-mcp-stdio.ts`、`agent-runner` package、OneCLI provider 切换、`NANOCLAW_LLM_PROVIDER`）整体删除。

不考虑向后兼容；pi 哲学（"No MCP / No sub-agents / No to-dos"）原样吸收，原有 Team/Task*/Skill/TodoWrite/WebSearch/WebFetch/NotebookEdit 工具一律砍掉，未来由用户装 pi extension 扩展。

## Architecture

```
src/index.ts (主进程)
   │
   ├─ channels/* (WhatsApp, Telegram, ... 自注册，不变)
   │     ↓ inbound message
   ├─ src/agent/session-pool.ts  ── per-group AgentSession (lazy + idle TTL)
   │     ↓
   │   pi SDK: createAgentSession({ cwd: groups/<g>/, resourceLoader, sessionManager })
   │     ↓
   │   src/agent/extension.ts (NanoClaw pi extension)
   │     - 注册 8 个 IPC 工具（直接调 router/taskScheduler）
   │     - 接 sandbox-runtime
   │     ↓
   │   pi 内置工具 (read/bash/edit/write/grep/find/ls)
   │     ↓
   │   sandbox-runtime (sandbox-exec / bubblewrap)
   │
   ├─ router.ts (outbound, 不变)
   └─ task-scheduler.ts (改为直接 createAgentSession 跑临时 session)

REMOVED: container/, container-runner.ts, ipc.ts, ipc-mcp-stdio.ts,
         container/agent-runner package, OneCLI provider switching,
         NANOCLAW_LLM_PROVIDER + 衍生 env 翻译
```

## Components

### `src/agent/session-pool.ts` (new)

per-group `AgentSession` 缓存。

```ts
class SessionPool {
  getOrCreate(groupFolder: string, ctx: ExtensionCtx): Promise<AgentSession>;
  dispose(groupFolder: string): Promise<void>;
  disposeAll(): Promise<void>;
}
```

- 每个 entry 维护 `lastUsedAt` + `idleTimer`。
- TTL 默认 10 min（`NANOCLAW_AGENT_IDLE_TTL_MS` 覆盖）。
- TTL 到期 → `session.dispose()` 并从 pool 移除。
- 进程退出（SIGTERM/SIGINT）时 `disposeAll()`。

### `src/agent/extension.ts` (new)

pi extension factory。由主进程通过 `DefaultResourceLoader({ extensionFactories: [nanoclawExtension(ctx)] })` 注入。

闭包 ctx：
```ts
interface ExtensionCtx {
  router: Router;
  taskScheduler: TaskScheduler;
  groupRegistry: GroupRegistry;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
}
```

注册 8 个工具，每个直接调主进程方法：
- `send_message` → `router.send(chatJid, text, sender?)`
- `schedule_task` / `update_task` / `pause_task` / `resume_task` / `cancel_task` / `list_tasks` → `taskScheduler.*`
- `register_group`（仅 main）→ `groupRegistry.register(...)`

tool 参数 schema 直接复用现有 `ipc-mcp-stdio.ts` 里的 zod schema（迁移到 typebox 或保留 zod 任选；pi 用 typebox，统一更佳）。

注册 sandbox：
- 在 extension `session_start` 钩子里调 `SandboxManager.initialize(loadConfig(cwd))`。
- `pi.on("user_bash", () => ({ operations: createSandboxedBashOps() }))`。
- 重写内置 `bash` 工具，注入 sandboxed `BashOperations`。
- 参考 `pi-mono/packages/coding-agent/examples/extensions/sandbox/index.ts`。

### `src/agent/sandbox-config.ts` (new)

加载并合并 sandbox 配置。

```ts
function loadSandboxConfig(groupCwd: string): SandboxConfig {
  // 1. 仓库内置默认 (config/sandbox.default.json)
  // 2. 与 groups/<g>/.pi/sandbox.json 深合并
}
```

默认配置：
- `network.allowedDomains`：常见包源（npm/pypi/github/anthropic/openai 等）。
- `filesystem.denyRead`：`~/.ssh`、`~/.aws`、`~/.gnupg`、宿主机 NanoClaw 仓库根（防 agent 改主仓）。
- `filesystem.allowWrite`：`groups/<g>/`、`/tmp`。
- `filesystem.denyWrite`：`.env`、`*.pem`、`*.key`。

### `src/agent/run.ts` (new)

主入口。`handleMessage({ groupFolder, chatJid, isMain, text }): Promise<void>`。

```ts
const session = await pool.getOrCreate(groupFolder, ctx);
if (session.isStreaming) {
  await session.steer(text);
} else {
  await session.prompt(text);
}
```

session 创建时：
- `subscribe()` 事件流：
  - `text_delta` → 累积到 router buffer。
  - `turn_end` 或 `agent_end` → flush 给用户。
  - `tool_execution_start/end` → 可选记 log。
- `cwd: groups/<groupFolder>/`。
- `sessionManager: SessionManager.create(groupCwd)` —— pi 自动写 JSONL 到 `groups/<g>/.pi/sessions/`。
- `resourceLoader: DefaultResourceLoader({ cwd, agentDir, extensionFactories: [nanoclawExtension(ctx)] })`。
- `authStorage: AuthStorage.create()`，启动时 `setRuntimeApiKey()` 写入用户配置的 API key（不持久化到 `auth.json`）。

### `src/task-scheduler.ts` (modified)

去掉 `containerRunner.run()` 调用，改为：
```ts
const session = await createAgentSession({
  cwd: groupCwd,
  sessionManager: contextMode === 'group'
    ? SessionManager.continueRecent(groupCwd)
    : SessionManager.inMemory(),
  resourceLoader: ...,
  authStorage,
});
await session.prompt(taskPrompt);
await session.dispose();
```

scheduled task 不复用 pool 里的 session（避免与用户消息互相干扰）。

## Data Flow

```
inbound message
  → channel adapter → src/index.ts dispatcher
  → handleMessage(ctx)
  → pool.getOrCreate(groupFolder)
       first time:
         createAgentSession({ cwd, resourceLoader[nanoclawExt], sessionManager })
         subscribe events → router
  → if session.isStreaming: session.steer(text)
    else: session.prompt(text)
  → events:
       text_delta → router.bufferText(chatJid)
       turn_end → router.flush(chatJid)
       tool_execution_start("bash") → SandboxManager wraps command via spawnHook
  → resolve after agent_end
```

session JSONL 持久化由 pi 接管，崩溃后 `SessionManager.continueRecent(groupCwd)` 恢复。

## Error Handling

- **pi 工具内异常**：pi SDK 捕获并塞回 LLM 作为 tool error，agent 自行处理。
- **LLM/network 错误**：pi 内置 retry + auto-compact，由 `settings.json`（`retry.maxRetries`、`compaction.enabled`）配置。
- **sandbox 初始化失败**：log 警告，**不**降级；fail-fast 并通过 router 通知 main group。
- **pool entry 异常**：捕获 `session.agent.state.errorMessage`，dispose 该 entry；下条消息重新建。
- **进程崩溃**：session JSONL 已 flush，重启自动恢复；in-memory 队列状态丢失（已 ack 的消息不会重发）。
- **凭证缺失**：启动时探测 `authStorage.getCredential(provider)`，缺则 fail-fast，打印 `.env` 配置指引。

## Testing

- `session-pool.test.ts`：lazy 创建、TTL eviction、`disposeAll`，使用 fake clock。
- `extension.test.ts`：每个 IPC 工具注入 mock ctx，断言对应主进程方法被调用 + 参数透传。
- `sandbox-config.test.ts`：默认 + project override 深合并。
- `run.test.ts`：in-memory router + scheduler，断言 `prompt`/`steer` 路径切换。
- 手动 smoke：`npm run dev`，从 WhatsApp 发 "列一下当前目录"，验证 bash 走 sandbox（`ps -ef | grep sandbox-exec` 可观测）。
- 删除 `container/agent-runner/src/providers.test.ts` 整个文件。

## Removed Surface

- 整个 `container/` 目录（含 `agent-runner` package、`build.sh`、`Dockerfile`、container skills）。
- `src/container-runner.ts`、`src/ipc.ts`。
- `NANOCLAW_LLM_PROVIDER` env、provider 切换逻辑、CODEANY_*/GEMINI_*/OPENAI_* 翻译层。
- OneCLI 凭证注入路径（pi `AuthStorage` 接管）。
- 容器相关 skill：`/convert-to-apple-container`、`/init-onecli` 等需要标 deprecated 或删除（按 repo 维护策略）。
- `CLAUDE.md` 里 OneCLI / `NANOCLAW_LLM_PROVIDER` 段落。

## Open Items（不阻塞设计）

- pi extension 在多个 group session 间是否各持一份 ctx：是的，每个 session 各自 `extensionFactories: [nanoclawExtension(ctxForGroup)]`。
- Windows 支持：sandbox-runtime 不支持 Windows，文档需声明 macOS / Linux only（现状本来就是）。
- 已存在用户 group 数据迁移：`groups/<g>/CLAUDE.md` 保留，session 历史从 0 开始（旧容器内 session 不可还原，不考虑兼容）。
