// src/slash.ts
//
// NanoClaw slash-command dispatcher. Runs after the trigger gate in
// processGroupMessages (so sender ACL + trigger requirement are already
// satisfied) and before agent invocation. Recognized commands short-
// circuit the agent and reply via Channel.sendMessage. Unknown patterns
// fall through (return false) so the user can still type messages that
// happen to start with /<word>.
//
// Commands are declared in COMMANDS as typed entries with a description
// and an `args` hint (used to auto-render /help). The dispatcher looks up
// by name + aliases — adding a new command is one entry, no switch
// branch. Patterned after openclaw's commands-registry but stripped of
// scope / tier / argsMenu / category since NanoClaw has only text-mode
// inputs and a small catalog.
//
// Session-management commands map onto pi-coding-agent primitives via
// run.ts: /new -> SessionManager.create, /resume -> SessionManager.list +
// .open, /compact + /context -> AgentSession.compact + .getSessionStats.

import type { SessionInfo } from '@mariozechner/pi-coding-agent';
import {
  compactChatSession,
  getChatSessionStats,
  listChatSessions,
  newChatSession,
  resumeChatSession,
} from './agent/run.js';
import { getTriggerPattern } from './config.js';
import { logger } from './logger.js';
import type { Channel } from './types.js';

export interface SlashContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  /** Last user message content; the trigger may still be present. */
  lastContent: string;
  trigger?: string;
  channel: Channel;
}

export interface SlashCommand {
  /** Primary name without leading slash. */
  name: string;
  /** Optional alternate names. Dispatched the same as `name`. */
  aliases?: string[];
  /** One-line user-facing description, used by auto-generated /help. */
  description: string;
  /** Optional args hint shown in /help, e.g. "[N]" or "[提示词]". */
  argsHint?: string;
  /**
   * Command body. `args` is the trimmed remainder after the command name.
   * Throwing here is reported to the chat as `_命令 /name 执行失败: ...`
   * and counts as handled (no double dispatch on retry).
   */
  handler: (args: string, ctx: SlashContext) => Promise<void>;
}

const RESUME_PICK_TTL_MS = 5 * 60_000;
const RESUME_LIST_LIMIT = 10;

interface PendingResume {
  sessions: SessionInfo[];
  expiresAt: number;
}

