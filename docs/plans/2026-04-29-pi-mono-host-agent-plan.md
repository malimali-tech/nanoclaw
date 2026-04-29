# pi-mono Host-Side Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 host-side `@mariozechner/pi-coding-agent` + `@anthropic-ai/sandbox-runtime` 替换容器内 3-provider agent runner，删除容器层，per-group AgentSession 由 lazy pool 管理。

**Architecture:** 主进程 in-process 跑 pi SDK；NanoClaw 通过一个 pi extension 注册 IPC 工具（`send_message` 等 8 个，直接调主进程模块）+ 接 `sandbox-runtime`（macOS `sandbox-exec` / Linux `bubblewrap`）；per-group `AgentSession` 缓存到 `SessionPool`，10 min idle TTL；scheduled task 用临时 session。删除整个 `container/`、`container-runner.ts`、`ipc.ts`、`ipc-mcp-stdio.ts`、provider 切换层。

**Tech Stack:** TypeScript, Node.js, `@mariozechner/pi-coding-agent`, `@anthropic-ai/sandbox-runtime`, vitest（沿用现有测试栈）。

**设计文档：** [`docs/plans/2026-04-29-pi-mono-host-agent-design.md`](./2026-04-29-pi-mono-host-agent-design.md)

---

## Pre-flight

- 本计划运行在专用 worktree 中（brainstorming 阶段已建好，若没有先 `git worktree add ../nanoclaw-pi-mono -b feat/pi-mono-host-agent`）。
- 测试框架：项目用 `vitest`（确认：`grep -r vitest package.json src/*.test.ts | head -3`）。所有新测试用 `*.test.ts` 同目录放置。
- TDD：每个新模块先写 failing test → 跑 → impl → 跑 → commit。
- 删除型任务一次大批 commit，避免中间状态编译失败。

---

## Task 1: 安装 pi-mono 与 sandbox-runtime 依赖

**Files:**
- Modify: `package.json`

**Step 1: 加依赖**

```bash
npm install @mariozechner/pi-coding-agent @anthropic-ai/sandbox-runtime
```

**Step 2: 验证版本写入 dependencies**

Run: `grep -E "pi-coding-agent|sandbox-runtime" package.json`
Expected: 两行都出现在 `"dependencies"` 块里。

**Step 3: 验证主进程能 import（冒烟）**

```bash
node --input-type=module -e "import('@mariozechner/pi-coding-agent').then(m => console.log(Object.keys(m).slice(0,5)))"
```
Expected: 输出 5 个导出名（`AuthStorage`、`createAgentSession` 等之一）。

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @mariozechner/pi-coding-agent and @anthropic-ai/sandbox-runtime"
```

---

## Task 2: 内置 sandbox 默认配置

**Files:**
- Create: `config/sandbox.default.json`

**Step 1: 写文件**

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": [
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "*.npmjs.org",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "api.anthropic.com",
      "api.openai.com",
      "api.deepseek.com",
      "generativelanguage.googleapis.com"
    ],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key", "*.p12"]
  }
}
```

**Step 2: Commit**

```bash
git add config/sandbox.default.json
git commit -m "feat(agent): add default sandbox config"
```

---

## Task 3: `sandbox-config.ts` —— 加载与合并

**Files:**
- Create: `src/agent/sandbox-config.ts`
- Test: `src/agent/sandbox-config.test.ts`

**Step 1: 写 failing test**

```ts
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadSandboxConfig } from './sandbox-config.js';

describe('loadSandboxConfig', () => {
  it('returns built-in default when no project override exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcfg-'));
    const cfg = loadSandboxConfig(tmp);
    expect(cfg.enabled).toBe(true);
    expect(cfg.network?.allowedDomains).toContain('registry.npmjs.org');
  });

  it('deep-merges project override over defaults', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcfg-'));
    fs.mkdirSync(path.join(tmp, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.pi', 'sandbox.json'),
      JSON.stringify({
        network: { allowedDomains: ['my.example.com'] },
        filesystem: { denyWrite: ['secret.txt'] },
      }),
    );
    const cfg = loadSandboxConfig(tmp);
    expect(cfg.network?.allowedDomains).toEqual(['my.example.com']);
    expect(cfg.filesystem?.denyWrite).toEqual(['secret.txt']);
    expect(cfg.filesystem?.allowWrite).toContain('.'); // 默认保留
  });

  it('disables when project sets enabled=false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcfg-'));
    fs.mkdirSync(path.join(tmp, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.pi', 'sandbox.json'),
      JSON.stringify({ enabled: false }),
    );
    expect(loadSandboxConfig(tmp).enabled).toBe(false);
  });
});
```

**Step 2: 跑测试确认 fail**

Run: `npx vitest run src/agent/sandbox-config.test.ts`
Expected: FAIL（模块不存在）。

**Step 3: 实现**

