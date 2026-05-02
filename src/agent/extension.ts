// src/agent/extension.ts
import path from 'path';
import { Type } from 'typebox';
import type {
  ExtensionAPI,
  AgentToolResult,
} from '@mariozechner/pi-coding-agent';
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  defineTool,
} from '@mariozechner/pi-coding-agent';
import { CronExpressionParser } from 'cron-parser';
import { GROUPS_DIR } from '../config.js';
import { getChatToolBindings } from './tool-runtime.js';
import type { ExtensionCtx, ScheduleType } from './types.js';

const okText = (text: string): AgentToolResult<unknown> => ({
  content: [{ type: 'text', text }],
  details: {},
});

const errText = (text: string): AgentToolResult<unknown> => ({
  content: [{ type: 'text', text: `Error: ${text}` }],
  details: { error: text },
});

function validateSchedule(type: ScheduleType, value: string): string | null {
  if (type === 'cron') {
    try {
      CronExpressionParser.parse(value);
    } catch {
      return `Invalid cron: "${value}"`;
    }
  } else if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (isNaN(ms) || ms <= 0) return `Invalid interval: "${value}"`;
  } else if (type === 'once') {
    if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
      return `Timestamp must be local time without timezone suffix.`;
    }
    if (isNaN(new Date(value).getTime()))
      return `Invalid timestamp: "${value}"`;
  }
  return null;
}

export function nanoclawExtension(ctx: ExtensionCtx) {
  return (pi: ExtensionAPI) => {
    // Replace each pi default tool whose runtime mode wants isolation.
    // Docker mode supplies all 7; sandbox-exec supplies only bash; off
    // supplies none. The override is keyed by tool name (pi's defaults
    // register first; ours overwrite by re-registering with the same name).
    const groupCwd = path.join(GROUPS_DIR, ctx.groupFolder);
    const bindings = getChatToolBindings(ctx.groupFolder, ctx.isMain);

    if (bindings.bash) {
      pi.registerTool(createBashTool(groupCwd, { operations: bindings.bash }));
      pi.on('user_bash', () => ({ operations: bindings.bash! }));
    }
    if (bindings.read) {
      pi.registerTool(createReadTool(groupCwd, { operations: bindings.read }));
    }
    if (bindings.write) {
      pi.registerTool(
        createWriteTool(groupCwd, { operations: bindings.write }),
      );
    }
    if (bindings.edit) {
      pi.registerTool(createEditTool(groupCwd, { operations: bindings.edit }));
    }
    if (bindings.grep) {
      pi.registerTool(createGrepTool(groupCwd, { operations: bindings.grep }));
    }
    if (bindings.find) {
      pi.registerTool(createFindTool(groupCwd, { operations: bindings.find }));
    }
    if (bindings.ls) {
      pi.registerTool(createLsTool(groupCwd, { operations: bindings.ls }));
    }

    pi.registerTool(
      defineTool({
        name: 'schedule_task',
        label: 'schedule_task',
        description:
          'Schedule a recurring or one-time task. See parameters for schedule format.',
        parameters: Type.Object({
          prompt: Type.String(),
          schedule_type: Type.Union([
            Type.Literal('cron'),
            Type.Literal('interval'),
            Type.Literal('once'),
          ]),
          schedule_value: Type.String(),
          context_mode: Type.Optional(
            Type.Union([Type.Literal('group'), Type.Literal('isolated')]),
          ),
          target_group_jid: Type.Optional(Type.String()),
          script: Type.Optional(Type.String()),
        }),
        execute: async (_id, p) => {
          const err = validateSchedule(p.schedule_type, p.schedule_value);
          if (err) return errText(err);
          const targetJid =
            ctx.isMain && p.target_group_jid ? p.target_group_jid : ctx.chatJid;
          const { taskId } = ctx.taskScheduler.schedule({
            prompt: p.prompt,
            scheduleType: p.schedule_type,
            scheduleValue: p.schedule_value,
            contextMode: p.context_mode ?? 'group',
            targetJid,
            createdBy: ctx.groupFolder,
            script: p.script,
          });
          return okText(
            `Task ${taskId} scheduled: ${p.schedule_type} - ${p.schedule_value}`,
          );
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: 'list_tasks',
        label: 'list_tasks',
        description: 'List scheduled tasks (main: all, others: own only).',
        parameters: Type.Object({}),
        execute: async () => {
          const tasks = ctx.taskScheduler.list({
            groupFolder: ctx.groupFolder,
            isMain: ctx.isMain,
          });
          if (tasks.length === 0) return okText('No scheduled tasks found.');
          const lines = tasks.map(
            (t) =>
              `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.scheduleType}: ${t.scheduleValue}) - ${t.status}, next: ${t.nextRun ?? 'N/A'}`,
          );
          return okText(`Scheduled tasks:\n${lines.join('\n')}`);
        },
      }),
    );

    for (const op of ['pause_task', 'resume_task', 'cancel_task'] as const) {
      pi.registerTool(
        defineTool({
          name: op,
          label: op,
          description: `${op.replace('_task', '')} a scheduled task.`,
          parameters: Type.Object({ task_id: Type.String() }),
          execute: async (_id, p) => {
            const method =
              op === 'pause_task'
                ? 'pause'
                : op === 'resume_task'
                  ? 'resume'
                  : 'cancel';
            ctx.taskScheduler[method](p.task_id, {
              groupFolder: ctx.groupFolder,
              isMain: ctx.isMain,
            });
            return okText(
              `Task ${p.task_id} ${op.replace('_task', '')} requested.`,
            );
          },
        }),
      );
    }

    pi.registerTool(
      defineTool({
        name: 'update_task',
        label: 'update_task',
        description:
          'Update fields on an existing task. Omitted fields stay the same.',
        parameters: Type.Object({
          task_id: Type.String(),
          prompt: Type.Optional(Type.String()),
          schedule_type: Type.Optional(
            Type.Union([
              Type.Literal('cron'),
              Type.Literal('interval'),
              Type.Literal('once'),
            ]),
          ),
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
      }),
    );

    pi.registerTool(
      defineTool({
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
          if (!ctx.isMain) {
            return errText('Only the main group can register new groups.');
          }
          ctx.groupRegistry.register({
            jid: p.jid,
            name: p.name,
            folder: p.folder,
            trigger: p.trigger,
            requiresTrigger: p.requiresTrigger ?? false,
          });
          return okText(`Group "${p.name}" registered.`);
        },
      }),
    );
  };
}
