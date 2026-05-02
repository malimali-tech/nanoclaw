// src/agent/slash-helpers.ts
//
// Pure formatters for slash-command output. No I/O, no state. Imported
// by `src/agent/extension.ts` where `pi.registerCommand` handlers compose
// these into chat replies.

import type { SessionInfo } from '@mariozechner/pi-coding-agent';
import type { ChatSessionStats } from './run.js';

export function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Pi-style relative age (footer/session-selector parity). */
export function fmtRelativeAge(date: Date, now = Date.now()): string {
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
 * NanoClaw wraps user inbound text in a `<context/><messages><message …>`
 * envelope (router.ts:13) before handing it to pi. Pi's stored
 * `firstMessage` is therefore the envelope, not the raw user text. This
 * helper recovers the inner body for previewing in `/resume` listings.
 */
export function extractInnerUserText(raw: string): string {
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

export function fmtSessionEntry(idx: number, s: SessionInfo): string {
  const source = s.name ?? extractInnerUserText(s.firstMessage);
  const label = source.replace(/\s+/g, ' ').trim();
  const truncated = label.length > 60 ? `${label.slice(0, 57)}...` : label;
  return `${idx}. ${truncated || '(空)'} · ${s.messageCount} 条 · ${fmtRelativeAge(s.modified)}`;
}

export function fmtSessionList(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return '_暂无可恢复的历史会话。_';
  return [
    '_最近会话_（用 `/resume N` 切换到对应序号）:',
    ...sessions.map((s, i) => fmtSessionEntry(i + 1, s)),
  ].join('\n');
}

export function fmtSessionStats(s: ChatSessionStats): string {
  const pct =
    s.contextPercent != null ? `${s.contextPercent.toFixed(1)}%` : '?';
  const win = s.contextWindow ? fmtTokens(s.contextWindow) : '?';
  const tokenParts: string[] = [];
  if (s.inputTokens) tokenParts.push(`↑${fmtTokens(s.inputTokens)}`);
  if (s.outputTokens) tokenParts.push(`↓${fmtTokens(s.outputTokens)}`);
  if (s.cacheReadTokens) tokenParts.push(`R${fmtTokens(s.cacheReadTokens)}`);
  if (s.cacheWriteTokens) tokenParts.push(`W${fmtTokens(s.cacheWriteTokens)}`);
  const modelLine = s.modelId
    ? `${s.modelProvider ?? '?'}/${s.modelId}${
        s.thinkingLevel ? ` • thinking ${s.thinkingLevel}` : ''
      }`
    : 'no-model';
  return [
    '_会话状态_',
    `• 模型: ${modelLine}`,
    `• 消息数: ${s.totalMessages}`,
    `• Tokens: ${tokenParts.join(' ') || '0'}`,
    `• 上下文: ${pct} (${fmtTokens(s.totalTokens)}/${win})`,
    `• 估算成本: $${s.cost.toFixed(4)}`,
  ].join('\n');
}