```ts
// src/agent/sandbox-config.ts
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

export interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.resolve(__dirname, '../../config/sandbox.default.json');

function readJsonOrEmpty(p: string): Partial<SandboxConfig> {
  try {
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
  } catch {
    return {};
  }
}

function deepMerge(a: SandboxConfig, b: Partial<SandboxConfig>): SandboxConfig {
  const out: SandboxConfig = { ...a };
  if (b.enabled !== undefined) out.enabled = b.enabled;
  if (b.network) out.network = { ...a.network, ...b.network };
  if (b.filesystem) out.filesystem = { ...a.filesystem, ...b.filesystem };
  return out;
}

export function loadSandboxConfig(groupCwd: string): SandboxConfig {
  const base = readJsonOrEmpty(DEFAULT_PATH) as SandboxConfig;
  const project = readJsonOrEmpty(path.join(groupCwd, '.pi', 'sandbox.json'));
  return deepMerge(base, project);
}
```

**Step 4: 跑测试确认 pass**

Run: `npx vitest run src/agent/sandbox-config.test.ts`
Expected: 3 PASS。

**Step 5: Commit**

```bash
git add src/agent/sandbox-config.ts src/agent/sandbox-config.test.ts
git commit -m "feat(agent): add sandbox config loader with project override merge"
```

---

## Task 4: NanoClaw extension ctx types

**Files:**
- Create: `src/agent/types.ts`

**Step 1: 写文件**

```ts
// src/agent/types.ts
import type { Channel } from '../types.js';

export interface RouterPort {
  /** 立刻发送消息到指定 chat。 */
  send(jid: string, text: string, sender?: string): Promise<void>;
}

export interface TaskSchedulerPort {
  schedule(req: ScheduleTaskRequest): { taskId: string };
  list(opts: { groupFolder: string; isMain: boolean }): ScheduledTaskSummary[];
  pause(taskId: string, scope: { groupFolder: string; isMain: boolean }): void;
  resume(taskId: string, scope: { groupFolder: string; isMain: boolean }): void;
  cancel(taskId: string, scope: { groupFolder: string; isMain: boolean }): void;
  update(req: UpdateTaskRequest): void;
}

export interface GroupRegistryPort {
  register(req: RegisterGroupRequest): void;
}

export type ScheduleType = 'cron' | 'interval' | 'once';

export interface ScheduleTaskRequest {
  prompt: string;
  scheduleType: ScheduleType;
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  targetJid: string;
  createdBy: string;
  script?: string;
}

export interface UpdateTaskRequest {
  taskId: string;
  scope: { groupFolder: string; isMain: boolean };
  prompt?: string;
  scheduleType?: ScheduleType;
  scheduleValue?: string;
  script?: string;
}

export interface ScheduledTaskSummary {
  id: string;
  prompt: string;
  scheduleType: ScheduleType;
  scheduleValue: string;
  status: string;
  nextRun?: string;
  groupFolder: string;
}

export interface RegisterGroupRequest {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requiresTrigger: boolean;
}

/** 注入给 pi extension 的运行时上下文。 */
export interface ExtensionCtx {
  router: RouterPort;
  taskScheduler: TaskSchedulerPort;
  groupRegistry: GroupRegistryPort;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  channels: Channel[];
}
```

**Step 2: 类型检查**

Run: `npx tsc -p . --noEmit`
Expected: 无错（仅新增声明，未引用）。

**Step 3: Commit**

```bash
git add src/agent/types.ts
git commit -m "feat(agent): add extension ctx and port interfaces"
```

---

## Task 5: NanoClaw pi extension（IPC 工具）

**Files:**
- Create: `src/agent/extension.ts`
- Test: `src/agent/extension.test.ts`

**Step 1: 写 failing test**

