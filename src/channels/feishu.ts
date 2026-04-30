import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

interface FeishuMention {
  key: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
  name?: string;
}

interface FeishuMessage {
  message_id: string;
  chat_id: string;
  chat_type?: string;
  create_time?: string;
  message_type: string;
  content: string;
  mentions?: FeishuMention[];
  parent_id?: string;
  root_id?: string;
}

interface FeishuMessageEvent {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
  };
  message: FeishuMessage;
}

type MaybeEventEnvelope = { event?: FeishuMessageEvent } | FeishuMessageEvent;

/** Payload of `im.chat.member.bot.added_v1` — bot was added to a group. */
interface FeishuBotAddedEvent {
  chat_id?: string;
  name?: string;
  external?: boolean;
  operator_id?: { open_id?: string; user_id?: string; union_id?: string };
}
type MaybeBotAddedEnvelope =
  | { event?: FeishuBotAddedEvent }
  | FeishuBotAddedEvent;

export interface FeishuChannelDeps {
  client: Pick<Lark.Client, 'im' | 'request'>;
  wsClient: {
    start: (args: { eventDispatcher: Lark.EventDispatcher }) => Promise<void>;
  };
  dispatcher: Lark.EventDispatcher;
}

export interface FeishuChannelOptions {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
  deps?: FeishuChannelDeps;
}

function resolveDomain(brand: string | undefined): Lark.Domain {
  return brand === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

function defaultDeps(
  appId: string,
  appSecret: string,
  domain: Lark.Domain,
): FeishuChannelDeps {
  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain,
  });
  const dispatcher = new Lark.EventDispatcher({});
  const wsClient = new Lark.WSClient({ appId, appSecret, domain });
  return { client, wsClient, dispatcher };
}

export class FeishuChannel implements Channel {
  name = 'feishu';
  private deps: FeishuChannelDeps;
  private connected = false;
  private botOpenId: string | undefined;
  private seenMessageIds = new Set<string>();

