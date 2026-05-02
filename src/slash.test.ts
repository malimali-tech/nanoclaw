import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = new Date('2026-05-02T12:00:00Z').getTime();

// Pi's firstMessage is the NanoClaw envelope, not the raw user text.
const envelope1 =
  '<context timezone="Asia/Shanghai" />\n<messages>\n<message sender="andy" time="2026-05-02 05:02">想看下 GitHub 上的 PR 状态</message>\n</messages>';
const envelope2 =
  '<context timezone="Asia/Shanghai" />\n<messages>\n<message sender="andy" time="2026-05-02 04:51">帮我查最近 24 小时的报警</message>\n</messages>';

vi.mock('./agent/run.js', () => ({
  newChatSession: vi.fn(async () => {}),
  listChatSessions: vi.fn(async () => [
    {
      path: '/sessions/2026-05-02_aaa.jsonl',
      id: 'aaa',
      cwd: '/cwd',
      name: undefined,
      parentSessionPath: undefined,
      created: new Date('2026-05-02T11:00:00Z'),
      modified: new Date('2026-05-02T11:30:00Z'), // 30m ago
      messageCount: 8,
      firstMessage: envelope1,
      allMessagesText: '',
    },
    {
      path: '/sessions/2026-05-02_bbb.jsonl',
      id: 'bbb',
      cwd: '/cwd',
      name: 'PR triage notes',
      parentSessionPath: undefined,
      created: new Date('2026-05-01T08:00:00Z'),
      modified: new Date('2026-05-01T09:15:00Z'), // ~1d ago
      messageCount: 16,
      firstMessage: envelope2,
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
import { _resetSlashState, tryHandleSlash } from './slash.js';

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
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  _resetSlashState();
  vi.mocked(newChatSession).mockClear();
  vi.mocked(listChatSessions).mockClear();
  vi.mocked(resumeChatSession).mockClear();
  vi.mocked(compactChatSession).mockClear();
  vi.mocked(getChatSessionStats).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
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

  it('/resume lists sessions with stripped envelope, not raw XML', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume',
      channel,
    });
    expect(handled).toBe(true);
    expect(listChatSessions).toHaveBeenCalledWith('feishu_main', 10);
    expect(resumeChatSession).not.toHaveBeenCalled();
    const text = sent[0].text;
    // Inner user text recovered from envelope:
    expect(text).toContain('想看下 GitHub 上的 PR 状态');
    // Session name preferred when set:
    expect(text).toContain('PR triage notes');
    // Envelope tags must NOT leak through:
    expect(text).not.toContain('<context');
    expect(text).not.toContain('<message');
    // Relative age, not raw timestamp:
    expect(text).toMatch(/30 分钟前|1 天前/);
    expect(text).not.toContain('2026-05-02 05:02');
  });

  it('/resume followed by a bare integer reply resumes that session', async () => {
    const { channel, sent } = makeChannel();
    await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume',
      channel,
    });
    expect(sent).toHaveLength(1);

    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy 2',
      channel,
    });
    expect(handled).toBe(true);
    expect(resumeChatSession).toHaveBeenCalledWith(
      'feishu_main',
      'feishu:oc_abc',
      false,
      '/sessions/2026-05-02_bbb.jsonl',
    );
    expect(sent[1].text).toContain('已恢复');
    expect(sent[1].text).toContain('#2');
  });

  it('rejects out-of-range bare-integer pick after /resume', async () => {
    const { channel, sent } = makeChannel();
    await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume',
      channel,
    });
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy 99',
      channel,
    });
    expect(handled).toBe(true);
    expect(resumeChatSession).not.toHaveBeenCalled();
    expect(sent[1].text).toContain('序号无效');
  });

  it('expired pending /resume picker falls through; bare integer is not consumed', async () => {
    const { channel, sent } = makeChannel();
    await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume',
      channel,
    });
    // Advance past the 5-minute TTL.
    vi.setSystemTime(NOW + 6 * 60_000);
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy 1',
      channel,
    });
    expect(handled).toBe(false);
    expect(resumeChatSession).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('/new clears any pending /resume picker', async () => {
    const { channel } = makeChannel();
    await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume',
      channel,
    });
    await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /new',
      channel,
    });
    // Now a bare-integer reply should NOT be consumed as a pick.
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy 1',
      channel,
    });
    expect(handled).toBe(false);
    expect(resumeChatSession).not.toHaveBeenCalled();
  });

  it('/resume N still works directly without listing first', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /resume 1',
      channel,
    });
    expect(handled).toBe(true);
    expect(resumeChatSession).toHaveBeenCalledWith(
      'feishu_main',
      'feishu:oc_abc',
      false,
      '/sessions/2026-05-02_aaa.jsonl',
    );
    expect(sent[0].text).toContain('已恢复');
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
