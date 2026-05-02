import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the agent helpers; slash.ts only needs them to be callable async fns.
vi.mock('./agent/run.js', () => ({
  newChatSession: vi.fn(async () => {}),
  listChatSessions: vi.fn(async () => [
    {
      path: '/sessions/2026-05-01_aaa.jsonl',
      id: 'aaa',
      cwd: '/cwd',
      name: undefined,
      parentSessionPath: undefined,
      created: new Date('2026-05-01T10:00:00Z'),
      modified: new Date('2026-05-01T12:34:00Z'),
      messageCount: 8,
      firstMessage: 'hello world from earlier session',
      allMessagesText: '',
    },
    {
      path: '/sessions/2026-04-30_bbb.jsonl',
      id: 'bbb',
      cwd: '/cwd',
      name: undefined,
      parentSessionPath: undefined,
      created: new Date('2026-04-30T08:00:00Z'),
      modified: new Date('2026-04-30T09:15:00Z'),
      messageCount: 3,
      firstMessage: 'second oldest',
      allMessagesText: '',
    },
  ]),
  resumeChatSession: vi.fn(async () => {}),
  compactChatSession: vi.fn(async () => ({
    tokensBefore: 1234,
    summary: 'compact summary',
  })),
  getChatSessionStats: vi.fn(async () => ({
    totalMessages: 12,
    inputTokens: 800,
    outputTokens: 200,
    cacheReadTokens: 4000,
    cacheWriteTokens: 0,
    totalTokens: 5000,
    cost: 0.0123,
    contextWindow: 200000,
    contextPercent: 2.5,
    modelProvider: 'anthropic',
    modelId: 'claude-opus-4-7',
    thinkingLevel: 'medium',
  })),
}));

import {
  compactChatSession,
  getChatSessionStats,
  listChatSessions,
  newChatSession,
  resumeChatSession,
} from './agent/run.js';
import type { Channel } from './types.js';
import { tryHandleSlash } from './slash.js';

interface CapturedSend {
  jid: string;
  text: string;
}

function makeChannel(opts?: { fail?: boolean }): {
  channel: Channel;
  sent: CapturedSend[];
} {
  const sent: CapturedSend[] = [];
  const channel: Channel = {
    name: 'mock',
    connect: async () => {},
    sendMessage: async (jid: string, text: string) => {
      if (opts?.fail) throw new Error('channel down');
      sent.push({ jid, text });
    },
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
  };
  return { channel, sent };
}

const baseCtx = {
  groupFolder: 'feishu_main',
  chatJid: 'feishu:oc_abc',
  isMain: false,
  trigger: '@andy',
};

