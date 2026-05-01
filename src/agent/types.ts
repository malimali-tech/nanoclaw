// src/agent/types.ts
import type { Channel, StreamHandle } from '../types.js';

export interface RouterPort {
  /** Send a message immediately to the given chat. */
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

/**
 * Mutable per-session reference to the currently open stream handle.
 * Shared between `run.ts` (which opens / finalizes it on the turn boundary)
 * and `extension.ts` tools (which append into it). Null between turns.
 */
export interface StreamRef {
  current: StreamHandle | null;
}

/** Runtime context injected into the pi extension. */
export interface ExtensionCtx {
  router: RouterPort;
  taskScheduler: TaskSchedulerPort;
  groupRegistry: GroupRegistryPort;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  channels: Channel[];
  streamRef: StreamRef;
}