```ts
// src/agent/extension.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { nanoclawExtension } from './extension.js';
import type { ExtensionCtx } from './types.js';

function makeCtx(over: Partial<ExtensionCtx> = {}): ExtensionCtx {
  return {
    router: { send: vi.fn().mockResolvedValue(undefined) },
    taskScheduler: {
      schedule: vi.fn().mockReturnValue({ taskId: 'task-test' }),
      list: vi.fn().mockReturnValue([]),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      update: vi.fn(),
    },
    groupRegistry: { register: vi.fn() },
    groupFolder: 'wa_test',
    chatJid: 'jid@s',
    isMain: false,
    channels: [],
    ...over,
  };
}

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

function makePi() {
  const tools: RegisteredTool[] = [];
  return {
    pi: {
      registerTool: (t: RegisteredTool) => tools.push(t),
      on: vi.fn(),
      registerCommand: vi.fn(),
    } as any,
    tools,
  };
}

describe('nanoclawExtension', () => {
  it('registers send_message and forwards to router', async () => {
    const ctx = makeCtx();
    const { pi, tools } = makePi();
    nanoclawExtension(ctx)(pi);
    const send = tools.find((t) => t.name === 'send_message')!;
    await send.execute('id1', { text: 'hello', sender: 'Bot' });
    expect(ctx.router.send).toHaveBeenCalledWith('jid@s', 'hello', 'Bot');
  });

  it('schedule_task forwards args and returns taskId', async () => {
    const ctx = makeCtx();
    const { pi, tools } = makePi();
    nanoclawExtension(ctx)(pi);
    const sched = tools.find((t) => t.name === 'schedule_task')!;
    const res = await sched.execute('id', {
      prompt: 'do x',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'group',
    });
    expect(ctx.taskScheduler.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'do x',
        scheduleType: 'interval',
        scheduleValue: '60000',
        contextMode: 'group',
        targetJid: 'jid@s',
        createdBy: 'wa_test',
      }),
    );
    expect(JSON.stringify(res)).toContain('task-test');
  });

  it('register_group is rejected for non-main groups', async () => {
    const ctx = makeCtx({ isMain: false });
    const { pi, tools } = makePi();
    nanoclawExtension(ctx)(pi);
    const reg = tools.find((t) => t.name === 'register_group')!;
    const res = await reg.execute('id', {
      jid: 'g',
      name: 'n',
      folder: 'f',
      trigger: '@a',
    });
    expect(JSON.stringify(res)).toMatch(/main group/i);
    expect(ctx.groupRegistry.register).not.toHaveBeenCalled();
  });

  it('register_group succeeds for main group', async () => {
    const ctx = makeCtx({ isMain: true });
    const { pi, tools } = makePi();
    nanoclawExtension(ctx)(pi);
    const reg = tools.find((t) => t.name === 'register_group')!;
    await reg.execute('id', {
      jid: 'g',
      name: 'n',
      folder: 'f',
      trigger: '@a',
    });
    expect(ctx.groupRegistry.register).toHaveBeenCalledWith({
      jid: 'g',
      name: 'n',
      folder: 'f',
      trigger: '@a',
      requiresTrigger: false,
    });
  });
});
```

**Step 2: 跑测试确认 fail**

Run: `npx vitest run src/agent/extension.test.ts`
Expected: FAIL（模块不存在）。

**Step 3: 实现**

```ts
// src/agent/extension.ts
import { Type } from 'typebox';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { CronExpressionParser } from 'cron-parser';
import type { ExtensionCtx, ScheduleType } from './types.js';

const okText = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: {},
});

const errText = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: {},
  isError: true,
});

function validateSchedule(type: ScheduleType, value: string): string | null {
  if (type === 'cron') {
    try { CronExpressionParser.parse(value); } catch { return `Invalid cron: "${value}"`; }
  } else if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms <= 0) return `Invalid interval: "${value}"`;
  } else if (type === 'once') {
    if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
      return `Timestamp must be local time without timezone suffix.`;
    }
    if (isNaN(new Date(value).getTime())) return `Invalid timestamp: "${value}"`;
  }
  return null;
}

export function nanoclawExtension(ctx: ExtensionCtx) {
  return (pi: ExtensionAPI) => {
    pi.registerTool(defineTool({
      name: 'send_message',
      label: 'send_message',
      description: "Send a message to the user/group immediately. Use for progress updates or multiple messages.",
      parameters: Type.Object({
        text: Type.String({ description: 'Message text' }),
        sender: Type.Optional(Type.String({ description: 'Optional role/identity name (e.g. "Researcher")' })),
      }),
      execute: async (_id, p) => {
        await ctx.router.send(ctx.chatJid, p.text, p.sender);
        return okText('Message sent.');
      },
    }));

    pi.registerTool(defineTool({
      name: 'schedule_task',
      label: 'schedule_task',
      description: 'Schedule a recurring or one-time task. See parameters for schedule format.',
      parameters: Type.Object({
        prompt: Type.String(),
        schedule_type: Type.Union([Type.Literal('cron'), Type.Literal('interval'), Type.Literal('once')]),
        schedule_value: Type.String(),
        context_mode: Type.Optional(Type.Union([Type.Literal('group'), Type.Literal('isolated')])),
        target_group_jid: Type.Optional(Type.String()),
        script: Type.Optional(Type.String()),
      }),
      execute: async (_id, p) => {
        const err = validateSchedule(p.schedule_type, p.schedule_value);
        if (err) return errText(err);
        const targetJid = ctx.isMain && p.target_group_jid ? p.target_group_jid : ctx.chatJid;
        const { taskId } = ctx.taskScheduler.schedule({
          prompt: p.prompt,
          scheduleType: p.schedule_type,
          scheduleValue: p.schedule_value,
          contextMode: p.context_mode ?? 'group',
          targetJid,
          createdBy: ctx.groupFolder,
          script: p.script,
        });
        return okText(`Task ${taskId} scheduled: ${p.schedule_type} - ${p.schedule_value}`);
      },
    }));

    pi.registerTool(defineTool({
      name: 'list_tasks',
      label: 'list_tasks',
      description: "List scheduled tasks (main: all, others: own only).",
      parameters: Type.Object({}),
      execute: async () => {
        const tasks = ctx.taskScheduler.list({ groupFolder: ctx.groupFolder, isMain: ctx.isMain });
        if (tasks.length === 0) return okText('No scheduled tasks found.');
        const lines = tasks.map((t) =>
          `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.scheduleType}: ${t.scheduleValue}) - ${t.status}, next: ${t.nextRun ?? 'N/A'}`,
        );
        return okText(`Scheduled tasks:\n${lines.join('\n')}`);
      },
    }));

    for (const op of ['pause_task', 'resume_task', 'cancel_task'] as const) {
      pi.registerTool(defineTool({
        name: op,
        label: op,
        description: `${op.replace('_task','')} a scheduled task.`,
        parameters: Type.Object({ task_id: Type.String() }),
        execute: async (_id, p) => {
          const fn = op === 'pause_task' ? ctx.taskScheduler.pause
                   : op === 'resume_task' ? ctx.taskScheduler.resume
                   : ctx.taskScheduler.cancel;
          fn(p.task_id, { groupFolder: ctx.groupFolder, isMain: ctx.isMain });
          return okText(`Task ${p.task_id} ${op.replace('_task','')} requested.`);
        },
      }));
    }

    pi.registerTool(defineTool({
      name: 'update_task',
      label: 'update_task',
      description: 'Update fields on an existing task. Omitted fields stay the same.',
      parameters: Type.Object({
        task_id: Type.String(),
        prompt: Type.Optional(Type.String()),
        schedule_type: Type.Optional(Type.Union([Type.Literal('cron'), Type.Literal('interval'), Type.Literal('once')])),
        schedule_value: Type.Optional(Type.String()),
        script: Type.Optional(Type.String()),
      }),
      execute: async (_id, p) => {
        if (p.schedule_type && p.schedule_value) {
          const err = validateSchedule(p.schedule_type, p.schedule_value);
          if (err) return errText(err);
        }
        ctx.taskScheduler.update({
          taskId: p.task_id,
          scope: { groupFolder: ctx.groupFolder, isMain: ctx.isMain },
          prompt: p.prompt,
          scheduleType: p.schedule_type,
          scheduleValue: p.schedule_value,
          script: p.script,
        });
        return okText(`Task ${p.task_id} update requested.`);
      },
    }));

    pi.registerTool(defineTool({
      name: 'register_group',
      label: 'register_group',
      description: 'Register a new chat/group (main group only).',
      parameters: Type.Object({
        jid: Type.String(),
        name: Type.String(),
        folder: Type.String(),
        trigger: Type.String(),
        requiresTrigger: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, p) => {
        if (!ctx.isMain) return errText('Only the main group can register new groups.');
        ctx.groupRegistry.register({
          jid: p.jid,
          name: p.name,
          folder: p.folder,
          trigger: p.trigger,
          requiresTrigger: p.requiresTrigger ?? false,
        });
        return okText(`Group "${p.name}" registered.`);
      },
    }));
  };
}
```

