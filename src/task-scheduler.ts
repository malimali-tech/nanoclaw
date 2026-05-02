import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from '@mariozechner/pi-coding-agent';

import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getDueTasks,
  getTaskById,
  getTasksForGroup,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { errMsg, logger } from './logger.js';
import { nanoclawExtension } from './agent/extension.js';
import { resolveModel } from './agent/model.js';
import {
  buildExtensionCtx,
  type ExtensionCtx,
  type ExtensionPorts,
  type ScheduleTaskRequest,
  type ScheduledTaskSummary,
  type TaskSchedulerPort,
  type UpdateTaskRequest,
} from './agent/types.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

/**
 * Compute the very first run time for a brand-new task. Unlike
 * computeNextRun this does not need a prior `next_run` to anchor to.
 */
function computeFirstRun(
  type: 'cron' | 'interval' | 'once',
  value: string,
): string {
  if (type === 'cron') {
    const itr = CronExpressionParser.parse(value, { tz: TIMEZONE });
    const iso = itr.next().toISOString();
    if (!iso) throw new Error(`Cannot compute next run for cron: ${value}`);
    return iso;
  }
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    return new Date(Date.now() + ms).toISOString();
  }
  // once: value is local-time without TZ suffix; new Date() treats as local
  return new Date(value).toISOString();
}

function toSummary(t: ScheduledTask): ScheduledTaskSummary {
  return {
    id: t.id,
    prompt: t.prompt,
    scheduleType: t.schedule_type,
    scheduleValue: t.schedule_value,
    status: t.status,
    nextRun: t.next_run ?? undefined,
    groupFolder: t.group_folder,
  };
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Ports forwarded into the in-process pi agent for scheduled task runs. */
  ports: ExtensionPorts;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = errMsg(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  const isMain = group.isMain === true;

  let result: string | null = null as string | null;
  let error: string | null = null as string | null;
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>['session']
    | null = null;
  let buffer = '';
  let sendChain: Promise<void> = Promise.resolve();

  // Scheduled-task agents don't run inside an interactive turn, so the
  // turn-level streaming card isn't open — text is buffered and flushed
  // as ordinary one-shot messages via the resolved channel sink.
  const ctx: ExtensionCtx = buildExtensionCtx({
    ports: deps.ports,
    groupFolder: task.group_folder,
    chatJid: task.chat_jid,
    isMain,
  });

  const flush = async () => {
    const text = buffer.trim();
    buffer = '';
    if (!text) return;
    try {
      await ctx.send(text);
      // Track the last non-empty output as the task's result.
      result = text;
    } catch (err) {
      logger.error(
        { taskId: task.id, err },
        'channel send failed during scheduled task',
      );
    }
  };

  try {
    const cwd = path.join(GROUPS_DIR, task.group_folder);
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      extensionFactories: [nanoclawExtension(ctx)],
    });
    await loader.reload();

    const model = resolveModel(modelRegistry);
    const created = await createAgentSession({
      cwd,
      sessionManager:
        task.context_mode === 'group'
          ? SessionManager.continueRecent(cwd)
          : SessionManager.inMemory(),
      resourceLoader: loader,
      authStorage,
      modelRegistry,
      model,
    });
    session = created.session;

    session.subscribe((event) => {
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        buffer += event.assistantMessageEvent.delta;
      } else if (event.type === 'turn_end' || event.type === 'agent_end') {
        sendChain = sendChain.then(() => flush());
      }
    });

    await session.prompt(task.prompt);
    // Drain any pending flushes triggered by stream events.
    await sendChain;
    await flush();

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    error = errMsg(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    if (session) {
      try {
        session.dispose();
      } catch (err) {
        logger.warn(
          { taskId: task.id, err },
          'Failed to dispose session for scheduled task',
        );
      }
    }
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        runTask(currentTask, deps).catch((err) => {
          logger.error(
            { taskId: currentTask.id, err },
            'Task execution failed',
          );
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

/**
 * Build a TaskSchedulerPort backed by the host SQLite database.
 * The pi extension calls into this from inside the agent container.
 */
export function makeTaskSchedulerPort(): TaskSchedulerPort {
  return {
    schedule: (req: ScheduleTaskRequest) => {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const nextRun = computeFirstRun(req.scheduleType, req.scheduleValue);
      createTask({
        id: taskId,
        group_folder: req.createdBy,
        chat_jid: req.targetJid,
        prompt: req.prompt,
        script: req.script,
        schedule_type: req.scheduleType,
        schedule_value: req.scheduleValue,
        context_mode: req.contextMode,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      return { taskId };
    },
    list: ({ groupFolder, isMain }) => {
      const all = isMain ? getAllTasks() : getTasksForGroup(groupFolder);
      return all.map(toSummary);
    },
    pause: (taskId, _scope) => updateTask(taskId, { status: 'paused' }),
    resume: (taskId, _scope) => {
      const t = getTaskById(taskId);
      if (!t) return;
      // Recompute next_run on resume so we don't immediately fire a stale task.
      const nextRun = computeFirstRun(t.schedule_type, t.schedule_value);
      updateTask(taskId, { status: 'active', next_run: nextRun });
    },
    cancel: (taskId, _scope) => deleteTask(taskId),
    update: (req: UpdateTaskRequest) => {
      const partial: Parameters<typeof updateTask>[1] = {};
      if (req.prompt !== undefined) partial.prompt = req.prompt;
      if (req.script !== undefined) partial.script = req.script;
      if (req.scheduleType !== undefined)
        partial.schedule_type = req.scheduleType;
      if (req.scheduleValue !== undefined) {
        partial.schedule_value = req.scheduleValue;
        // Recompute next_run since the schedule changed.
        const t = getTaskById(req.taskId);
        if (t) {
          const type = req.scheduleType ?? t.schedule_type;
          partial.next_run = computeFirstRun(type, req.scheduleValue);
        }
      }
      updateTask(req.taskId, partial);
    },
  };
}
