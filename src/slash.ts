// src/slash.ts
//
// NanoClaw slash-command dispatcher. Runs after the trigger gate in
// processGroupMessages (so sender ACL + trigger requirement are already
// satisfied) and before agent invocation. Recognized commands short-
// circuit the agent and reply via Channel.sendMessage. Unknown patterns
// fall through (return false) so the user can still type messages that
// happen to start with /<word>.
//
// Architecture decisions (see /Users/haoyiqiang/.claude/plans/a-wiggly-bengio.md):
//   • /clear and /help are NanoClaw-implemented (pi has no SDK equivalent
//     for "reset session"; help is static).
//   • /compact and /context call pi-coding-agent's public AgentSession
//     methods directly — pi owns the implementation.

import {
  clearChatSession,
  compactChatSession,
  getChatSessionStats,
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
• \`/clear\` (或 \`/new\`) — 清空会话上下文（保留聊天流水和 CLAUDE.md）
• \`/compact [提示词]\` — 手动压缩当前上下文，可选传压缩指令
• \`/context\` — 查看当前 token 使用情况`;

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

      case 'clear':
      case 'new':
        await clearChatSession(ctx.groupFolder, ctx.chatJid, ctx.isMain);
        await ctx.channel.sendMessage(
          ctx.chatJid,
          '_已清空会话上下文。下条消息从空白开始。_',
        );
        return true;

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
        const win = s.contextWindow?.toLocaleString() ?? '?';
        await ctx.channel.sendMessage(
          ctx.chatJid,
          [
            '_会话状态_',
            `• 消息数: ${s.totalMessages}`,
            `• Token 总计: ${s.totalTokens.toLocaleString()}`,
            `• 上下文窗口: ${pct} (${s.totalTokens.toLocaleString()}/${win})`,
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
