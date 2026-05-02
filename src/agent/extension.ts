// src/agent/extension.ts
//
// NanoClaw's pi-coding-agent extension. Registers two kinds of things:
//
//   1) Tools — agent-callable APIs (bash, read, write, edit, schedule_task,
//      register_group, …). These cost LLM tokens and are part of the
//      model's reasoning loop.
//
//   2) Slash commands — user-typed shortcuts (`/help`, `/new`, `/resume`,
//      `/compact`, `/context`, `/diagnostics`, `/tools`). pi's
//      `_tryExecuteExtensionCommand` (agent-session.ts:970) intercepts
//      `/<name>` in `session.prompt(...)` BEFORE any LLM call — handlers
//      run for free. Output is sent via the closure-captured `ctx.send`
//      (per-chat sink) rather than pi's TUI-shaped `piCtx.ui.notify`,
//      because we render to Feishu, not to a terminal.

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
import {
  getChatSessionStats,
  listChatSessions,
  newChatSession,
  resumeChatSession,
} from './run.js';
import { fmtSessionList, fmtSessionStats } from './slash-helpers.js';
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

    // -----------------------------------------------------------------
    // Slash commands. Registered via pi's extension API; handlers run
    // when the user types `/<name>` and short-circuit the LLM call
    // (agent-session.ts:972). All output goes through `ctx.send` —
    // there's no notification of pi's TUI-shaped `piCtx.ui` because
    // NanoClaw renders to Feishu cards/messages, not a terminal.
    // -----------------------------------------------------------------

    pi.registerCommand('help', {
      description: '查看可用命令',
      handler: async () => {
        const cmds = pi
          .getCommands()
          .filter((c) => c.source === 'extension')
          .sort((a, b) => a.name.localeCompare(b.name));
        const lines = ['_NanoClaw 内置命令_:'];
        for (const c of cmds) {
          lines.push(
            c.description
              ? `- \`/${c.name}\` — ${c.description}`
              : `- \`/${c.name}\``,
          );
        }
        await ctx.send(lines.join('\n'));
      },
    });

    pi.registerCommand('new', {
      description: '开启新会话（旧会话保留在磁盘上，可用 /resume 找回）',
      handler: async () => {
        await newChatSession(ctx.groupFolder, ctx.chatJid, ctx.isMain);
        await ctx.send('_已开启新会话。旧会话已保存，可用 `/resume` 找回。_');
      },
    });

    pi.registerCommand('resume', {
      description: '不带参数列出最近会话；带参数 N 切换到第 N 个',
      handler: async (args) => {
        const sessions = await listChatSessions(ctx.groupFolder, 10);
        if (sessions.length === 0) {
          await ctx.send('_暂无可恢复的历史会话。_');
          return;
        }
        const trimmed = args.trim();
        if (!trimmed) {
          await ctx.send(fmtSessionList(sessions));
          return;
        }
        const idx = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) {
          await ctx.send(
            `_序号无效。请传 1..${sessions.length} 之间的整数，或不带参数查看列表。_`,
          );
          return;
        }
        const target = sessions[idx - 1];
        await resumeChatSession(
          ctx.groupFolder,
          ctx.chatJid,
          ctx.isMain,
          target.path,
        );
        await ctx.send(`_已恢复会话 #${idx}（${target.messageCount} 条消息）_`);
      },
    });

    pi.registerCommand('context', {
      description: '查看当前模型、token 用量、上下文窗口与费用',
      handler: async () => {
        const s = await getChatSessionStats(
          ctx.groupFolder,
          ctx.chatJid,
          ctx.isMain,
        );
        await ctx.send(fmtSessionStats(s));
      },
    });
  };
}
