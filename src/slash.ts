// src/slash.ts
//
// NanoClaw slash-command dispatcher. Runs after the trigger gate in
// processGroupMessages (so sender ACL + trigger requirement are already
// satisfied) and before agent invocation. Recognized commands short-
// circuit the agent and reply via Channel.sendMessage. Unknown patterns
// fall through (return false) so the user can still type messages that
// happen to start with /<word>.
//
// All session-management commands map onto pi-coding-agent primitives:
//   * /new -> SessionManager.create (fresh jsonl)
//   * /resume -> SessionManager.list + SessionManager.open. Without args
//     it lists recent sessions and parks a per-chat picker; the next
//     message that is a bare integer in range consumes the picker and
//     resumes that session (mirrors pi's interactive selector behavior
//     in a chat context).
//   * /compact, /context -> pi's public AgentSession methods.
//   * /help is local static text.

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

const HELP_TEXT = `_NanoClaw 内置命令_:
- \`/help\` — 查看本帮助
- \`/new\` — 开启新会话（旧会话保留在磁盘上，可用 /resume 找回）
- \`/resume\` — 列出最近会话；列表给出后直接回复序号即可切换（5 分钟内有效）
- \`/resume N\` — 直接切换到第 N 个会话
- \`/compact [提示词]\` — 手动压缩当前上下文，可选传压缩指令
- \`/context\` — 查看当前模型、token 用量、上下文窗口与费用`;

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

  // 2) Slash command dispatch.
  const m = stripped.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!m) return false;

  const cmd = m[1].toLowerCase();
  const rest = (m[2] ?? '').trim();

  try {
    switch (cmd) {
      case 'help':
        await ctx.channel.sendMessage(ctx.chatJid, HELP_TEXT);
        return true;

      case 'new':
        await newChatSession(ctx.groupFolder, ctx.chatJid, ctx.isMain);
        pendingResume.delete(ctx.chatJid);
        await ctx.channel.sendMessage(
          ctx.chatJid,
          '_已开启新会话。旧会话已保存，可用 `/resume` 找回。_',
        );
        return true;

      case 'resume': {
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
          return true;
        }
        if (!rest) {
          pendingResume.set(ctx.chatJid, {
            sessions,
            expiresAt: Date.now() + RESUME_PICK_TTL_MS,
          });
          await ctx.channel.sendMessage(ctx.chatJid, buildList(sessions));
          return true;
        }
        const idx = Number.parseInt(rest, 10);
        if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) {
          await ctx.channel.sendMessage(
            ctx.chatJid,
            `_序号无效。请传 1..${sessions.length} 之间的整数，或不带参数查看列表。_`,
          );
          return true;
        }
        await performResume(ctx, sessions, idx);
        return true;
      }

      case 'compact': {
        const result = await compactChatSession(
          ctx.groupFolder,
          ctx.chatJid,
          ctx.isMain,
          rest || undefined,
        );
        const detail =
          result.tokensBefore > 0
            ? `（压缩前 ${result.tokensBefore.toLocaleString()} tokens；下次 \`/context\` 可查看压缩后大小）`
            : '';
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `_已压缩会话上下文。${detail}_`,
        );
        return true;
      }

      case 'context': {
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
        if (s.outputTokens)
          tokenParts.push(`↓${fmtTokens(s.outputTokens)}`);
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
        return true;
      }

      default:
        // Unknown slash — let the agent see it (e.g. user pasting a path).
        return false;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, cmd }, `slash /${cmd} failed`);
    await ctx.channel
      .sendMessage(ctx.chatJid, `_命令 /${cmd} 执行失败: ${errMsg}_`)
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
