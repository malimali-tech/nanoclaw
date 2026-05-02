// src/agent/run.ts
import path from 'path';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
  loadSkillsFromDir,
  type AgentSession,
  type SessionInfo,
  type Skill,
} from '@mariozechner/pi-coding-agent';
import { GROUPS_DIR } from '../config.js';
import { errMsg, logger } from '../logger.js';
import { openStream as openChannelStream } from '../router.js';
import type { StreamHandle } from '../types.js';
import { SerialChain } from '../util/serial-chain.js';
import type { StreamRef } from './types.js';
import { chatSkillsDirs } from './global-skills.js';
import { SessionPool, type DisposableSession } from './session-pool.js';
import {
  disposeChatRuntime,
  initToolRuntime,
  shutdownToolRuntime,
} from './tool-runtime.js';
import { nanoclawExtension } from './extension.js';
import { resolveModel } from './model.js';
import type { ExtensionCtx } from './types.js';

const IDLE_MS_RAW = parseInt(process.env.NANOCLAW_AGENT_IDLE_TTL_MS ?? '', 10);
const IDLE_MS =
  Number.isFinite(IDLE_MS_RAW) && IDLE_MS_RAW > 0 ? IDLE_MS_RAW : 600000;
const log = (m: string) => logger.info(`[agent] ${m}`);

// Skills are sourced per-chat from `groups/global/skills/` (shared) and
// `groups/<folder>/skills/` (chat-private). The host user's
// `~/.agents/skills/` is no longer a default source — see global-skills.ts
// for the rationale. Path-guard and container-mounts read from the same
// helper so all three layers see the same list.

interface PooledSession extends DisposableSession {
  session: AgentSession;
  /** Mutable handle reference shared with `ExtensionCtx.streamRef` so tools
   *  (notably `send_message`) can append into the same stream the agent's
   *  `text_delta` events feed. Lazily opened on the first event of a turn,
   *  cleared on `endTurn`. */
  streamRef: StreamRef;
  /** Memoized "we already tried to open a stream this turn" — avoids
   *  retrying the channel on every event when openStream throws. Reset on
   *  `endTurn`. */
  streamProbed: boolean;
  /** Serializes stream appends and finalize so they hit the channel in the
   *  same order the events arrived from pi-agent. */
  sendChain: SerialChain;
}

type SharedPorts = Pick<
  ExtensionCtx,
  'router' | 'taskScheduler' | 'groupRegistry' | 'channels'
>;

/**
 * Initialize the tool runtime exactly once. Must be awaited before any
 * AgentSession is built — both the message loop and the task scheduler
 * depend on the runtime being ready before they spawn the first session.
 *
 * Idempotent. Backwards-compatible name (used to be `ensureSandbox`).
 */
export async function ensureSandbox(): Promise<void> {
  await initToolRuntime();
}

/**
 * Build the `skillsOverride` callback for one chat. Pi's `cwd` scan
 * lives at `groups/<folder>/`, which already includes `skills/` as a
 * subdirectory of the cwd — but pi only auto-loads from `<cwd>/.pi/skills/`
 * and `<cwd>/.skills/`, not arbitrary `<cwd>/skills/`. So we explicitly
 * surface `groups/global/skills/` and `groups/<folder>/skills/` here.
 *
 * Name collisions: pi's defaults win (consistent with pi's own policy
 * — first-seen keeps the slot). Within our extras, the first dir
 * returned by `chatSkillsDirs` (chat-private) wins over later ones
 * (shared), letting a chat shadow a shared skill with a local override.
 */
function makeSkillsMerger(groupFolder: string, isMain: boolean) {
  return (base: {
    skills: Skill[];
    diagnostics: ReturnType<typeof loadSkillsFromDir>['diagnostics'];
  }): {
    skills: Skill[];
    diagnostics: ReturnType<typeof loadSkillsFromDir>['diagnostics'];
  } => {
    const seen = new Set(base.skills.map((s) => s.name));
    const merged = [...base.skills];
    const diagnostics = [...base.diagnostics];
    for (const dir of chatSkillsDirs(groupFolder, isMain)) {
      const extra = loadSkillsFromDir({ dir, source: 'user' });
      diagnostics.push(...extra.diagnostics);
      for (const s of extra.skills) {
        if (seen.has(s.name)) continue;
        merged.push(s);
        seen.add(s.name);
      }
    }
    return { skills: merged, diagnostics };
  };
}

function buildCtx(args: {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  ports: SharedPorts;
  streamRef: StreamRef;
}): ExtensionCtx {
  return {
    ...args.ports,
    groupFolder: args.groupFolder,
    chatJid: args.chatJid,
    isMain: args.isMain,
    streamRef: args.streamRef,
  };
}

