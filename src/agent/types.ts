// src/agent/types.ts
//
// Per-chat extension context. The architecture rule: by the time an
// extension runs, the chat is already known — its channel, jid, group
// folder, and main-ness are bound. `ExtensionCtx` therefore exposes a
// SINGLE output primitive (`send`) rather than a list of channels and
// a search-by-jid pattern, and never leaks the streaming machinery.
//
// Shape (deliberately minimal):
//   - identity:    groupFolder, chatJid, isMain
//   - capability:  send(text, opts?)
//   - services:    taskScheduler, groupRegistry
//
// Streaming output (used by run.ts to render agent-turn output into a
// CardKit card) is INTERNAL to PooledSession and is not part of this
// surface — extensions that need rich output should add a dedicated
// capability rather than reaching into stream internals.

import type { StreamHandle } from '../types.js';

export interface RouterPort {
  /**
   * Send a one-shot message to any chat jid. Implementations are expected
   * to (a) route to the channel that owns the jid and (b) mirror the
   * outbound text into the chat's log.jsonl so cursor recovery can locate
   * it later. Used as the substrate that per-chat `ChatSink`s wrap.
   */
  send(jid: string, text: string, sender?: string): Promise<void>;
  /**
   * Open a streaming card / message handle for the given jid. Used by
   * run.ts to render agent-turn output incrementally. Throws if no
   * channel owns the jid OR the channel doesn't support streaming.
   */
  openStream(jid: string): Promise<StreamHandle>;
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

/**
 * Per-chat output capability. Resolved once at construction (the channel
 * that owns this chat is bound at that point); extensions/handlers should
 * never have to search a channel list themselves.
 */
export interface ChatSink {
  send(text: string, opts?: { sender?: string }): Promise<void>;
}

/** Runtime context injected into the pi extension. One instance per chat. */
export interface ExtensionCtx extends ChatSink {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  taskScheduler: TaskSchedulerPort;
  groupRegistry: GroupRegistryPort;
}

/**
 * Process-wide ports — the substrate hosts (run.ts, task-scheduler.ts)
 * use to construct `ExtensionCtx` per chat. The router carries the
 * outbound + logging behavior; the registries are state ports.
 */
export interface ExtensionPorts {
  router: RouterPort;
  taskScheduler: TaskSchedulerPort;
  groupRegistry: GroupRegistryPort;
}

/** Bind a jid-parameterized router into a per-chat sink. */
export function bindChatSink(router: RouterPort, chatJid: string): ChatSink {
  return {
    send: (text, opts) => router.send(chatJid, text, opts?.sender),
  };
}

/** Build a per-chat `ExtensionCtx` from process-wide ports. */
export function buildExtensionCtx(args: {
  ports: ExtensionPorts;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
}): ExtensionCtx {
  const sink = bindChatSink(args.ports.router, args.chatJid);
  return {
    groupFolder: args.groupFolder,
    chatJid: args.chatJid,
    isMain: args.isMain,
    send: sink.send,
    taskScheduler: args.ports.taskScheduler,
    groupRegistry: args.ports.groupRegistry,
  };
}
