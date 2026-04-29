// src/agent/run.ts
import path from 'path';
import { spawn } from 'node:child_process';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  createBashToolDefinition,
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  getAgentDir,
  type AgentSession,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { SessionPool, type DisposableSession } from './session-pool.js';
import { loadSandboxConfig, type SandboxConfig } from './sandbox-config.js';
import { nanoclawExtension } from './extension.js';
import { resolveModel } from './model.js';
import { checkContainerHealth, type ExecFn } from './container-health.js';
import {
  createDockerOperations,
  type DockerOperationsBundle,
} from './docker-operations.js';
import type { PathMapConfig } from './path-map.js';
import type { ExtensionCtx } from './types.js';

const IDLE_MS_RAW = parseInt(process.env.NANOCLAW_AGENT_IDLE_TTL_MS ?? '', 10);
const IDLE_MS =
  Number.isFinite(IDLE_MS_RAW) && IDLE_MS_RAW > 0 ? IDLE_MS_RAW : 600000;
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

type CustomToolsBuilder = (groupCwd: string) => ToolDefinition[] | undefined;

const nullCustomToolsBuilder: CustomToolsBuilder = () => undefined;

/** Wrap `child_process.spawn` to satisfy the {@link ExecFn} contract used by container-health. */
const spawnExec: ExecFn = (argv) =>
  new Promise((resolve, reject) => {
    const [cmd, ...rest] = argv;
    if (!cmd) {
      reject(new Error('exec: empty argv'));
      return;
    }
    const child = spawn(cmd, rest, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', () => {
      /* swallow; container-health only cares about stdout + exit code */
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code: code ?? -1 }));
  });

let sandboxReady = false;
let customToolsBuilder: CustomToolsBuilder = nullCustomToolsBuilder;

async function ensureSandbox(groupCwd: string): Promise<void> {
  if (sandboxReady) return;
  const cfg: SandboxConfig = loadSandboxConfig(groupCwd);
  const runtime = cfg.runtime ?? 'sandbox-runtime';

  if (cfg.enabled === false || runtime === 'off') {
    log('sandbox disabled by config');
    customToolsBuilder = nullCustomToolsBuilder;
    sandboxReady = true;
    return;
  }

  if (runtime === 'docker') {
    const containerName = cfg.docker?.containerName ?? 'nanoclaw-sandbox';
    const health = await checkContainerHealth(containerName, spawnExec);
    if (health.status === 'missing') {
      throw new Error(
        `Docker sandbox container '${containerName}' not found. Run: ./scripts/sandbox.sh create`,
      );
    }
    if (health.status === 'stopped') {
      throw new Error(
        `Docker sandbox container '${containerName}' exists but is stopped. Run: ./scripts/sandbox.sh start`,
      );
    }

    const repoRoot = process.cwd();
    const paths: PathMapConfig = {
      repoRoot,
      groupsDir: GROUPS_DIR,
      storeDir: path.join(repoRoot, 'store'),
      globalDir: path.join(GROUPS_DIR, 'global'),
    };
    const dockerOps: DockerOperationsBundle = createDockerOperations({
      container: containerName,
      paths,
    });

    customToolsBuilder = (cwd) =>
      [
        createBashToolDefinition(cwd, { operations: dockerOps.bash }),
        createReadToolDefinition(cwd, { operations: dockerOps.read }),
        createEditToolDefinition(cwd, { operations: dockerOps.edit }),
        createWriteToolDefinition(cwd, { operations: dockerOps.write }),
        createGrepToolDefinition(cwd, { operations: dockerOps.grep }),
        createFindToolDefinition(cwd, { operations: dockerOps.find }),
        createLsToolDefinition(cwd, { operations: dockerOps.ls }),
      ] as ToolDefinition[];
    log(`docker sandbox ready (container=${containerName})`);
    sandboxReady = true;
    return;
  }

  // runtime === 'sandbox-runtime' (default)
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    log(
      `sandbox unsupported on ${process.platform}; bash will run unsandboxed`,
    );
    customToolsBuilder = nullCustomToolsBuilder;
    sandboxReady = true;
    return;
  }
  await SandboxManager.initialize(cfg);
  log('sandbox initialized');
  customToolsBuilder = nullCustomToolsBuilder;
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
  const customTools = customToolsBuilder(groupCwd);
  const { session } = await createAgentSession({
    cwd: groupCwd,
    sessionManager: SessionManager.continueRecent(groupCwd),
    resourceLoader: loader,
    authStorage,
    modelRegistry,
    model,
    ...(customTools ? { noTools: 'builtin' as const, customTools } : {}),
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
  sandboxReady = false;
  customToolsBuilder = nullCustomToolsBuilder;
}