/**
 * Per-chat next-session override. Set by /new (→ "fresh") or /resume
 * (→ { resume: <sessionFile> }) right before evicting the pool entry. The
 * factory reads + clears this map so the next `getOrCreate` for that key
 * builds a session against the requested file instead of the default
 * `continueRecent` lookup.
 */
type SessionInit = 'fresh' | { resume: string };
const pendingSessionInit = new Map<string, SessionInit>();

async function buildSession(
  ctx: ExtensionCtx,
  init: SessionInit | undefined,
): Promise<PooledSession> {
  const groupCwd = path.join(GROUPS_DIR, ctx.groupFolder);
  await initToolRuntime();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const loader = new DefaultResourceLoader({
    cwd: groupCwd,
    agentDir: getAgentDir(),
    extensionFactories: [nanoclawExtension(ctx)],
    skillsOverride: makeSkillsMerger(ctx.groupFolder, ctx.isMain),
  });
  await loader.reload();

  const model = resolveModel(modelRegistry);
  if (model) log(`using model: ${model.provider}/${model.id}`);
  const sessionManager =
    init === 'fresh'
      ? SessionManager.create(groupCwd)
      : init && typeof init === 'object'
        ? SessionManager.open(init.resume, undefined, groupCwd)
        : SessionManager.continueRecent(groupCwd);
  const { session } = await createAgentSession({
    cwd: groupCwd,
    sessionManager,
    resourceLoader: loader,
    authStorage,
    modelRegistry,
    model,
  });

  const pooled: PooledSession = {
    session,
    streamRef: ctx.streamRef,
    streamProbed: false,
    sendChain: new SerialChain(),
    dispose: async () => {
      await pooled.sendChain.drain();
      await endTurn(pooled, 'aborted');
      session.dispose();
      // Tear down the chat's container (no-op in non-docker modes). Done
      // after session.dispose so any final tool calls have already settled.
      disposeChatRuntime(ctx.groupFolder);
    },
  };

  // Helper: serialize `fn` onto the sendChain after lazily ensuring the
  // stream is open. Failures (open or per-call) are logged and swallowed —
  // pi-agent must keep advancing even if the channel hiccups.
  const onStream = (
    label: string,
    fn: (s: StreamHandle) => Promise<void>,
  ): void => {
    void pooled.sendChain.run(async () => {
      const stream = await ensureStream(pooled, ctx);
      if (!stream) return;
      try {
        await fn(stream);
      } catch (err) {
        log(`${label} failed: ${errMsg(err)}`);
      }
    });
  };

  session.subscribe((event) => {
    if (event.type === 'message_update') {
      const ame = event.assistantMessageEvent;
      if (ame.type === 'text_delta') {
        onStream('appendText', (s) => s.appendText(ame.delta));
      } else if (ame.type === 'thinking_delta') {
        onStream('appendReasoning', (s) => s.appendReasoning(ame.delta));
      }
    } else if (event.type === 'tool_execution_start') {
      const { toolCallId, toolName, args } = event;
      onStream('appendToolUse', (s) =>
        s.appendToolUse(toolCallId, toolName, args),
      );
    } else if (event.type === 'tool_execution_end') {
      const { toolCallId, toolName, result, isError } = event;
      onStream('appendToolResult', (s) =>
        s.appendToolResult(toolCallId, toolName, result, isError),
      );
    } else if (event.type === 'agent_end') {
      // Finalize on agent_end (prompt boundary), NOT turn_end. A single user
      // prompt can produce multiple turns when the model takes a tool-call
      // loop; finalizing per turn would close the card mid-conversation and
      // open a fresh one for the next turn — the "two cards per reply" bug.
      void pooled.sendChain.run(() => endTurn(pooled, 'normal'));
    }
  });

  return pooled;
}

/**
 * Lazily open the per-turn stream on the first event that wants one. Returns
 * null (and remembers it via `streamProbed`) when the channel can't supply
 * a stream — subsequent events for that turn become no-ops rather than
 * spamming retries. The next turn re-probes after `endTurn` clears the flag.
 */
async function ensureStream(
  p: PooledSession,
  ctx: ExtensionCtx,
): Promise<StreamHandle | null> {
  if (p.streamRef.current) return p.streamRef.current;
  if (p.streamProbed) return null;
  p.streamProbed = true;
  try {
    const handle = await openChannelStream(ctx.channels, ctx.chatJid);
    p.streamRef.current = handle;
    return handle;
  } catch (err) {
    log(`openStream failed: ${errMsg(err)}`);
    return null;
  }
}

/** Finalize the open stream (if any) and reset turn-local state. */
async function endTurn(
  p: PooledSession,
  reason: 'normal' | 'aborted' | 'error',
): Promise<void> {
  const stream = p.streamRef.current;
  p.streamRef.current = null;
  p.streamProbed = false;
  if (!stream) return;
  try {
    await stream.finalize({ reason });
  } catch (err) {
    log(`stream.finalize failed: ${errMsg(err)}`);
  }
}

