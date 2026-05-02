import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the agent helpers; slash.ts only needs them to be callable async fns.
vi.mock('./agent/run.js', () => ({
  clearChatSession: vi.fn(async () => {}),
  compactChatSession: vi.fn(async () => ({
    tokensBefore: 1234,
    summary: 'compact summary',
  })),
  getChatSessionStats: vi.fn(async () => ({
    totalMessages: 12,
    totalTokens: 5000,
    cost: 0.0123,
    contextWindow: 200000,
    contextPercent: 2.5,
  })),
}));

import {
  clearChatSession,
  compactChatSession,
  getChatSessionStats,
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
  vi.mocked(clearChatSession).mockClear();
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
    expect(sent[0].text).toContain('/clear');
    expect(sent[0].text).toContain('/compact');
    expect(sent[0].text).toContain('/context');
  });

  it('routes /clear and calls clearChatSession with chat ids', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /clear',
      channel,
    });
    expect(handled).toBe(true);
    expect(clearChatSession).toHaveBeenCalledWith(
      'feishu_main',
      'feishu:oc_abc',
      false,
    );
    expect(sent[0].text).toContain('已清空');
  });

  it('treats /new as alias for /clear', async () => {
    const { channel } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /new',
      channel,
    });
    expect(handled).toBe(true);
    expect(clearChatSession).toHaveBeenCalledTimes(1);
  });

  it('is case-insensitive on the command name', async () => {
    const { channel } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /CLEAR',
      channel,
    });
    expect(handled).toBe(true);
    expect(clearChatSession).toHaveBeenCalledTimes(1);
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

  it('routes /context with token + percent + cost', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /context',
      channel,
    });
    expect(handled).toBe(true);
    expect(getChatSessionStats).toHaveBeenCalledTimes(1);
    expect(sent[0].text).toContain('5,000');
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

  it('returns false on natural-language clear request', async () => {
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy please clear our chat',
      channel,
    });
    expect(handled).toBe(false);
    expect(clearChatSession).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('returns false on empty / trigger-only content', async () => {
    const { channel } = makeChannel();
    expect(
      await tryHandleSlash({ ...baseCtx, lastContent: '', channel }),
    ).toBe(false);
    expect(
      await tryHandleSlash({ ...baseCtx, lastContent: '@andy', channel }),
    ).toBe(false);
    expect(
      await tryHandleSlash({ ...baseCtx, lastContent: '@andy ', channel }),
    ).toBe(false);
  });

  it('reports error to chat when underlying op throws, still returns true', async () => {
    vi.mocked(clearChatSession).mockRejectedValueOnce(
      new Error('disk full'),
    );
    const { channel, sent } = makeChannel();
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /clear',
      channel,
    });
    expect(handled).toBe(true);
    expect(sent[0].text).toContain('失败');
    expect(sent[0].text).toContain('disk full');
  });

  it("does not crash if channel.sendMessage itself fails during error reporting", async () => {
    vi.mocked(clearChatSession).mockRejectedValueOnce(new Error('boom'));
    const { channel } = makeChannel({ fail: true });
    const handled = await tryHandleSlash({
      ...baseCtx,
      lastContent: '@andy /clear',
      channel,
    });
    expect(handled).toBe(true); // still acknowledged, no rethrow
  });
});
