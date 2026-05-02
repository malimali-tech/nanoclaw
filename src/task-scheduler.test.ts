import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pi-coding-agent so runTask doesn't try to spin up a real LLM session
// when the scheduler loop fires a due task during tests.
vi.mock('@mariozechner/pi-coding-agent', () => {
  class FakeSession {
    subscribe(_cb: (event: unknown) => void): () => void {
      return () => {};
    }
    async prompt(_text: string): Promise<void> {
      return;
    }
    dispose(): void {
      return;
    }
  }
  return {
    AuthStorage: { create: () => ({}) },
    ModelRegistry: { create: (_a: unknown) => ({}) },
    SessionManager: {
      continueRecent: (_cwd: string) => ({}),
      inMemory: () => ({}),
    },
    DefaultResourceLoader: class {
      constructor(_args: unknown) {}
      async reload(): Promise<void> {
        return;
      }
    },
    getAgentDir: () => '/tmp/agent-dir',
    createAgentSession: async () => ({ session: new FakeSession() }),
  };
});

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  makeTaskSchedulerPort,
  startSchedulerLoop,
  type SchedulerDependencies,
} from './task-scheduler.js';

const noopPorts: SchedulerDependencies['ports'] = {
  router: {
    send: async () => {},
    openStream: async () => {
      throw new Error('not used in scheduler tests');
    },
  },
  taskScheduler: {
    schedule: () => ({ taskId: 'x' }),
    list: () => [],
    pause: () => {},
    resume: () => {},
    cancel: () => {},
    update: () => {},
  },
};

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    startSchedulerLoop({
      registeredGroups: () => ({}),
      ports: noopPorts,
    });

    // Let the scheduler loop tick and any microtasks resolve.
    await vi.advanceTimersByTimeAsync(10);
    await vi.runOnlyPendingTimersAsync();

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

describe('makeTaskSchedulerPort', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('schedule creates a task with computed next_run and active status', () => {
    const port = makeTaskSchedulerPort();
    const before = Date.now();
    const { taskId } = port.schedule({
      prompt: 'do thing',
      scheduleType: 'interval',
      scheduleValue: '60000',
      contextMode: 'isolated',
      targetJid: 'g@g.us',
      createdBy: 'mygroup',
    });

    const t = getTaskById(taskId);
    expect(t).toBeDefined();
    expect(t!.status).toBe('active');
    expect(t!.group_folder).toBe('mygroup');
    expect(t!.chat_jid).toBe('g@g.us');
    expect(t!.prompt).toBe('do thing');
    const next = new Date(t!.next_run!).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 60000 - 50);
  });

  it('list filters by group folder for non-main scopes', () => {
    const port = makeTaskSchedulerPort();
    port.schedule({
      prompt: 'a',
      scheduleType: 'interval',
      scheduleValue: '60000',
      contextMode: 'isolated',
      targetJid: 'g1@g.us',
      createdBy: 'group-a',
    });
    port.schedule({
      prompt: 'b',
      scheduleType: 'interval',
      scheduleValue: '60000',
      contextMode: 'isolated',
      targetJid: 'g2@g.us',
      createdBy: 'group-b',
    });

    const allFromMain = port.list({ groupFolder: 'group-a', isMain: true });
    const ownOnly = port.list({ groupFolder: 'group-a', isMain: false });
    expect(allFromMain).toHaveLength(2);
    expect(ownOnly).toHaveLength(1);
    expect(ownOnly[0].groupFolder).toBe('group-a');
  });

  it('pause / resume / cancel flow', () => {
    const port = makeTaskSchedulerPort();
    const { taskId } = port.schedule({
      prompt: 'p',
      scheduleType: 'interval',
      scheduleValue: '60000',
      contextMode: 'isolated',
      targetJid: 'g@g.us',
      createdBy: 'g',
    });
    const scope = { groupFolder: 'g', isMain: false };

    port.pause(taskId, scope);
    expect(getTaskById(taskId)?.status).toBe('paused');

    port.resume(taskId, scope);
    expect(getTaskById(taskId)?.status).toBe('active');

    port.cancel(taskId, scope);
    expect(getTaskById(taskId)).toBeUndefined();
  });

  it('update recomputes next_run when schedule_value changes', () => {
    const port = makeTaskSchedulerPort();
    const { taskId } = port.schedule({
      prompt: 'p',
      scheduleType: 'interval',
      scheduleValue: '60000',
      contextMode: 'isolated',
      targetJid: 'g@g.us',
      createdBy: 'g',
    });
    const oldNext = new Date(getTaskById(taskId)!.next_run!).getTime();

    port.update({
      taskId,
      scope: { groupFolder: 'g', isMain: false },
      scheduleValue: '600000', // 10x larger
    });

    const newNext = new Date(getTaskById(taskId)!.next_run!).getTime();
    expect(newNext).toBeGreaterThan(oldNext);
    expect(getTaskById(taskId)!.schedule_value).toBe('600000');
  });
});