let pool: SessionPool<PooledSession> | null = null;

export function configureAgent(ports: SharedPorts): void {
  pool = new SessionPool<PooledSession>({
    factory: async (key) => {
      const [groupFolder, chatJid, isMain] = JSON.parse(key) as [
        string,
        string,
        boolean,
      ];
      const streamRef: StreamRef = { current: null };
      const ctx = buildCtx({ groupFolder, chatJid, isMain, ports, streamRef });
      const init = pendingSessionInit.get(key);
      pendingSessionInit.delete(key);
      return buildSession(ctx, init);
    },
    idleMs: IDLE_MS,
  });
}

export async function handleMessage(args: {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  text: string;
}): Promise<void> {
  if (!pool) {
    throw new Error('agent not configured; call configureAgent first');
  }
  const key = JSON.stringify([args.groupFolder, args.chatJid, args.isMain]);
  const pooled = await pool.getOrCreate(key);
  await pooled.session.prompt(args.text, { streamingBehavior: 'steer' });
}

export async function shutdownAgent(): Promise<void> {
  if (pool) await pool.disposeAll();
  pool = null;
  await shutdownToolRuntime();
}

/**
 * Start a fresh pi session for this chat. Mirrors pi's `/new` semantics:
 * the next message opens a brand new session jsonl alongside any prior
 * ones (which remain on disk and are reachable via `/resume`). The
 * pooled AgentSession + docker container are torn down so the next
 * `handleMessage` rebuilds against the new session.
 */
export async function newChatSession(
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
): Promise<void> {
  if (!pool) throw new Error('agent not configured');
  const key = JSON.stringify([groupFolder, chatJid, isMain]);
  pendingSessionInit.set(key, 'fresh');
  await pool.evict(key);
}

/** Recent pi sessions on disk for this chat, newest first. */
export async function listChatSessions(
  groupFolder: string,
  limit = 10,
): Promise<SessionInfo[]> {
  const groupCwd = path.join(GROUPS_DIR, groupFolder);
  const sessions = await SessionManager.list(groupCwd);
  return sessions.slice(0, limit);
}

/**
 * Resume a specific session jsonl. Evicts the pooled session so the next
 * message rebuilds against the chosen file. Mirrors pi's `/resume`.
 */
export async function resumeChatSession(
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
  sessionFile: string,
): Promise<void> {
  if (!pool) throw new Error('agent not configured');
  const key = JSON.stringify([groupFolder, chatJid, isMain]);
  pendingSessionInit.set(key, { resume: sessionFile });
  await pool.evict(key);
}

/**
 * Manually trigger a compaction on the chat's active AgentSession. If no
 * session is currently pooled, creates one (which loads existing context
 * from disk). Returns the pre-compaction token count so the caller can
 * format a confirmation message.
 */
export async function compactChatSession(
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
  customInstructions?: string,
): Promise<{ tokensBefore: number; summary: string }> {
  if (!pool) throw new Error('agent not configured');
  const key = JSON.stringify([groupFolder, chatJid, isMain]);
  const pooled = await pool.getOrCreate(key);
  const result = await pooled.session.compact(customInstructions);
  return { tokensBefore: result.tokensBefore, summary: result.summary };
}

export interface ChatSessionStats {
  totalMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  contextWindow?: number;
  contextPercent?: number;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

/**
 * Read-only snapshot of the chat's current context state. Loads / creates
 * the pool entry as a side effect (cheap if already warm).
 *
 * Token totals are cumulative across the entire session jsonl (all
 * branches, including pre-compaction history) to match the pi-coding-agent
 * interactive footer — see footer.ts:75.
 */
export async function getChatSessionStats(
  groupFolder: string,
  chatJid: string,
  isMain: boolean,
): Promise<ChatSessionStats> {
  if (!pool) throw new Error('agent not configured');
  const key = JSON.stringify([groupFolder, chatJid, isMain]);
  const pooled = await pool.getOrCreate(key);
  const session = pooled.session;

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      input += entry.message.usage.input;
      output += entry.message.usage.output;
      cacheRead += entry.message.usage.cacheRead;
      cacheWrite += entry.message.usage.cacheWrite;
      cost += entry.message.usage.cost.total;
    }
  }

  const ctx = session.getContextUsage();
  const state = session.state;
  const stats = session.getSessionStats();
  return {
    totalMessages: stats.totalMessages,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost,
    contextWindow: ctx?.contextWindow ?? state.model?.contextWindow,
    contextPercent: ctx?.percent ?? undefined,
    modelProvider: state.model?.provider,
    modelId: state.model?.id,
    thinkingLevel: state.model?.reasoning ? state.thinkingLevel : undefined,
  };
}
