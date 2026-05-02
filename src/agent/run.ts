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
import { logger } from '../logger.js';
import { chatSkillsDirs } from './global-skills.js';
import { SessionPool, type DisposableSession } from './session-pool.js';
import { StreamRenderer } from './stream-renderer.js';
import {
  disposeChatRuntime,
  initToolRuntime,
  shutdownToolRuntime,
} from './tool-runtime.js';
import { nanoclawExtension } from './extension.js';
import { resolveModel } from './model.js';
import {
  buildExtensionCtx,
  type ExtensionCtx,
  type ExtensionPorts,
} from './types.js';

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
  renderer: StreamRenderer;
}

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
  ports: ExtensionPorts,
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

  const renderer = new StreamRenderer({
    session,
    openStream: () => ports.router.openStream(ctx.chatJid),
  });

  const pooled: PooledSession = {
    session,
    renderer,
    dispose: async () => {
      await renderer.abort();
      session.dispose();
      // Tear down the chat's container (no-op in non-docker modes). Done
      // after session.dispose so any final tool calls have already settled.
      disposeChatRuntime(ctx.groupFolder);
    },
  };

  return pooled;
}

let pool: SessionPool<PooledSession> | null = null;

export function configureAgent(ports: ExtensionPorts): void {
  pool = new SessionPool<PooledSession>({
    factory: async (key) => {
      const [groupFolder, chatJid, isMain] = JSON.parse(key) as [
        string,
        string,
        boolean,
      ];
      const ctx = buildExtensionCtx({ ports, groupFolder, chatJid, isMain });
      const init = pendingSessionInit.get(key);
      pendingSessionInit.delete(key);
      return buildSession(ctx, ports, init);
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
  pool.markActive(key);
  try {
    await pooled.session.prompt(args.text, { streamingBehavior: 'steer' });
  } finally {
    pool.markIdle(key);
  }
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
