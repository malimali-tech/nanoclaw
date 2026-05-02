import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('./run.js', () => ({
  newChatSession: vi.fn(async () => {}),
  resumeChatSession: vi.fn(async () => {}),
  listChatSessions: vi.fn(async () => []),
  getChatSessionStats: vi.fn(async () => ({
    totalMessages: 12,
    inputTokens: 800,
    outputTokens: 200,
    cacheReadTokens: 4000,
    cacheWriteTokens: 0,
    totalTokens: 5000,
    cost: 0.0123,
    contextWindow: 200000,
    contextPercent: 2.5,
    modelProvider: 'anthropic',
    modelId: 'claude-opus-4-7',
    thinkingLevel: 'medium',
  })),
}));

import {
  getChatSessionStats,
  listChatSessions,
  newChatSession,
  resumeChatSession,
} from './run.js';
import { nanoclawExtension } from './extension.js';
import * as toolRuntime from './tool-runtime.js';
import type { ChatToolBindings } from './tool-runtime.js';
import type { ExtensionCtx } from './types.js';

const NO_BINDINGS: ChatToolBindings = {
  bash: null,
  read: null,
  write: null,
  edit: null,
  grep: null,
  find: null,
  ls: null,
};

function makeCtx(over: Partial<ExtensionCtx> = {}): ExtensionCtx {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    taskScheduler: {
      schedule: vi.fn().mockReturnValue({ taskId: 'task-test' }),
      list: vi.fn().mockReturnValue([]),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      update: vi.fn(),
    },
    groupFolder: 'wa_test',
    chatJid: 'jid@s',
    isMain: false,
    ...over,
  };
}

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

interface RegisteredCommand {
  name: string;
  description?: string;
  handler: (args: string, piCtx: any) => Promise<void>;
}

function makePi() {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  return {
    pi: {
      registerTool: (t: RegisteredTool) => tools.push(t),
      registerCommand: (
        name: string,
        opts: { description?: string; handler: any },
      ) => commands.push({ name, ...opts }),
      on: vi.fn(),
      // /help iterates pi.getCommands(); we synthesize on demand from
      // what's been registered through this fake.
      getCommands: () =>
        commands.map((c) => ({
          name: c.name,
          description: c.description,
          source: 'extension',
          sourceInfo: {
            path: 'test',
            source: 'nanoclaw',
            scope: 'user',
            origin: 'package',
          },
        })),
    } as any,
    tools,
    commands,
  };
}

describe('nanoclawExtension', () => {
  let bindingsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bindingsSpy = vi.spyOn(toolRuntime, 'getChatToolBindings');
    bindingsSpy.mockReturnValue(NO_BINDINGS);
  });

  afterEach(() => {
    bindingsSpy.mockRestore();
  });

  it('does not register tool overrides when bindings are all null (off mode)', () => {
    const { pi, tools } = makePi();
    nanoclawExtension(makeCtx())(pi);
    for (const name of [
      'bash',
      'read',
      'write',
      'edit',
      'grep',
      'find',
      'ls',
    ]) {
      expect(tools.find((t) => t.name === name)).toBeUndefined();
    }
    expect(pi.on).not.toHaveBeenCalledWith('user_bash', expect.anything());
  });

  it('registers bash + user_bash hook when bash binding is provided (sandbox-exec mode)', () => {
    bindingsSpy.mockReturnValue({
      ...NO_BINDINGS,
      bash: { exec: vi.fn() } as any,
    });
    const { pi, tools } = makePi();
    nanoclawExtension(makeCtx())(pi);
    expect(tools.find((t) => t.name === 'bash')).toBeDefined();
    expect(pi.on).toHaveBeenCalledWith('user_bash', expect.any(Function));
  });

  it('registers all 7 tool overrides when full bindings are provided (docker mode)', () => {
    bindingsSpy.mockReturnValue({
      bash: { exec: vi.fn() } as any,
      read: { readFile: vi.fn(), access: vi.fn() } as any,
      write: { writeFile: vi.fn(), mkdir: vi.fn() } as any,
      edit: { readFile: vi.fn(), writeFile: vi.fn(), access: vi.fn() } as any,
      grep: { isDirectory: vi.fn(), readFile: vi.fn() } as any,
      find: { exists: vi.fn(), glob: vi.fn() } as any,
      ls: { exists: vi.fn(), stat: vi.fn(), readdir: vi.fn() } as any,
    });
    const { pi, tools } = makePi();
    nanoclawExtension(makeCtx())(pi);
    for (const name of [
      'bash',
      'read',
      'write',
      'edit',
      'grep',
      'find',
      'ls',
    ]) {
      expect(tools.find((t) => t.name === name)).toBeDefined();
    }
    expect(pi.on).toHaveBeenCalledWith('user_bash', expect.any(Function));
  });

  it('does not register a send_message tool (deprecated; agent text streams via text_delta)', () => {
    const { pi, tools } = makePi();
    nanoclawExtension(makeCtx())(pi);
    expect(tools.find((t) => t.name === 'send_message')).toBeUndefined();
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

  it('does not register a register_group tool (auto-registration via channel discovery handles new chats)', () => {
    const { pi, tools } = makePi();
    nanoclawExtension(makeCtx())(pi);
    expect(tools.find((t) => t.name === 'register_group')).toBeUndefined();
  });

  it('pause_task / cancel_task each invoke only the matching scheduler method', async () => {
    const ctx = makeCtx();
    const { pi, tools } = makePi();
    nanoclawExtension(ctx)(pi);
    const pause = tools.find((t) => t.name === 'pause_task')!;
    const cancel = tools.find((t) => t.name === 'cancel_task')!;
    await pause.execute('id', { task_id: 't1' });
    expect(ctx.taskScheduler.pause).toHaveBeenCalledWith('t1', {
      groupFolder: 'wa_test',
      isMain: false,
    });
    expect(ctx.taskScheduler.resume).not.toHaveBeenCalled();
    expect(ctx.taskScheduler.cancel).not.toHaveBeenCalled();
    await cancel.execute('id', { task_id: 't1' });
    expect(ctx.taskScheduler.cancel).toHaveBeenCalledWith('t1', {
      groupFolder: 'wa_test',
      isMain: false,
    });
    expect(ctx.taskScheduler.resume).not.toHaveBeenCalled();
  });

  it('schedule_task rejects "once" with timezone suffix and does not call scheduler', async () => {
    const ctx = makeCtx();
    const { pi, tools } = makePi();
    nanoclawExtension(ctx)(pi);
    const sched = tools.find((t) => t.name === 'schedule_task')!;
    const res = await sched.execute('id', {
      prompt: 'x',
      schedule_type: 'once',
      schedule_value: '2026-04-29T10:00:00Z',
    });
    expect(JSON.stringify(res)).toMatch(/timezone/i);
    expect(ctx.taskScheduler.schedule).not.toHaveBeenCalled();
  });
});

