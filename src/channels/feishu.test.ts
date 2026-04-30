import { describe, it, expect, vi, beforeEach } from 'vitest';

import { FeishuChannel, FeishuChannelDeps } from './feishu.js';
import { ChannelOpts } from './registry.js';
import { NewMessage, RegisteredGroup } from '../types.js';

type DispatcherHandler = (data: unknown) => Promise<void> | void;

function makeDeps(): {
  deps: FeishuChannelDeps;
  handlers: Record<string, DispatcherHandler>;
  wsStart: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  messageCreate: ReturnType<typeof vi.fn>;
} {
  const handlers: Record<string, DispatcherHandler> = {};
  const dispatcher = {
    register(map: Record<string, DispatcherHandler>) {
      Object.assign(handlers, map);
      return this;
    },
  } as unknown as FeishuChannelDeps['dispatcher'];

  const wsStart = vi.fn(async () => {});
  const request = vi.fn(async () => ({ bot: { open_id: 'ou_bot' } }));
  const messageCreate = vi.fn(async () => ({
    code: 0,
    data: { message_id: 'om_sent' },
  }));
  const deps: FeishuChannelDeps = {
    client: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      im: { message: { create: messageCreate } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      request: request as any,
    },
    wsClient: { start: wsStart },
    dispatcher,
  };
  return { deps, handlers, wsStart, request, messageCreate };
}

function makeChannelOpts(): ChannelOpts & {
  messages: Array<{ jid: string; msg: NewMessage }>;
} {
  const messages: Array<{ jid: string; msg: NewMessage }> = [];
  return {
    messages,
    onMessage(jid, msg) {
      messages.push({ jid, msg });
    },
    registeredGroups(): Record<string, RegisteredGroup> {
      return {};
    },
  };
}

function buildTextEvent(
  overrides: Partial<{
    text: string;
    chatId: string;
    msgId: string;
    mentions: unknown[];
    senderOpenId: string;
    chatType: string;
    parentId: string;
  }> = {},
): unknown {
  const text = overrides.text ?? 'hello';
  return {
    event: {
      sender: { sender_id: { open_id: overrides.senderOpenId ?? 'ou_user' } },
      message: {
        message_id: overrides.msgId ?? 'om_1',
        chat_id: overrides.chatId ?? 'oc_abc',
        chat_type: overrides.chatType ?? 'group',
        create_time: '1713600000000',
        message_type: 'text',
        content: JSON.stringify({ text }),
        mentions: overrides.mentions ?? [],
        parent_id: overrides.parentId,
      },
    },
  };
}

