// src/agent/run.ts
import path from 'path';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
} from '@mariozechner/pi-coding-agent';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { SessionPool, type DisposableSession } from './session-pool.js';
import { loadSandboxConfig } from './sandbox-config.js';
import { nanoclawExtension } from './extension.js';
import { resolveModel } from './model.js';
import type { ExtensionCtx } from './types.js';

const IDLE_MS_RAW = parseInt(process.env.NANOCLAW_AGENT_IDLE_TTL_MS ?? '', 10);
const IDLE_MS = Number.isFinite(IDLE_MS_RAW) && IDLE_MS_RAW > 0 ? IDLE_MS_RAW : 600000;
const log = (m: string) => logger.info(`[agent] ${m}`);

interface PooledSession extends DisposableSession {
  session: AgentSession;
  routerBuffer: string;
  sendChain: Promise<void>;
}

type SharedPorts = Pick<
  ExtensionCtx,
  'router' | 'taskScheduler' | 'groupRegistry' | 'channels'
>;

let sandboxReady = false;
async function ensureSandbox(groupCwd: string): Promise<void> {
  if (sandboxReady) return;
  const cfg = loadSandboxConfig(groupCwd);
  if (cfg.enabled === false) {
    log('sandbox disabled by config');
    sandboxReady = true;
    return;
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    log(`sandbox unsupported on ${process.platform}; bash will run unsandboxed`);
    sandboxReady = true;
    return;
  }
  await SandboxManager.initialize(cfg);
  log('sandbox initialized');
  sandboxReady = true;
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
  await ensureSandbox(groupCwd);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const loader = new DefaultResourceLoader({
    cwd: groupCwd,
    agentDir: getAgentDir(),
    extensionFactories: [nanoclawExtension(ctx)],
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
    sendChain: Promise.resolve(),
    dispose: async () => {
      await pooled.sendChain;
      await flushBuffer(pooled, ctx);
      session.dispose();
    },
  };

  session.subscribe((event) => {
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta'
    ) {
      pooled.routerBuffer += event.assistantMessageEvent.delta;
    } else if (event.type === 'turn_end' || event.type === 'agent_end') {
      pooled.sendChain = pooled.sendChain.then(() => flushBuffer(pooled, ctx));
    }
  });

  return pooled;
}

async function flushBuffer(p: PooledSession, ctx: ExtensionCtx): Promise<void> {
  const text = p.routerBuffer.trim();
  p.routerBuffer = '';
  if (!text) return;
  try {
    await ctx.router.send(ctx.chatJid, text);
  } catch (err) {
    log(`router.send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let pool: SessionPool<PooledSession> | null = null;

export function configureAgent(ports: SharedPorts): void {
  pool = new SessionPool<PooledSession>({
    factory: async (key) => {
      const [groupFolder, chatJid, isMain] = JSON.parse(key) as [string, string, boolean];
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
  sandboxReady = false;
}
