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
import { resolveGroupFolderPath } from './group-folder.js';
import {
  appendMessage,
  flushWrites,
  getLastBotTimestamp,
  readCursor,
  readMessagesSince,
  writeCursor,
} from './group-log.js';
import { findChannel, formatMessages, routeOutbound } from './router.js';
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
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { configureAgent, handleMessage, shutdownAgent } from './agent/run.js';
import type { GroupRegistryPort, RouterPort } from './agent/types.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let registeredGroups: Record<string, RegisteredGroup> = {};
/** Per-group processing cursor (last message timestamp handed to the agent). */
const cursors: Record<string, string> = {};
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

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

function botMessageId(): string {
  return `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Process all pending messages for a group via the in-process pi agent.
 * Returns true on success (or no-op), false if the agent errored and the
 * cursor should not advance.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

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

  // For non-main groups, check if trigger is required and present
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

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor before dispatch so concurrent loop iterations don't
  // re-pick up these messages. Roll back if the agent errors before any
  // output reached the user.
  const previousCursor = cursors[chatJid] ?? '';
  const newCursor = missedMessages[missedMessages.length - 1].timestamp;
  cursors[chatJid] = newCursor;
  await writeCursor(group.folder, newCursor).catch((err) =>
    logger.warn({ chatJid, err }, 'writeCursor failed'),
  );

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  await channel.setTyping?.(chatJid, true);
  try {
    await handleMessage({
      groupFolder: group.folder,
      chatJid,
      isMain: isMainGroup,
      text: prompt,
    });
    return true;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    // Roll back cursor so retries can re-process these messages
    cursors[chatJid] = previousCursor;
    await writeCursor(group.folder, previousCursor).catch(() => {});
    return false;
  } finally {
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

      // Only registered groups have a log; everything else is dropped.
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
  };

  const groupRegistryPort: GroupRegistryPort = {
    register: (req) => {
      const group: RegisteredGroup = {
        name: req.name,
        folder: req.folder,
        trigger: req.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: req.requiresTrigger,
      };
      registerGroup(req.jid, group);
    },
  };

  const taskSchedulerPort = makeTaskSchedulerPort();

  configureAgent({
    router: routerPort,
    taskScheduler: taskSchedulerPort,
    groupRegistry: groupRegistryPort,
    channels,
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    ports: {
      router: routerPort,
      taskScheduler: taskSchedulerPort,
      groupRegistry: groupRegistryPort,
      channels,
    },
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
