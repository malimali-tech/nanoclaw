import { Channel, NewMessage, StreamHandle } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

/**
 * Send a one-shot message via the channel that owns `jid`. Used by paths that
 * are NOT inside an agent turn (e.g. the task scheduler firing a reminder),
 * where there is no active stream to append to.
 *
 * Agent turn output goes through `Channel.openStream` instead.
 */
export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Open a streaming handle for `jid`. Throws if no connected channel owns
 * the JID or the owning channel doesn't implement `openStream` — by design
 * agent output is streaming-only, so a missing handle is a configuration
 * error worth surfacing rather than silently dropping.
 */
export async function openStream(
  channels: Channel[],
  jid: string,
): Promise<StreamHandle> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No connected channel for JID: ${jid}`);
  if (!channel.openStream) {
    throw new Error(
      `Channel "${channel.name}" does not implement openStream — streaming output is required`,
    );
  }
  return channel.openStream(jid);
}