/** Per-chat resume listing awaiting a numeric pick reply. */
const pendingResume = new Map<string, PendingResume>();

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Pi-style relative age (footer/session-selector parity). */
function fmtRelativeAge(date: Date, now = Date.now()): string {
  const diffMs = Math.max(0, now - date.getTime());
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/**
 * NanoClaw wraps user inbound text in a `<context/><messages><message ...>`
 * envelope (router.ts:13) before handing it to pi. Pi's stored
 * `firstMessage` is therefore the envelope, not the actual user text.
 * Recover the inner message body(ies) for a clean preview; fall back to
 * the raw string if the envelope shape is unrecognized.
 */
function extractInnerUserText(raw: string): string {
  if (!raw) return '';
  const matches = [...raw.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/g)];
  if (matches.length === 0) return raw;
  return matches
    .map((m) =>
      m[1]
        .replace(/<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&'),
    )
    .join(' ')
    .trim();
}

/**
 * One-line summary for a session, mirroring pi's session-selector layout
 * (`name ?? firstMessage` on the left; message count + relative age on
 * the right). Pi has no LLM-generated summary — this is the same data the
 * interactive picker uses, with NanoClaw's XML envelope stripped.
 */
function fmtSessionEntry(idx: number, s: SessionInfo): string {
  const source = s.name ?? extractInnerUserText(s.firstMessage);
  const label = source.replace(/\s+/g, ' ').trim();
  const truncated = label.length > 60 ? `${label.slice(0, 57)}...` : label;
  return `${idx}. ${truncated || '(空)'} · ${s.messageCount} 条 · ${fmtRelativeAge(s.modified)}`;
}

function buildList(sessions: SessionInfo[]): string {
  return [
    '_最近会话_（直接回复序号切换，或 `/resume N`；5 分钟内有效）:',
    ...sessions.map((s, i) => fmtSessionEntry(i + 1, s)),
  ].join('\n');
}

async function performResume(
  ctx: SlashContext,
  sessions: SessionInfo[],
  idx: number,
): Promise<void> {
  const target = sessions[idx - 1];
  await resumeChatSession(
    ctx.groupFolder,
    ctx.chatJid,
    ctx.isMain,
    target.path,
  );
  pendingResume.delete(ctx.chatJid);
  const source = target.name ?? extractInnerUserText(target.firstMessage);
  const label = source.replace(/\s+/g, ' ').trim().slice(0, 40);
  await ctx.channel.sendMessage(
    ctx.chatJid,
    `_已恢复会话 #${idx}（${target.messageCount} 条消息）：${label || '(空)'}_`,
  );
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

/**
 * The full catalog of NanoClaw slash commands. Append entries here; both
 * dispatch and /help auto-discover them.
 */
const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: '查看本帮助',
    handler: async (_args, ctx) => {
      await ctx.channel.sendMessage(ctx.chatJid, buildHelp());
    },
  },
  {
    name: 'new',
    description: '开启新会话（旧会话保留在磁盘上，可用 /resume 找回）',
    handler: async (_args, ctx) => {
      await newChatSession(ctx.groupFolder, ctx.chatJid, ctx.isMain);
      pendingResume.delete(ctx.chatJid);
      await ctx.channel.sendMessage(
        ctx.chatJid,
        '_已开启新会话。旧会话已保存，可用 `/resume` 找回。_',
      );
    },
  },
  {
    name: 'resume',
    description:
      '不带参数列出最近会话，列表给出后直接回复序号即可切换（5 分钟内有效）；带参数 N 直接切换',
    argsHint: '[N]',
    handler: async (args, ctx) => {
      const sessions = await listChatSessions(
        ctx.groupFolder,
        RESUME_LIST_LIMIT,
      );
      if (sessions.length === 0) {
        pendingResume.delete(ctx.chatJid);
        await ctx.channel.sendMessage(
          ctx.chatJid,
          '_暂无可恢复的历史会话。_',
        );
        return;
      }
      if (!args) {
        pendingResume.set(ctx.chatJid, {
          sessions,
          expiresAt: Date.now() + RESUME_PICK_TTL_MS,
        });
        await ctx.channel.sendMessage(ctx.chatJid, buildList(sessions));
        return;
      }
      const idx = Number.parseInt(args, 10);
      if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) {
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `_序号无效。请传 1..${sessions.length} 之间的整数，或不带参数查看列表。_`,
        );
        return;
      }
      await performResume(ctx, sessions, idx);
    },
  },
  {
    name: 'compact',
    description: '手动压缩当前上下文，可选传压缩指令',
    argsHint: '[提示词]',
    handler: async (args, ctx) => {
      const result = await compactChatSession(
        ctx.groupFolder,
        ctx.chatJid,
        ctx.isMain,
        args || undefined,
      );
      const detail =
        result.tokensBefore > 0
          ? `（压缩前 ${result.tokensBefore.toLocaleString()} tokens；下次 \`/context\` 可查看压缩后大小）`
          : '';
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `_已压缩会话上下文。${detail}_`,
      );
    },
  },
  {
    name: 'context',
    description: '查看当前模型、token 用量、上下文窗口与费用',
    handler: async (_args, ctx) => {
      const s = await getChatSessionStats(
        ctx.groupFolder,
        ctx.chatJid,
        ctx.isMain,
      );
      const pct =
        s.contextPercent != null ? `${s.contextPercent.toFixed(1)}%` : '?';
      const win = s.contextWindow ? fmtTokens(s.contextWindow) : '?';
      const tokenParts: string[] = [];
      if (s.inputTokens) tokenParts.push(`↑${fmtTokens(s.inputTokens)}`);
      if (s.outputTokens) tokenParts.push(`↓${fmtTokens(s.outputTokens)}`);
      if (s.cacheReadTokens)
        tokenParts.push(`R${fmtTokens(s.cacheReadTokens)}`);
      if (s.cacheWriteTokens)
        tokenParts.push(`W${fmtTokens(s.cacheWriteTokens)}`);
      const modelLine = s.modelId
        ? `${s.modelProvider ?? '?'}/${s.modelId}${
            s.thinkingLevel ? ` • thinking ${s.thinkingLevel}` : ''
          }`
        : 'no-model';
      await ctx.channel.sendMessage(
        ctx.chatJid,
        [
          '_会话状态_',
          `• 模型: ${modelLine}`,
          `• 消息数: ${s.totalMessages}`,
          `• Tokens: ${tokenParts.join(' ') || '0'}`,
          `• 上下文: ${pct} (${fmtTokens(s.totalTokens)}/${win})`,
          `• 估算成本: $${s.cost.toFixed(4)}`,
        ].join('\n'),
      );
    },
  },
];