describe('nanoclawExtension — slash commands', () => {
  let bindingsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bindingsSpy = vi.spyOn(toolRuntime, 'getChatToolBindings');
    bindingsSpy.mockReturnValue(NO_BINDINGS);
    vi.mocked(newChatSession).mockClear();
    vi.mocked(resumeChatSession).mockClear();
    vi.mocked(listChatSessions).mockClear();
    vi.mocked(getChatSessionStats).mockClear();
  });

  afterEach(() => {
    bindingsSpy.mockRestore();
  });

  function bind() {
    const ctx = makeCtx();
    const { pi, commands } = makePi();
    nanoclawExtension(ctx)(pi);
    const byName = new Map(commands.map((c) => [c.name, c]));
    return { ctx, commands, byName, pi };
  }

  it('registers all expected slash commands', () => {
    const { commands } = bind();
    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(['context', 'help', 'new', 'resume']);
  });

  it('/help renders auto-generated list from registered commands', async () => {
    const { ctx, byName } = bind();
    await byName.get('help')!.handler('', {});
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const out = (ctx.send as any).mock.calls[0][0] as string;
    for (const n of ['help', 'new', 'resume', 'context']) {
      expect(out).toContain(`/${n}`);
    }
  });

  it('/new triggers newChatSession and reports back', async () => {
    const { ctx, byName } = bind();
    await byName.get('new')!.handler('', {});
    expect(newChatSession).toHaveBeenCalledWith('wa_test', 'jid@s', false);
    expect((ctx.send as any).mock.calls[0][0]).toContain('新会话');
  });

  it('/resume with no args lists sessions', async () => {
    vi.mocked(listChatSessions).mockResolvedValueOnce([
      {
        path: '/p/aaa.jsonl',
        id: 'aaa',
        cwd: '/cwd',
        name: undefined,
        parentSessionPath: undefined,
        created: new Date('2026-05-02T11:00:00Z'),
        modified: new Date('2026-05-02T11:30:00Z'),
        messageCount: 8,
        firstMessage:
          '<context timezone="Asia/Shanghai" />\n<messages>\n<message sender="andy" time="x">想看下 GitHub PR 状态</message>\n</messages>',
        allMessagesText: '',
      },
    ] as any);
    const { ctx, byName } = bind();
    await byName.get('resume')!.handler('', {});
    expect(resumeChatSession).not.toHaveBeenCalled();
    const out = (ctx.send as any).mock.calls[0][0] as string;
    expect(out).toContain('想看下 GitHub PR 状态');
    expect(out).not.toContain('<message');
  });

  it('/resume N switches to that session', async () => {
    vi.mocked(listChatSessions).mockResolvedValueOnce([
      {
        path: '/p/a.jsonl',
        id: 'a',
        cwd: '/c',
        name: undefined,
        parentSessionPath: undefined,
        created: new Date(),
        modified: new Date(),
        messageCount: 3,
        firstMessage: 'x',
        allMessagesText: '',
      },
      {
        path: '/p/b.jsonl',
        id: 'b',
        cwd: '/c',
        name: undefined,
        parentSessionPath: undefined,
        created: new Date(),
        modified: new Date(),
        messageCount: 5,
        firstMessage: 'y',
        allMessagesText: '',
      },
    ] as any);
    const { byName } = bind();
    await byName.get('resume')!.handler('2', {});
    expect(resumeChatSession).toHaveBeenCalledWith(
      'wa_test',
      'jid@s',
      false,
      '/p/b.jsonl',
    );
  });

  it('/resume rejects out-of-range index', async () => {
    vi.mocked(listChatSessions).mockResolvedValueOnce([] as any);
    const { ctx, byName } = bind();
    await byName.get('resume')!.handler('99', {});
    expect(resumeChatSession).not.toHaveBeenCalled();
    expect((ctx.send as any).mock.calls[0][0]).toContain('暂无');
  });

  it('/context formats stats from getChatSessionStats', async () => {
    const { ctx, byName } = bind();
    await byName.get('context')!.handler('', {});
    const out = (ctx.send as any).mock.calls[0][0] as string;
    expect(out).toContain('anthropic/claude-opus-4-7');
    expect(out).toContain('thinking medium');
    expect(out).toContain('↑800');
    expect(out).toContain('R4.0k');
    expect(out).toContain('2.5%');
    expect(out).toContain('$0.0123');
  });
});