**Step 4: 跑测试**

Run: `npx vitest run src/agent/extension.test.ts`
Expected: 4 PASS。

**Step 5: Commit**

```bash
git add src/agent/extension.ts src/agent/extension.test.ts
git commit -m "feat(agent): add nanoclaw pi extension with 8 IPC tools"
```

---

## Task 6: SessionPool（lazy + idle TTL）

**Files:**
- Create: `src/agent/session-pool.ts`
- Test: `src/agent/session-pool.test.ts`

**Step 1: failing test（用 fake timers + mock factory）**

```ts
// src/agent/session-pool.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionPool } from './session-pool.js';

interface FakeSession { dispose: () => Promise<void>; id: string; }

describe('SessionPool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates session lazily and reuses on second hit', async () => {
    const factory = vi.fn(async (key: string): Promise<FakeSession> => ({
      id: key,
      dispose: vi.fn().mockResolvedValue(undefined),
    }));
    const pool = new SessionPool<FakeSession>({ factory, idleMs: 1000 });
    const s1 = await pool.getOrCreate('a');
    const s2 = await pool.getOrCreate('a');
    expect(s1).toBe(s2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('disposes session after idle TTL', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 1000,
    });
    await pool.getOrCreate('a');
    await vi.advanceTimersByTimeAsync(1500);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await pool.getOrCreate('a')).toBeDefined(); // 重建
  });

  it('disposeAll clears every entry', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 60000,
    });
    await pool.getOrCreate('a');
    await pool.getOrCreate('b');
    await pool.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('getOrCreate resets idle timer (touch)', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 1000,
    });
    await pool.getOrCreate('a');
    await vi.advanceTimersByTimeAsync(800);
    await pool.getOrCreate('a'); // touch
    await vi.advanceTimersByTimeAsync(800);
    expect(dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: 跑确认 fail**

Run: `npx vitest run src/agent/session-pool.test.ts`
Expected: FAIL。

**Step 3: 实现**

```ts
// src/agent/session-pool.ts
export interface DisposableSession {
  dispose: () => Promise<void> | void;
}

export interface SessionPoolOptions<T> {
  factory: (key: string) => Promise<T>;
  idleMs: number;
}

interface Entry<T> {
  promise: Promise<T>;
  timer: NodeJS.Timeout;
}

export class SessionPool<T extends DisposableSession> {
  private entries = new Map<string, Entry<T>>();
  constructor(private opts: SessionPoolOptions<T>) {}