/** Build the lookup index lazily so adding entries to COMMANDS Just Works. */
const byName: Map<string, SlashCommand> = (() => {
  const m = new Map<string, SlashCommand>();
  for (const cmd of COMMANDS) {
    m.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) m.set(alias, cmd);
  }
  return m;
})();

function buildHelp(): string {
  const lines = ['_NanoClaw 内置命令_:'];
  for (const cmd of COMMANDS) {
    const head = cmd.argsHint
      ? `\`/${cmd.name} ${cmd.argsHint}\``
      : `\`/${cmd.name}\``;
    lines.push(`- ${head} — ${cmd.description}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Try to handle a slash command. Returns true iff the message was a
 * recognized command (caller should NOT then forward to the agent).
 * Errors are caught, logged, and reported to the chat — they still count
 * as "handled" so a flaky command doesn't stall the message loop on
 * retry.
 */
export async function tryHandleSlash(ctx: SlashContext): Promise<boolean> {
  const stripped = ctx.lastContent
    .replace(getTriggerPattern(ctx.trigger), '')
    .trim();

  // 1) Pending /resume picker: bare integer reply consumes the listing.
  const pending = pendingResume.get(ctx.chatJid);
  if (pending && pending.expiresAt < Date.now()) {
    pendingResume.delete(ctx.chatJid);
  } else if (pending && /^\d+$/.test(stripped)) {
    const idx = Number.parseInt(stripped, 10);
    if (idx < 1 || idx > pending.sessions.length) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `_序号无效。请回复 1..${pending.sessions.length} 之间的数字，或重新执行 /resume。_`,
      );
      return true;
    }
    try {
      await performResume(ctx, pending.sessions, idx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, chatJid: ctx.chatJid }, 'resume pick failed');
      await ctx.channel
        .sendMessage(ctx.chatJid, `_恢复会话失败: ${msg}_`)
        .catch(() => {
          /* swallow */
        });
    }
    return true;
  }

  // 2) Slash command dispatch via registry.
  const m = stripped.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!m) return false;

  const cmdName = m[1].toLowerCase();
  const rest = (m[2] ?? '').trim();
  const cmd = byName.get(cmdName);
  if (!cmd) {
    // Unknown slash — let the agent see it (e.g. user pasting a path).
    return false;
  }

  try {
    await cmd.handler(rest, ctx);
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, cmd: cmdName }, `slash /${cmdName} failed`);
    await ctx.channel
      .sendMessage(ctx.chatJid, `_命令 /${cmdName} 执行失败: ${errMsg}_`)
      .catch(() => {
        /* swallow — channel may be down, don't break the loop */
      });
    return true; // we acknowledged it (with an error), don't double-dispatch
  }
}

/** Test-only: reset the resume-picker state. */
export function _resetSlashState(): void {
  pendingResume.clear();
}

/** Exposed for tests + future /diagnostics-style introspection. */
export function _listCommands(): readonly SlashCommand[] {
  return COMMANDS;
}
