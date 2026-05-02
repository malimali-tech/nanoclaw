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
//   • /new → SessionManager.create (fresh jsonl)
//   • /resume → SessionManager.list + SessionManager.open
//   • /compact, /context → pi's public AgentSession methods
//   • /help is local static text.

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
• \`/help\` — 查看本帮助
• \`/new\` — 开启新会话（旧会话保留在磁盘上，可用 /resume 找回）
• \`/resume [N]\` — 不带参数列出最近会话；带序号 N 切换到第 N 个
• \`/compact [提示词]\` — 手动压缩当前上下文，可选传压缩指令
• \`/context\` — 查看当前模型、token 用量、上下文窗口与费用`;

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtSessionEntry(
  idx: number,
  s: { modified: Date; messageCount: number; firstMessage: string },
): string {
  const ts = s.modified.toISOString().replace('T', ' ').slice(0, 16);
  const preview = s.firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${idx}. [${ts}] (${s.messageCount} 条) ${preview}`;
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
        await ctx.channel.sendMessage(
          ctx.chatJid,
          '_已开启新会话。旧会话已保存，可用 `/resume` 找回。_',
        );
        return true;

      case 'resume': {
        const sessions = await listChatSessions(ctx.groupFolder);
        if (sessions.length === 0) {
          await ctx.channel.sendMessage(
            ctx.chatJid,
            '_暂无可恢复的历史会话。_',
          );
          return true;
        }
        if (!rest) {
          const lines = sessions.map((s, i) => fmtSessionEntry(i + 1, s));
          await ctx.channel.sendMessage(
            ctx.chatJid,
            ['_最近会话_（用 `/resume N` 切换）:', ...lines].join('\n'),
          );
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
        const target = sessions[idx - 1];
        await resumeChatSession(
          ctx.groupFolder,
          ctx.chatJid,
          ctx.isMain,
          target.path,
        );
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `_已恢复会话 #${idx}（${target.messageCount} 条消息）。_`,
        );
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