  async getOrCreate(key: string): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing.promise;
    }
    const promise = this.opts.factory(key);
    const timer = setTimeout(() => void this.evict(key), this.opts.idleMs);
    const entry: Entry<T> = { promise, timer };
    this.entries.set(key, entry);
    try {
      await promise;
    } catch (err) {
      clearTimeout(timer);
      this.entries.delete(key);
      throw err;
    }
    return promise;
  }

  private touch(key: string, entry: Entry<T>): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.evict(key), this.opts.idleMs);
  }

  private async evict(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    try {
      const session = await entry.promise;
      await session.dispose();
    } catch {
      /* swallow disposal errors */
    }
  }

  async disposeAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((k) => this.evict(k)));
  }

  size(): number {
    return this.entries.size;
  }
}
```

**Step 4: 跑测试**

Run: `npx vitest run src/agent/session-pool.test.ts`
Expected: 4 PASS。

**Step 5: Commit**

```bash
git add src/agent/session-pool.ts src/agent/session-pool.test.ts
git commit -m "feat(agent): add SessionPool with lazy create + idle TTL eviction"
```

---

## Task 7: `src/agent/run.ts` —— 主入口（创建 session + 事件桥）

**Files:**
- Create: `src/agent/run.ts`

**Step 1: 实现（这一步无独立 unit test，靠后续集成 smoke 验证）**

```ts
// src/agent/run.ts
import path from 'path';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  type AgentSession,
} from '@mariozechner/pi-coding-agent';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { SessionPool, type DisposableSession } from './session-pool.js';
import { loadSandboxConfig } from './sandbox-config.js';
import { nanoclawExtension } from './extension.js';
import type { ExtensionCtx } from './types.js';

const IDLE_MS = parseInt(process.env.NANOCLAW_AGENT_IDLE_TTL_MS ?? '600000', 10);
const log = (m: string) => logger.log(`[agent] ${m}`);

interface PooledSession extends DisposableSession {
  session: AgentSession;
  routerBuffer: string;
  flushTimer?: NodeJS.Timeout;
}

let sandboxReady = false;
async function ensureSandbox(groupCwd: string): Promise<void> {
  if (sandboxReady) return;
  const cfg = loadSandboxConfig(groupCwd);
  if (!cfg.enabled) {
    log('sandbox disabled by config');
    sandboxReady = true;
    return;
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    log(`sandbox unsupported on ${process.platform}; bash will run unsandboxed`);
    sandboxReady = true;
    return;
  }
  await SandboxManager.initialize({ network: cfg.network, filesystem: cfg.filesystem });
  log('sandbox initialized');
  sandboxReady = true;
}

function buildCtx(args: {
  groupFolder: string; chatJid: string; isMain: boolean;
  ports: Pick<ExtensionCtx, 'router' | 'taskScheduler' | 'groupRegistry' | 'channels'>;
}): ExtensionCtx {
  return { ...args.ports, groupFolder: args.groupFolder, chatJid: args.chatJid, isMain: args.isMain };
}

async function buildSession(ctx: ExtensionCtx): Promise<PooledSession> {
  const groupCwd = path.join(GROUPS_DIR, ctx.groupFolder);
  await ensureSandbox(groupCwd);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const loader = new DefaultResourceLoader({
    cwd: groupCwd,
    extensionFactories: [nanoclawExtension(ctx)],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: groupCwd,
    sessionManager: SessionManager.continueRecent(groupCwd),
    resourceLoader: loader,
    authStorage,
    modelRegistry,
  });

  const pooled: PooledSession = {
    session,
    routerBuffer: '',
    dispose: async () => {
      if (pooled.flushTimer) clearTimeout(pooled.flushTimer);
      await flushBuffer(pooled, ctx);
      session.dispose();
    },
  };

  session.subscribe((event) => {
    if (event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta') {
      pooled.routerBuffer += event.assistantMessageEvent.delta;
    } else if (event.type === 'turn_end' || event.type === 'agent_end') {
      void flushBuffer(pooled, ctx);
    }
  });

  return pooled;
}