  constructor(
    private channelOpts: ChannelOpts,
    options: FeishuChannelOptions,
  ) {
    const { appId, appSecret, domain, deps } = options;
    const brand = resolveDomain(domain);
    this.deps = deps ?? defaultDeps(appId, appSecret, brand);

    this.deps.dispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        this.handleInbound(data as MaybeEventEnvelope);
      },
      'im.chat.member.bot.added_v1': async (data: unknown) => {
        this.handleBotAdded(data as MaybeBotAddedEnvelope);
      },
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async connect(): Promise<void> {
    try {
      const res = (await this.deps.client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      })) as { bot?: { open_id?: string } } | undefined;
      this.botOpenId = res?.bot?.open_id;
    } catch (err) {
      console.error('[feishu] failed to resolve bot identity:', err);
    }
    await this.deps.wsClient.start({ eventDispatcher: this.deps.dispatcher });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    // @larksuiteoapi/node-sdk WSClient has no public stop(); connection closes
    // with the process. Toggling state is sufficient for nanoclaw's lifecycle.
    this.connected = false;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = this.extractChatId(jid);
    const content = JSON.stringify({
      zh_cn: { content: [[{ tag: 'md', text }]] },
    });
    await this.deps.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'post',
        content,
      },
    });
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Feishu has no public typing-indicator API.
  }

  private extractChatId(jid: string): string {
    return jid.replace(/^feishu:/, '');
  }

  private handleInbound(data: MaybeEventEnvelope): void {
    const event: FeishuMessageEvent | undefined =
      (data as { event?: FeishuMessageEvent })?.event ??
      (data as FeishuMessageEvent);
    const msg = event?.message;
    if (!msg || !msg.chat_id || !msg.message_id) return;

    // Dedup: @larksuiteoapi/node-sdk may deliver the same event twice
    // when WebSocket reconnects; guard here to avoid double-dispatch.
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.seenMessageIds.add(msg.message_id);
    if (this.seenMessageIds.size > 1000) {
      const first = this.seenMessageIds.values().next().value;
      if (first) this.seenMessageIds.delete(first);
    }

    const jid = `feishu:${msg.chat_id}`;
    const senderOpenId = event?.sender?.sender_id?.open_id ?? '';
    const rawText = this.extractText(msg);
    const content = this.stripBotMention(rawText, msg.mentions);
    const chatType: 'p2p' | 'group' = msg.chat_type === 'p2p' ? 'p2p' : 'group';

    const timestamp = this.parseTimestamp(msg.create_time);
    const normalized: NewMessage = {
      id: msg.message_id,
      chat_jid: jid,
      sender: senderOpenId,
      sender_name: '',
      content,
      timestamp,
      chat_type: chatType,
    };
    if (msg.parent_id) normalized.reply_to_message_id = msg.parent_id;
    if (senderOpenId && this.botOpenId && senderOpenId === this.botOpenId) {
      normalized.is_from_me = true;
    }

    // Fallback discovery: p2p chats have no "bot added" event (the chat
    // springs into existence when someone first DMs the bot), and groups
    // can also slip through if NanoClaw was offline when bot.added fired.
    // Host's onChatDiscovered is idempotent — calling it on every inbound
    // is fine and is the simplest way to never miss a chat.
    this.channelOpts.onChatDiscovered?.({
      jid,
      chatType,
      // No name available from a message event. Host will fall back to
      // a sensible default (sender name for p2p, chat_id for group).
    });

    console.log(
      `[feishu] inbound chat_id=${msg.chat_id} msg_id=${msg.message_id}`,
    );
    this.channelOpts.onMessage(jid, normalized);
  }

  /**
   * `im.chat.member.bot.added_v1` — fires when the bot is added to a group
   * chat. Gives us the chat name up front, which is otherwise not in the
   * message event payload.
   */
  private handleBotAdded(data: MaybeBotAddedEnvelope): void {
    const evt: FeishuBotAddedEvent | undefined =
      (data as { event?: FeishuBotAddedEvent })?.event ??
      (data as FeishuBotAddedEvent);
    if (!evt?.chat_id) return;
    console.log(
      `[feishu] bot added to chat_id=${evt.chat_id} name=${evt.name ?? '?'} external=${evt.external ?? false}`,
    );
    this.channelOpts.onChatDiscovered?.({
      jid: `feishu:${evt.chat_id}`,
      name: evt.name,
      chatType: 'group',
    });
  }

  private parseTimestamp(createTime: string | undefined): string {
    if (!createTime) return new Date().toISOString();
    const num = Number(createTime);
    if (!Number.isFinite(num) || num <= 0) return new Date().toISOString();
    return new Date(num).toISOString();
  }

  private extractText(msg: FeishuMessage): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      return msg.content ?? '';
    }
    const content = parsed as Record<string, unknown>;
    switch (msg.message_type) {
      case 'text':
        return typeof content.text === 'string' ? content.text : '';
      case 'post':
        return this.flattenPost(content);
      case 'image':
        return '[image]';
      case 'file': {
        const name =
          typeof content.file_name === 'string' ? content.file_name : '';
        return name ? `[file:${name}]` : '[file]';
      }
      case 'audio':
        return '[audio]';
      case 'media':
        return '[media]';
      case 'sticker':
        return '[sticker]';
      default:
        return JSON.stringify(content);
    }
  }

  private flattenPost(content: Record<string, unknown>): string {
    const lines: string[] = [];
    const title = content.title;
    if (typeof title === 'string' && title.length > 0) lines.push(title);
    const blocks = content.content;
    if (Array.isArray(blocks)) {
      for (const paragraph of blocks) {
        if (!Array.isArray(paragraph)) continue;
        const text = paragraph
          .map((element) => {
            if (element && typeof element === 'object') {
              const el = element as { text?: unknown; user_name?: unknown };
              if (typeof el.text === 'string') return el.text;
              if (typeof el.user_name === 'string') return `@${el.user_name}`;
            }
            return '';
          })
          .join('');
        lines.push(text);
      }
    }
    return lines.join('\n').trim();
  }

  private stripBotMention(
    text: string,
    mentions: FeishuMention[] | undefined,
  ): string {
    if (!mentions || mentions.length === 0) return text;
    let out = text;
    for (const mention of mentions) {
      const mentionOpenId = mention.id?.open_id;
      if (!mention.key || !mentionOpenId) continue;
      if (this.botOpenId && mentionOpenId === this.botOpenId) {
        // Substitute the Feishu placeholder (e.g. "@_user_1") with the
        // assistant's text-form name so the trigger regex (`^@<name>\b`)
        // can match downstream. Don't strip — that would silently break
        // every non-main group's trigger detection.
        out = out.split(mention.key).join(`@${ASSISTANT_NAME}`);
      } else if (mention.name) {
        out = out.split(mention.key).join(`@${mention.name}`);
      }
    }
    return out.trim();
  }
}

registerChannel('feishu', (opts) => {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  const domain = process.env.FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu';
  return new FeishuChannel(opts, { appId, appSecret, domain });
});
