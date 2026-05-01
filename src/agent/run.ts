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
  type Skill,
} from '@mariozechner/pi-coding-agent';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { openStream as openChannelStream } from '../router.js';
import type { StreamHandle } from '../types.js';
import { globalSkillsDirs } from './global-skills.js';
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

// Global skills directories live in src/agent/global-skills.ts so the
// path-guard and container-mount layers see the same list. Pi's default
// scan already covers `~/.pi/agent/skills/` and `<cwd>/.pi/skills/`; we
// add `~/.agents/skills/` (where `npx skills` installs) on top.

interface PooledSession extends DisposableSession {
  session: AgentSession;
  /** Buffer used when the owning channel has no `openStream` support. Emitted
   *  as a single `router.send` on `turn_end`/`agent_end`. */
  routerBuffer: string;
  /** Per-turn streaming handle, opened lazily on first event of a turn when
   *  the owning channel implements `Channel.openStream`. Null otherwise. */
  currentStream: StreamHandle | null;
  /** Memoized "did we try to open a stream for this turn?" — avoids re-asking
   *  the channel on every event when streaming isn't supported. Reset on
   *  finalize. */
  streamProbed: boolean;
  /** Serializes outbound writes (stream appends + finalize + buffer flush) so
   *  ordering matches the order events arrive in. */
  sendChain: Promise<void>;
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
 * Append skills from every directory returned by `globalSkillsDirs()` to
 * whatever pi loaded by default. Name collisions: pi's defaults win
 * (consistent with pi's own collision policy — first-seen keeps the slot).
 * Used as the `skillsOverride` callback on every DefaultResourceLoader.
 */
function mergeGlobalSkills(base: {
  skills: Skill[];
  diagnostics: ReturnType<typeof loadSkillsFromDir>['diagnostics'];
}): {
  skills: Skill[];
  diagnostics: ReturnType<typeof loadSkillsFromDir>['diagnostics'];
} {
  const seen = new Set(base.skills.map((s) => s.name));
  const merged = [...base.skills];
  const diagnostics = [...base.diagnostics];
  for (const dir of globalSkillsDirs()) {
    const extra = loadSkillsFromDir({ dir, source: 'user' });
    diagnostics.push(...extra.diagnostics);
    for (const s of extra.skills) {
      if (seen.has(s.name)) continue;
      merged.push(s);
      seen.add(s.name);
    }
  }
  return { skills: merged, diagnostics };
}

function buildCtx(args: {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  ports: SharedPorts;
}): ExtensionCtx {
  return {
    ...args.ports,
    groupFolder: args.groupFolder,
    chatJid: args.chatJid,
    isMain: args.isMain,
  };
}

async function buildSession(ctx: ExtensionCtx): Promise<PooledSession> {
  const groupCwd = path.join(GROUPS_DIR, ctx.groupFolder);
  await initToolRuntime();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const loader = new DefaultResourceLoader({
    cwd: groupCwd,
    agentDir: getAgentDir(),
    extensionFactories: [nanoclawExtension(ctx)],
    skillsOverride: mergeGlobalSkills,
  });
  await loader.reload();

  const model = resolveModel(modelRegistry);
  if (model) log(`using model: ${model.provider}/${model.id}`);
  const { session } = await createAgentSession({
    cwd: groupCwd,
    sessionManager: SessionManager.continueRecent(groupCwd),
    resourceLoader: loader,
    authStorage,
    modelRegistry,
    model,
  });

  const pooled: PooledSession = {
    session,
    routerBuffer: '',
    currentStream: null,
    streamProbed: false,
    sendChain: Promise.resolve(),
    dispose: async () => {
      await pooled.sendChain;
      await endTurn(pooled, ctx, 'aborted');
      session.dispose();
      // Tear down the chat's container (no-op in non-docker modes). Done
      // after session.dispose so any final tool calls have already settled.
      disposeChatRuntime(ctx.groupFolder);
    },
  };

  session.subscribe((event) => {
    if (event.type === 'message_update') {
      const ame = event.assistantMessageEvent;
      if (ame.type === 'text_delta') {
        pooled.sendChain = pooled.sendChain.then(async () => {
          const stream = await ensureStream(pooled, ctx);
          if (stream) {
            await stream
              .appendText(ame.delta)
              .catch((err) =>
                log(
                  `stream.appendText failed: ${err instanceof Error ? err.message : String(err)}`,
                ),
              );
          } else {
            pooled.routerBuffer += ame.delta;
          }
        });
      } else if (ame.type === 'thinking_delta') {
        pooled.sendChain = pooled.sendChain.then(async () => {
          const stream = await ensureStream(pooled, ctx);
          if (!stream) return; // no streaming → reasoning is dropped (matches old behaviour)
          await stream
            .appendReasoning(ame.delta)
            .catch((err) =>
              log(
                `stream.appendReasoning failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        });
      }
    } else if (event.type === 'tool_execution_start') {
      const { toolCallId, toolName, args } = event;
      pooled.sendChain = pooled.sendChain.then(async () => {
        const stream = await ensureStream(pooled, ctx);
        if (!stream) return;
        await stream
          .appendToolUse(toolCallId, toolName, args)
          .catch((err) =>
            log(
              `stream.appendToolUse failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      });
    } else if (event.type === 'tool_execution_end') {
      const { toolCallId, toolName, result, isError } = event;
      pooled.sendChain = pooled.sendChain.then(async () => {
        const stream = await ensureStream(pooled, ctx);
        if (!stream) return;
        await stream
          .appendToolResult(toolCallId, toolName, result, isError)
          .catch((err) =>
            log(
              `stream.appendToolResult failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      });
    } else if (event.type === 'turn_end' || event.type === 'agent_end') {
      pooled.sendChain = pooled.sendChain.then(() =>
        endTurn(pooled, ctx, 'normal'),
      );
    }
  });

  return pooled;
}

/**
 * Lazily open the per-turn stream the first time we see an event that wants
 * one. Returns null and memoizes "no stream" if the owning channel doesn't
 * implement `openStream` so subsequent events fall through to the buffer
 * fast-path without re-probing.
 */
async function ensureStream(
  p: PooledSession,
  ctx: ExtensionCtx,
): Promise<StreamHandle | null> {
  if (p.currentStream) return p.currentStream;
  if (p.streamProbed) return null;
  p.streamProbed = true;
  try {
    const handle = await openChannelStream(ctx.channels, ctx.chatJid);
    p.currentStream = handle;
    return handle;
  } catch (err) {
    log(
      `openStream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * End-of-turn cleanup: finalize the stream if we opened one, otherwise flush
 * any buffered text via the legacy single-shot router. Resets streaming state
 * so the next turn starts fresh.
 */
async function endTurn(
  p: PooledSession,
  ctx: ExtensionCtx,
  reason: 'normal' | 'aborted' | 'error',
): Promise<void> {
  if (p.currentStream) {
    const stream = p.currentStream;
    p.currentStream = null;
    p.streamProbed = false;
    try {
      await stream.finalize({ reason });
    } catch (err) {
      log(
        `stream.finalize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Streamed turns own their full output — drop any stray buffered text
    // (shouldn't accumulate, but be defensive).
    p.routerBuffer = '';
    return;
  }
  p.streamProbed = false;
  await flushBuffer(p, ctx);
}

async function flushBuffer(p: PooledSession, ctx: ExtensionCtx): Promise<void> {
  const text = p.routerBuffer.trim();
  p.routerBuffer = '';
  if (!text) return;
  try {
    await ctx.router.send(ctx.chatJid, text);
  } catch (err) {
    log(
      `router.send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
      const ctx = buildCtx({ groupFolder, chatJid, isMain, ports });
      return buildSession(ctx);
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
