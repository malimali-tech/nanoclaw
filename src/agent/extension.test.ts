import { describe, it, expect, vi } from 'vitest';
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