beforeEach(() => {
  vi.mocked(newChatSession).mockClear();
  vi.mocked(listChatSessions).mockClear();
  vi.mocked(resumeChatSession).mockClear();
  vi.mocked(compactChatSession).mockClear();
  vi.mocked(getChatSessionStats).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tryHandleSlash', () => {
  it('routes /help and sends help text', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /help',
      channel,
    });
    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('/new');
    expect(sent[0].text).toContain('/resume');
    expect(sent[0].text).toContain('/compact');
    expect(sent[0].text).toContain('/context');
  });

  it('routes /new and calls newChatSession with chat ids', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /new',
      channel,
    });
    expect(handled).toBe(true);
    expect(newChatSession).toHaveBeenCalledWith(
      'feishu_main',
      'feishu:oc_abc',
      false,
    );
    expect(sent[0].text).toContain('新会话');
  });

  it('does NOT treat /clear as a known command (passes through)', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /clear',
      channel,
    });
    expect(handled).toBe(false);
    expect(newChatSession).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('is case-insensitive on the command name', async () => {
    const { channel } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /NEW',
      channel,
    });
    expect(handled).toBe(true);
    expect(newChatSession).toHaveBeenCalledTimes(1);
  });

  it('routes /resume without args and lists sessions', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume',
      channel,
    });
    expect(handled).toBe(true);
    expect(listChatSessions).toHaveBeenCalledWith('feishu_main');
    expect(resumeChatSession).not.toHaveBeenCalled();
    expect(sent[0].text).toContain('最近会话');
    expect(sent[0].text).toContain('1.');
    expect(sent[0].text).toContain('hello world');
  });

  it('routes /resume N and switches to that session', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume 2',
      channel,
    });
    expect(handled).toBe(true);
    expect(resumeChatSession).toHaveBeenCalledWith(
      'feishu_main',
      'feishu:oc_abc',
      false,
      '/sessions/2026-04-30_bbb.jsonl',
    );
    expect(sent[0].text).toContain('已恢复');
    expect(sent[0].text).toContain('#2');
  });

  it('rejects /resume with out-of-range index', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume 99',
      channel,
    });
    expect(handled).toBe(true);
    expect(resumeChatSession).not.toHaveBeenCalled();
    expect(sent[0].text).toContain('序号无效');
  });

  it('reports empty list when no sessions exist', async () => {
    vi.mocked(listChatSessions).mockResolvedValueOnce([]);
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume',
      channel,
    });
    expect(handled).toBe(true);
    expect(sent[0].text).toContain('暂无');
  });

  it('routes /compact without instructions', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /compact',
      channel,
    });
    expect(handled).toBe(true);
    expect(compactChatSession).toHaveBeenCalledWith(
      'feishu_main',
      'feishu:oc_abc',
      false,
      undefined,
    );
    expect(sent[0].text).toContain('1,234');
  });

  it('routes /compact with custom instructions', async () => {
    const { channel } = makeChannel();
    await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /compact 重点保留 PR 链接',
      channel,
    });
    expect(compactChatSession).toHaveBeenCalledWith(
      'feishu_main',
      'feishu:oc_abc',
      false,
      '重点保留 PR 链接',
    );
  });

  it('routes /context with model + token breakdown + percent + cost', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /context',
      channel,
    });
    expect(handled).toBe(true);
    expect(getChatSessionStats).toHaveBeenCalledTimes(1);
    expect(sent[0].text).toContain('anthropic/claude-opus-4-7');
    expect(sent[0].text).toContain('thinking medium');
    expect(sent[0].text).toContain('↑800');
    expect(sent[0].text).toContain('↓200');
    expect(sent[0].text).toContain('R4.0k');
    expect(sent[0].text).toContain('2.5%');
    expect(sent[0].text).toContain('$0.0123');
  });

  it('returns false on unknown slash command (passes through to agent)', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /unknown',
      channel,
    });
    expect(handled).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('returns false on natural-language reset request', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy please start a new chat',
      channel,
    });
    expect(handled).toBe(false);
    expect(newChatSession).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('returns false on empty / trigger-only content', async () => {
    const { channel } = makeChannel();
    expect(await tryHandleSlash({ ...baseCtx, lastContent: '', channel })).toBe(
      false,
    );
    expect(
      await tryHandleSlash({ ...baseCtx, lastContent: '@andy', channel }),
    ).toBe(false);
    expect(
      await tryHandleSlash({ ...baseCtx, lastContent: '@andy ', channel }),
    ).toBe(false);
  });

  it('reports error to chat when underlying op throws, still returns true', async () => {
    vi.mocked(newChatSession).mockRejectedValueOnce(new Error('disk full'));
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /new',
      channel,
    });
    expect(handled).toBe(true);
    expect(sent[0].text).toContain('失败');
    expect(sent[0].text).toContain('disk full');
  });

  it('does not crash if channel.sendMessage itself fails during error reporting', async () => {
    vi.mocked(newChatSession).mockRejectedValueOnce(new Error('boom'));
    const { channel } = makeChannel({ fail: true });
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /new',
      channel,
    });
    expect(handled).toBe(true); // still acknowledged, no rethrow
  });
});