async function flushBuffer(p: PooledSession, ctx: ExtensionCtx): Promise<void> {
  const text = p.routerBuffer.trim();
  p.routerBuffer = '';
  if (!text) return;
  try {
    await ctx.router.send(ctx.chatJid, text);
  } catch (err) {
    log(`router.send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let pool: SessionPool<PooledSession> | null = null;
let sharedPorts: ExtensionCtx | null = null;

export function configureAgent(ports: Pick<ExtensionCtx, 'router' | 'taskScheduler' | 'groupRegistry' | 'channels'>): void {
  sharedPorts = { ...ports, groupFolder: '', chatJid: '', isMain: false } as ExtensionCtx;
  pool = new SessionPool<PooledSession>({
    factory: async (key) => {
      const [groupFolder, chatJid, mainFlag] = key.split('|');
      const ctx = buildCtx({
        groupFolder, chatJid, isMain: mainFlag === '1',
        ports: { router: ports.router, taskScheduler: ports.taskScheduler, groupRegistry: ports.groupRegistry, channels: ports.channels },
      });
      return buildSession(ctx);
    },
    idleMs: IDLE_MS,
  });
}

export async function handleMessage(args: {
  groupFolder: string; chatJid: string; isMain: boolean; text: string;
}): Promise<void> {
  if (!pool || !sharedPorts) throw new Error('agent not configured; call configureAgent first');
  const key = `${args.groupFolder}|${args.chatJid}|${args.isMain ? '1' : '0'}`;
  const pooled = await pool.getOrCreate(key);
  if (pooled.session.isStreaming) {
    await pooled.session.steer(args.text);
  } else {
    await pooled.session.prompt(args.text);
  }
}

export async function shutdownAgent(): Promise<void> {
  if (pool) await pool.disposeAll();
  pool = null;
}
```

**Step 2: 类型检查**

Run: `npx tsc -p . --noEmit`
Expected: 通过（如有类型不匹配，按 pi-mono 实际导出名修；先用 `tsserver` 提示修齐）。

**Step 3: Commit**

```bash
git add src/agent/run.ts
git commit -m "feat(agent): add run.ts with handleMessage + sandbox bootstrap"
```

---

## Task 8: TaskScheduler port 适配

**Files:**
- Modify: `src/task-scheduler.ts`

**Step 1: 阅读现有结构**

Run: `npx tsc --noEmit -p .` 之前先看：
```bash
sed -n '1,40p' src/task-scheduler.ts
```

**Step 2: 暴露 port 形态的 API**

在 `src/task-scheduler.ts` 末尾追加（保留原有 internal API 给 main loop 用）：

```ts
import type {
  TaskSchedulerPort,
  ScheduleTaskRequest,
  UpdateTaskRequest,
  ScheduledTaskSummary,
} from './agent/types.js';

export function makeTaskSchedulerPort(): TaskSchedulerPort {
  return {
    schedule: (req: ScheduleTaskRequest) => {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // 调用现有 scheduleTaskInternal/registerTask（按当前文件实际导出名调整）
      registerScheduledTask({
        id: taskId,
        prompt: req.prompt,
        scheduleType: req.scheduleType,
        scheduleValue: req.scheduleValue,
        contextMode: req.contextMode,
        targetJid: req.targetJid,
        groupFolder: req.createdBy,
        script: req.script,
      });
      return { taskId };
    },
    list: ({ groupFolder, isMain }) => listScheduledTasks(isMain ? undefined : groupFolder) as ScheduledTaskSummary[],
    pause: (id, scope) => pauseScheduledTask(id, scope),
    resume: (id, scope) => resumeScheduledTask(id, scope),
    cancel: (id, scope) => cancelScheduledTask(id, scope),
    update: (req: UpdateTaskRequest) => updateScheduledTask(req),
  };
}
```

> ⚠️ 上面的 `registerScheduledTask` / `listScheduledTasks` / 等是占位名 —— 写代码时打开 `src/task-scheduler.ts` 找到实际函数（当前实现是文件 IPC 驱动，可能要新增内部函数把 IPC handler 的 body 抽出来共享）。**目标：让 port 直接调内部函数，绕过 IPC 文件**。

**Step 3: 类型检查**

Run: `npx tsc -p . --noEmit`
Expected: 通过。

**Step 4: 改 task-scheduler 自身的执行路径**

定位现有"task 触发时启动容器"那段代码（搜 `runContainerAgent`）：

```bash
grep -n "runContainerAgent\|containerRunner" src/task-scheduler.ts
```

把那段替换为 in-process 临时 session：

```ts
import {
  AuthStorage, ModelRegistry, SessionManager,
  DefaultResourceLoader, createAgentSession,
} from '@mariozechner/pi-coding-agent';
import { nanoclawExtension } from './agent/extension.js';
// ... 复用 ports，从模块顶部接收

async function runScheduledTask(task: StoredTask, ports: ExtensionCtxPorts): Promise<void> {
  const groupCwd = path.join(GROUPS_DIR, task.groupFolder);
  const authStorage = AuthStorage.create();
  const ctx: ExtensionCtx = {
    router: ports.router,
    taskScheduler: ports.taskScheduler,
    groupRegistry: ports.groupRegistry,
    channels: ports.channels,
    groupFolder: task.groupFolder,
    chatJid: task.targetJid,
    isMain: false,
  };
  const loader = new DefaultResourceLoader({
    cwd: groupCwd,
    extensionFactories: [nanoclawExtension(ctx)],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: groupCwd,
    sessionManager: task.contextMode === 'group'
      ? SessionManager.continueRecent(groupCwd)
      : SessionManager.inMemory(),
    resourceLoader: loader,
    authStorage,
    modelRegistry: ModelRegistry.create(authStorage),
  });
  try {
    await session.prompt(task.prompt);
  } finally {
    session.dispose();
  }
}
```

修改 `startSchedulerLoop` 签名接收 `ports`，传给 `runScheduledTask`。

**Step 5: 跑现有测试**

Run: `npx vitest run src/task-scheduler.test.ts`
Expected: 现有测试可能因 API 改名失败 —— 修测试或更新 mock。务必让本套测试 PASS。

**Step 6: Commit**

```bash
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "refactor(task-scheduler): expose port + run tasks via in-process pi session"
```

---

## Task 9: 主进程串接 —— 替换容器调度

**Files:**
- Modify: `src/index.ts`

**Step 1: 拿出 router/groupRegistry 的 port 实现**

在 `src/index.ts` 顶部附近、初始化 channels 之后，定义：

```ts
import { configureAgent, handleMessage, shutdownAgent } from './agent/run.js';
import type { RouterPort, GroupRegistryPort } from './agent/types.js';
import { makeTaskSchedulerPort } from './task-scheduler.js';
import { routeOutbound } from './router.js';

const routerPort: RouterPort = {
  send: (jid, text, sender) => routeOutbound(channels, jid, text /*, sender 后续若 router 支持再传 */),
};

const groupRegistryPort: GroupRegistryPort = {
  register: (req) => {
    setRegisteredGroup({
      jid: req.jid, name: req.name, folder: req.folder,
      trigger: req.trigger, requiresTrigger: req.requiresTrigger,
    });
    registeredGroups[req.jid] = {
      jid: req.jid, name: req.name, folder: req.folder,
      trigger: req.trigger, requiresTrigger: req.requiresTrigger,
    };
  },
};

const taskSchedulerPort = makeTaskSchedulerPort();
configureAgent({
  router: routerPort,
  taskScheduler: taskSchedulerPort,
  groupRegistry: groupRegistryPort,
  channels,
});
```

**Step 2: 替换 message loop 里的 `runContainerAgent` 调用**

```bash
grep -n "runContainerAgent" src/index.ts
```

把每处调用替换成：

```ts
await handleMessage({
  groupFolder,
  chatJid: jid,
  isMain: jid === MAIN_JID,
  text: formattedMessages,
});
```

删除 `ContainerOutput` 处理 / sessionId 持久化 / `runContainerAgent` 周边的 try/catch（pi 自管 session）。删除 `writeGroupsSnapshot` / `writeTasksSnapshot` 调用（IPC 文件不再需要）。

**Step 3: 关闭流程**

在 SIGTERM/SIGINT handler 里追加 `await shutdownAgent();`。

**Step 4: 类型检查**

Run: `npx tsc -p . --noEmit`
Expected: 一堆未使用 import 报错 —— 删除 `runContainerAgent` / `startIpcWatcher` / `writeGroupsSnapshot` 等的 import；其他错误按提示修齐。

**Step 5: 跑全量测试**

Run: `npx vitest run`
Expected: 容器相关 test 仍存在（下个 task 删），其余 PASS。如有失败排查。

**Step 6: Commit**

```bash
git add src/index.ts
git commit -m "refactor(index): replace container runner with in-process pi agent"
```

---

## Task 10: 删除容器层（大批量）

**Files (delete):**
- `container/` 整个目录
- `src/container-runner.ts` + `.test.ts`
- `src/container-runtime.ts` + `.test.ts`
- `src/ipc.ts` + `.test.ts`
- `src/credential-proxy.ts` + `.test.ts`（OneCLI proxy 不再需要；若仍被其他模块引用则保留并标 deprecated 注释 —— **先 grep 确认**）
- `src/mount-security.ts` + `.test.ts`

**Step 1: 删除前清点引用**

```bash
grep -rln "container-runner\|container-runtime\|from './ipc'\|credential-proxy\|mount-security" src/ scripts/ 2>/dev/null
```

记录每个引用点。

**Step 2: 删除文件**

```bash
git rm -r container/
git rm src/container-runner.ts src/container-runner.test.ts \
       src/container-runtime.ts src/container-runtime.test.ts \
       src/ipc.ts src/ipc.test.ts \
       src/ipc-auth.test.ts \
       src/mount-security.ts src/mount-security.test.ts
# credential-proxy 仅当 grep 确认无外部引用时删
```

**Step 3: 移除残留 import**

```bash
npx tsc -p . --noEmit 2>&1 | head -30
```

针对每条报错，去 `src/index.ts` 等处删除对应 import / 调用。

**Step 4: 跑测试**

Run: `npx vitest run`
Expected: 全部 PASS（或仅有"待删 OneCLI 测试"被跳过）。

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove container layer (container-runner, ipc, mount-security)"
```

---

## Task 11: 删除 NANOCLAW_LLM_PROVIDER + provider 切换

**Files:**
- Modify: `src/config.ts`、`src/env.ts`（如有）
- Delete: 任何 `providers.ts` 残留（`container/agent-runner/src/providers.ts` 已随 container/ 删除）

**Step 1: grep 残留**

```bash
grep -rn "NANOCLAW_LLM_PROVIDER\|NANOCLAW_LLM_API_KEY\|NANOCLAW_LLM_MODEL\|NANOCLAW_LLM_BASE_URL\|CODEANY_\|GEMINI_API_KEY" src/ scripts/ docs/ README.md CLAUDE.md 2>/dev/null
```

**Step 2: 删除/替换**

- `src/config.ts` 中的 provider 选择逻辑：删。
- 文档中的"`NANOCLAW_LLM_PROVIDER` 默认 openclaude"段：替换为"通过 pi 标准凭证（环境变量或 `~/.pi/agent/auth.json`）配置 LLM"。
- `.env.example` 删除 `NANOCLAW_LLM_*`，加 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`（用 pi 标准）。

**Step 3: 类型检查 + 测试**

```bash
npx tsc -p . --noEmit
npx vitest run
```

Expected: 全部通过。

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove NANOCLAW_LLM_PROVIDER (pi handles credential resolution)"
```

---

## Task 12: 更新 CLAUDE.md / README

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`（如涉及 provider 或容器内容）

**Step 1: CLAUDE.md 改写**

替换现有"Secrets / Credentials / Proxy (OneCLI)"和"Key Files"段：

- "Key Files" 表里删掉 `container-runner.ts`、`ipc.ts`，加 `src/agent/run.ts`（"In-process pi-coding-agent runtime"）、`src/agent/extension.ts`（"NanoClaw IPC tools as pi extension"）、`src/agent/session-pool.ts`（"per-group AgentSession pool"）。
- 删 OneCLI 与 `NANOCLAW_LLM_PROVIDER` 段，新增简短一段：

```markdown
## LLM Provider

NanoClaw runs `@mariozechner/pi-coding-agent` in-process. Configure your provider via environment variables (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or `~/.pi/agent/auth.json`. See pi-mono docs (https://github.com/badlogic/pi-mono) for the full provider list.

Bash commands run inside an OS-level sandbox (`sandbox-exec` on macOS, `bubblewrap` on Linux) configured by `config/sandbox.default.json` and per-group overrides at `groups/<group>/.pi/sandbox.json`.
```

- 删容器构建命令段（`./container/build.sh` 等）。

**Step 2: README.md**

按同思路更新；任何"运行容器"的描述改为"主进程内运行"。

**Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md and README for pi-mono host-side architecture"
```

---

## Task 13: 删除/归档现已无效的 skills

**Files:**
- Audit: `.claude/skills/add-*.json`、`add-*` skill 目录、`/init-onecli`、`/convert-to-apple-container`、`/use-native-credential-proxy`

**Step 1: 列出受影响 skill**

```bash
ls .claude/skills/ | grep -E "onecli|container|credential-proxy|whisper|openclaude" 2>/dev/null
```

**Step 2: 标 deprecated 或删除**

- `init-onecli`、`convert-to-apple-container`、`use-native-credential-proxy`：删除整个 skill 目录（不再适用）。
- 其他 skill 中如引用容器构建：搜 `./container/build.sh` 并改写为"无需重建容器"。

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove skills made obsolete by pi-mono migration"
```

---

## Task 14: 手动 smoke 测试

**Step 1: 配置凭证**

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
```

**Step 2: 启动**

```bash
npm run build && npm run dev
```

监控 stdout：应看到 `[agent] sandbox initialized`，且无 container 相关 log。

**Step 3: 通过任一 channel 发消息**

发"列一下当前目录"。期望：
- agent 调 `bash`/`ls` 工具。
- 在另一终端 `ps -ef | grep sandbox-exec`（macOS）能看到包了 sandbox 的子进程。
- channel 收到 LLM 回复。

**Step 4: 验证 IPC 工具**

发 "schedule a task to print hello every minute"。验证：
- `taskScheduler` 收到 schedule 调用。
- 一分钟后看到 task 真的执行（router 收到 "hello"）。

**Step 5: 验证 session 复用**

连发两条消息，主进程 log 中第二条不应触发 "agent factory" 重建（pool 命中）。

**Step 6: 验证 idle eviction**

把 `NANOCLAW_AGENT_IDLE_TTL_MS=5000` 启动，发一条消息后等 ~10s，再发一条 —— 应观察到第二条触发新 session 创建。

**Step 7: 不 commit（仅本地验证）**

如发现问题：返回前面任务修复。

---

## Task 15: 最终类型检查 + 全测试

**Step 1: 类型与测试**

```bash
npx tsc -p . --noEmit
npx vitest run
npm run lint  # 或 format:check
```

Expected: 全绿。

**Step 2: Commit（如有 lint 自动修复）**

```bash
git add -A
git commit --allow-empty -m "chore: pi-mono migration complete"
```

---

## 检查清单（最终）

- [ ] `container/` 目录已删除
- [ ] `src/container-runner.ts` / `src/ipc.ts` / `src/ipc-mcp-stdio.ts` 已删除
- [ ] `NANOCLAW_LLM_PROVIDER` 在仓库内 0 处引用
- [ ] `src/agent/{run,extension,session-pool,sandbox-config,types}.ts` 全部存在并通过测试
- [ ] CLAUDE.md / README.md 已更新
- [ ] 手动 smoke 通过：消息流 / IPC 工具 / sandbox / session 复用 / idle eviction
- [ ] `npx tsc -p . --noEmit` 全绿
- [ ] `npx vitest run` 全绿
