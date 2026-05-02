import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  getAllRegisteredGroups,
  initDatabase,
  setRegisteredGroup,
} from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import {
  appendMessage,
  flushWrites,
  getLastBotTimestamp,
  readCursor,
  readMessagesSince,
  writeCursor,
} from './group-log.js';
import {
  findChannel,
  formatMessages,
  openStream as openChannelStream,
  routeOutbound,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { makeTaskSchedulerPort, startSchedulerLoop } from './task-scheduler.js';
import {
  ChatDiscovery,
  Channel,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import {
  configureAgent,
  ensureSandbox,
  handleMessage,
  shutdownAgent,
} from './agent/run.js';
import { reapOrphanContainers } from './agent/tool-runtime.js';
import type { RouterPort } from './agent/types.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let registeredGroups: Record<string, RegisteredGroup> = {};
/** Per-group processing cursor (last message timestamp handed to the agent). */
const cursors: Record<string, string> = {};
/** Chats currently being processed by handleMessage. Prevents the polling
 *  loop from dispatching a second concurrent agent run for the same chat
 *  while the first is still in flight — necessary because cursor advance
 *  is deferred until after the agent commits, so the same `missed` window
 *  is visible to subsequent loop iterations until then. */
const inFlightChats = new Set<string>();
let messageLoopRunning = false;

const channels: Channel[] = [];

function loadState(): void {
  registeredGroups = getAllRegisteredGroups();
  for (const [jid, group] of Object.entries(registeredGroups)) {
    const fromDisk = readCursor(group.folder);
    if (fromDisk) cursors[jid] = fromDisk;
  }
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if cursor.json is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = cursors[chatJid];
  if (existing) return existing;

  const group = registeredGroups[chatJid];
  if (!group) return '';

  const fromLog = getLastBotTimestamp(group.folder);
  if (fromLog) {
    logger.info(
      { chatJid, recoveredFrom: fromLog },
      'Recovered message cursor from last bot reply in log.jsonl',
    );
    cursors[chatJid] = fromLog;
    void writeCursor(group.folder, fromLog).catch(() => {});
    return fromLog;
  }
  return '';
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Seed CLAUDE.md from the user's template if present, otherwise from the
  // shipped default — `groups/` is gitignored so a fresh clone has no user
  // template.
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const userTemplate = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    const defaultTemplate = path.join(
      process.cwd(),
      'defaults',
      'group-claude.md',
    );
    let templateFile: string | null = null;
    if (fs.existsSync(userTemplate)) templateFile = userTemplate;
    else if (fs.existsSync(defaultTemplate)) templateFile = defaultTemplate;
    if (templateFile) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info(
        {
          folder: group.folder,
          source: templateFile === defaultTemplate ? 'defaults' : 'user',
        },
        'Created CLAUDE.md from template',
      );
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function botMessageId(): string {
  return `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Derive a stable, filesystem-safe group folder name from a chat JID.
 * Examples:
 *   feishu:oc_3e6b3a40...  →  oc_3e6b3a40...
 *   feishu:p2p_xxx         →  p2p_xxx
 *
 * The chat-id portion of a Feishu JID already satisfies
 * isValidGroupFolder's regex (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`), so we
 * use it as-is. Sanitize defensively for any character a future channel
 * might emit; reject "global" (reserved) at validation time upstream.
 */
function deriveFolderFromJid(jid: string): string {
  const tail = jid.includes(':') ? jid.slice(jid.indexOf(':') + 1) : jid;
  return tail.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Process all pending messages for a group via the in-process pi agent.
 * Returns true on success (or no-op), false if the agent errored and the
 * cursor should not advance.
 *
 * Cursor semantics: advance ONLY after the agent successfully finished
 * the prompt (session.prompt() resolves). On agent error or writeCursor
 * failure, the cursor stays put so the next poll re-processes the batch.
 * Per-chat concurrency is limited to 1 via `inFlightChats` so the polling
 * loop doesn't dispatch a duplicate run while the first is still working.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  if (inFlightChats.has(chatJid)) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const cursor = getOrRecoverCursor(chatJid);
  const missedMessages = readMessagesSince(
    group.folder,
    cursor,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // Slash command short-circuit. When the LAST missed message is a `/cmd`,
  // pass it through to pi VERBATIM (no `<context>/<messages>` envelope) so
  // pi's `_tryExecuteExtensionCommand` can dispatch it to an
  // extension-registered handler. Unknown slashes fall through to the LLM
  // as plain text. Earlier missed messages in the batch are discarded —
  // a slash from the user supersedes chatter that preceded it.
  const lastMsg = missedMessages[missedMessages.length - 1];
  const stripped = lastMsg.content
    .replace(getTriggerPattern(group.trigger), '')
    .trim();
  const isSlash = /^\/\w/.test(stripped);

  const prompt = isSlash ? stripped : formatMessages(missedMessages, TIMEZONE);
  const newCursor = missedMessages[missedMessages.length - 1].timestamp;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  inFlightChats.add(chatJid);
  await channel.setTyping?.(chatJid, true);
  try {
    await handleMessage({
      groupFolder: group.folder,
      chatJid,
      isMain: isMainGroup,
      text: prompt,
    });
    // Agent succeeded → persist cursor on disk, then in memory. If
    // writeCursor throws we leave both in their old state so the next poll
    // retries; the cost is a duplicate reply, which is preferable to
    // silently desyncing memory and disk.
    try {
      await writeCursor(group.folder, newCursor);
      cursors[chatJid] = newCursor;
    } catch (err) {
      logger.error(
        { chatJid, err },
        'writeCursor failed after successful agent run; cursor not advanced',
      );
    }
    return true;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return false;
  } finally {
    inFlightChats.delete(chatJid);
    await channel.setTyping?.(chatJid, false).catch(() => {});
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      // Make sure any in-flight inbound appends are flushed before reading
      await flushWrites();

      for (const chatJid of Object.keys(registeredGroups)) {
        const group = registeredGroups[chatJid];
        if (!group) continue;

        const cursor = getOrRecoverCursor(chatJid);
        const missed = readMessagesSince(
          group.folder,
          cursor,
          MAX_MESSAGES_PER_PROMPT,
        );
        if (missed.length === 0) continue;

        const isMainGroup = group.isMain === true;
        if (!isMainGroup && group.requiresTrigger !== false) {
          const triggerPattern = getTriggerPattern(group.trigger);
          const allowlistCfg = loadSenderAllowlist();
          const hasTrigger = missed.some(
            (m) =>
              triggerPattern.test(m.content.trim()) &&
              (m.is_from_me ||
                isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
          );
          if (!hasTrigger) continue;
        }

        // Dispatch to the in-process agent. processGroupMessages handles
        // formatting, cursor advancement, and rollback on error.
        processGroupMessages(chatJid).catch((err) =>
          logger.error({ chatJid, err }, 'processGroupMessages failed'),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between message append and cursor advancement.
 */
async function recoverPendingMessages(): Promise<void> {
  await flushWrites();
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const cursor = getOrRecoverCursor(chatJid);
    const pending = readMessagesSince(
      group.folder,
      cursor,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      processGroupMessages(chatJid).catch((err) =>
        logger.error({ chatJid, err }, 'recovery processGroupMessages failed'),
      );
    }
  }
}

async function main(): Promise<void> {
  // Migrate legacy chats/messages tables → per-group jsonl before initDatabase
  // drops them. Idempotent: on subsequent starts the tables are gone and this
  // is a no-op.
  const { migrateDbToJsonl } = await import('./migrations.js');
  const report = await migrateDbToJsonl();
  if (report.migrated && report.rowsWritten > 0) {
    logger.info({ ...report }, 'Migrated legacy DB messages to log.jsonl');
  }

  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Initialize sandbox before any AgentSession is created. Both the message
  // loop and the task scheduler rely on the global SandboxManager state +
  // wrapped bash ops being ready before they spawn the first session.
  await ensureSandbox();

  // After registered groups are loaded and the runtime is ready, reap any
  // docker container left over from a previous run whose chat is no longer
  // registered (manually removed group, renamed folder, etc.).
  reapOrphanContainers(Object.values(registeredGroups).map((g) => g.folder));

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await shutdownAgent();
    await flushWrites();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  /**
   * Idempotent auto-registration on chat discovery. Implements the "open
   * provisioning" decision from the brainstorm (Q1=A + Q3=A): every chat the
   * bot can see becomes a registered group on first sight, no human approval
   * required. Sender allowlist still gates who is allowed to *trigger* the
   * agent — registration just opens the channel for that gating to apply.
   *
   * Folder name is derived from the JID (e.g. `feishu:oc_xxx` → `oc_xxx`)
   * so it's stable across NanoClaw restarts and matches what Docker mounts
   * see (chat_id → /workspace/group).
   */
  const autoRegister = (discovery: ChatDiscovery): void => {
    if (registeredGroups[discovery.jid]) return;
    const folder = deriveFolderFromJid(discovery.jid);
    if (!isValidGroupFolder(folder)) {
      logger.warn(
        { jid: discovery.jid, folder },
        'auto-register: derived folder is invalid; skipping',
      );
      return;
    }
    const group: RegisteredGroup = {
      name: discovery.name ?? `${discovery.chatType}:${discovery.jid}`,
      folder,
      trigger: DEFAULT_TRIGGER,
      added_at: new Date().toISOString(),
      // p2p chats: bot is the only counterparty, every message is for it.
      // Group chats: keep the trigger so we don't reply to every line.
      requiresTrigger: discovery.chatType === 'group',
      isMain: false,
    };
    logger.info(
      {
        jid: discovery.jid,
        folder,
        chatType: discovery.chatType,
        name: group.name,
      },
      'auto-registering chat (open provisioning)',
    );
    registerGroup(discovery.jid, group);
  };

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Auto-register fallback: if the channel didn't fire onChatDiscovered
      // for some reason (older channels, missed event), use the message
      // itself as the discovery signal. The chat_type from the message tells
      // us whether to treat it as p2p or group.
      if (!registeredGroups[chatJid]) {
        autoRegister({
          jid: chatJid,
          name: msg.sender_name || undefined,
          chatType: msg.chat_type ?? 'group',
        });
      }
      const group = registeredGroups[chatJid];
      if (!group) return;

      // Sender allowlist drop mode: discard messages from denied senders
      // before appending so they never enter context or trigger checks.
      if (!msg.is_from_me && !msg.is_bot_message) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }

      appendMessage(group.folder, msg).catch((err) =>
        logger.error({ err, chatJid }, 'group-log appendMessage failed'),
      );
    },
    registeredGroups: () => registeredGroups,
    onChatDiscovered: autoRegister,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Wire ports for the in-process pi agent. The router port routes outbound
  // text to the right channel AND mirrors the bot's reply into the group's
  // log.jsonl so future cursor recovery can locate it.
  const routerPort: RouterPort = {
    send: async (jid, text, sender) => {
      await routeOutbound(channels, jid, text);
      const group = registeredGroups[jid];
      if (group) {
        await appendMessage(group.folder, {
          id: botMessageId(),
          chat_jid: jid,
          sender: 'bot',
          sender_name: sender ?? ASSISTANT_NAME,
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: true,
        }).catch((err) =>
          logger.error(
            { err, chatJid: jid },
            'group-log append (bot reply) failed',
          ),
        );
      }
    },
    openStream: (jid) => openChannelStream(channels, jid),
  };

  const taskSchedulerPort = makeTaskSchedulerPort();

  const ports = {
    router: routerPort,
    taskScheduler: taskSchedulerPort,
  };

  configureAgent(ports);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    ports,
  });
  await recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