describe('FeishuChannel', () => {
  let opts: ReturnType<typeof makeChannelOpts>;

  beforeEach(() => {
    opts = makeChannelOpts();
  });

  describe('ownsJid', () => {
    it('accepts feishu: prefix', () => {
      const { deps } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      expect(ch.ownsJid('feishu:oc_abc')).toBe(true);
    });

    it('rejects other prefixes', () => {
      const { deps } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      expect(ch.ownsJid('slack:C123')).toBe(false);
      expect(ch.ownsJid('oc_abc')).toBe(false);
      expect(ch.ownsJid('')).toBe(false);
    });
  });

  describe('connect / disconnect', () => {
    it('resolves bot identity and starts WebSocket on connect', async () => {
      const { deps, wsStart, request } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      expect(ch.isConnected()).toBe(false);
      await ch.connect();
      expect(request).toHaveBeenCalledWith({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      });
      expect(wsStart).toHaveBeenCalledOnce();
      expect(ch.isConnected()).toBe(true);
    });

    it('stays connected even if bot identity probe fails', async () => {
      const { deps, wsStart, request } = makeDeps();
      request.mockRejectedValueOnce(new Error('boom'));
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      expect(wsStart).toHaveBeenCalledOnce();
      expect(ch.isConnected()).toBe(true);
    });

    it('disconnect flips state to false', async () => {
      const { deps } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('sends a post message with md tag and strips feishu: prefix from JID', async () => {
      const { deps, messageCreate } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.sendMessage('feishu:oc_abc', 'hello **world**');
      expect(messageCreate).toHaveBeenCalledOnce();
      const call = messageCreate.mock.calls[0][0] as {
        params: { receive_id_type: string };
        data: { receive_id: string; msg_type: string; content: string };
      };
      expect(call.params.receive_id_type).toBe('chat_id');
      expect(call.data.receive_id).toBe('oc_abc');
      expect(call.data.msg_type).toBe('post');
      const parsed = JSON.parse(call.data.content);
      expect(parsed.zh_cn.content[0][0]).toEqual({
        tag: 'md',
        text: 'hello **world**',
      });
    });
  });

  describe('inbound text', () => {
    it('emits NewMessage on text event', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await handlers['im.message.receive_v1'](buildTextEvent({ text: 'hi' }));
      expect(opts.messages).toHaveLength(1);
      const entry = opts.messages[0];
      expect(entry.jid).toBe('feishu:oc_abc');
      expect(entry.msg.content).toBe('hi');
      expect(entry.msg.sender).toBe('ou_user');
      expect(entry.msg.id).toBe('om_1');
      expect(entry.msg.timestamp).toBe('2024-04-20T08:00:00.000Z');
    });

    it('carries parent_id into reply_to_message_id', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await handlers['im.message.receive_v1'](
        buildTextEvent({ parentId: 'om_parent' }),
      );
      expect(opts.messages[0].msg.reply_to_message_id).toBe('om_parent');
    });

    it('is_from_me set when sender matches bot open_id', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await handlers['im.message.receive_v1'](
        buildTextEvent({ senderOpenId: 'ou_bot' }),
      );
      expect(opts.messages[0].msg.is_from_me).toBe(true);
    });

    it('deduplicates identical message_id deliveries', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      const evt = buildTextEvent({ msgId: 'om_dup' });
      await handlers['im.message.receive_v1'](evt);
      await handlers['im.message.receive_v1'](evt);
      expect(opts.messages).toHaveLength(1);
    });

    it('ignores events without message payload', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await handlers['im.message.receive_v1']({});
      await handlers['im.message.receive_v1']({ event: {} });
      expect(opts.messages).toHaveLength(0);
    });

    it('accepts flat events without an `event` wrapper', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      const flat = (buildTextEvent() as { event: unknown }).event;
      await handlers['im.message.receive_v1'](flat);
      expect(opts.messages).toHaveLength(1);
    });
  });

  describe('inbound message types', () => {
    async function fire(messageType: string, content: unknown) {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await handlers['im.message.receive_v1']({
        event: {
          sender: { sender_id: { open_id: 'ou_user' } },
          message: {
            message_id: `om_${messageType}`,
            chat_id: 'oc_abc',
            chat_type: 'group',
            create_time: '1713600000000',
            message_type: messageType,
            content: JSON.stringify(content),
            mentions: [],
          },
        },
      });
      return opts.messages.at(-1)?.msg.content;
    }

    it('image → [image]', async () => {
      expect(await fire('image', { image_key: 'img_xxx' })).toBe('[image]');
    });

    it('file with name → [file:<name>]', async () => {
      expect(
        await fire('file', { file_name: 'report.pdf', file_key: 'file_x' }),
      ).toBe('[file:report.pdf]');
    });

    it('file without name → [file]', async () => {
      expect(await fire('file', { file_key: 'file_x' })).toBe('[file]');
    });

    it('audio → [audio]', async () => {
      expect(await fire('audio', { file_key: 'f' })).toBe('[audio]');
    });

    it('sticker → [sticker]', async () => {
      expect(await fire('sticker', { file_key: 'f' })).toBe('[sticker]');
    });

    it('post → flattened lines with title', async () => {
      const postContent = {
        title: 'Heading',
        content: [
          [
            { tag: 'text', text: 'Line 1 ' },
            { tag: 'a', text: 'link', href: 'https://x' },
          ],
          [{ tag: 'text', text: 'Line 2' }],
        ],
      };
      expect(await fire('post', postContent)).toBe(
        'Heading\nLine 1 link\nLine 2',
      );
    });

    it('unknown message_type falls back to JSON serialisation', async () => {
      const custom = { foo: 'bar' };
      expect(await fire('unsupported_type', custom)).toBe(
        JSON.stringify(custom),
      );
    });
  });

  describe('mention handling', () => {
    it('strips the bot @mention from text', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await handlers['im.message.receive_v1'](
        buildTextEvent({
          text: '@_user_1 please help',
          mentions: [
            { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' },
          ],
        }),
      );
      expect(opts.messages[0].msg.content).toBe('please help');
    });

    it('replaces non-bot mentions with @name', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await handlers['im.message.receive_v1'](
        buildTextEvent({
          text: 'hi @_user_2 over there',
          mentions: [
            { key: '@_user_2', id: { open_id: 'ou_alice' }, name: 'Alice' },
          ],
        }),
      );
      expect(opts.messages[0].msg.content).toBe('hi @Alice over there');
    });

    it('handles missing mentions gracefully', async () => {
      const { deps, handlers } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await ch.connect();
      await handlers['im.message.receive_v1'](
        buildTextEvent({ text: 'plain', mentions: undefined }),
      );
      expect(opts.messages[0].msg.content).toBe('plain');
    });
  });

  describe('setTyping', () => {
    it('is a no-op', async () => {
      const { deps } = makeDeps();
      const ch = new FeishuChannel(opts, { appId: 'a', appSecret: 's', deps });
      await expect(
        ch.setTyping('feishu:oc_abc', true),
      ).resolves.toBeUndefined();
    });
  });
});
