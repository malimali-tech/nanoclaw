/**
 * Task 0.1 spike: probe whether @mariozechner/pi-coding-agent honors a custom
 * BashOperations override at runtime.
 *
 * Findings while wiring this up (from
 *   node_modules/@mariozechner/pi-coding-agent/dist/core/sdk.d.ts and
 *   node_modules/@mariozechner/pi-coding-agent/dist/core/tools/bash.d.ts):
 *
 *   - `createAgentSession` (the same factory nanoclaw uses, see
 *     src/agent/run.ts:86) does NOT take a top-level `bashOperations` field.
 *   - It does take `customTools: ToolDefinition[]` and `noTools: 'all'|'builtin'`.
 *   - `createBashToolDefinition(cwd, options)` accepts
 *       `options.operations: BashOperations`
 *     (see core/tools/bash.d.ts line 50-58: `BashToolOptions.operations`).
 *
 * Strategy: use `noTools: 'builtin'` so pi does not register its default bash,
 * then re-register all builtin tools via `customTools` — but use
 * `createBashToolDefinition` with our spying `BashOperations`. If pi honors
 * the override, the LLM's `bash` tool call hits our `exec` and prints
 * `[PROBE] override called`.
 *
 * Mirrors src/agent/run.ts wiring: AuthStorage / DefaultResourceLoader /
 * ModelRegistry / SessionManager / model from resolveModel().
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  createAgentSession,
  getAgentDir,
  createBashToolDefinition,
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  type BashOperations,
} from '@mariozechner/pi-coding-agent';
import { resolveModel } from '../../src/agent/model.js';

async function main(): Promise<number> {
  // Use a throwaway cwd so we don't disturb groups/.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-probe-'));

  let overrideCalls = 0;
  const operations: BashOperations = {
    exec: async (command, _execCwd, options) => {
      overrideCalls += 1;
      const tag = `[PROBE] override called, cmd=${command}`;
      // eslint-disable-next-line no-console
      console.log(tag);
      // Stream a fake "hello" line back through onData so the agent sees output.
      options.onData(Buffer.from('hello\n'));
      return { exitCode: 0 };
    },
  };

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    extensionFactories: [],
  });
  await loader.reload();

  const model = resolveModel(modelRegistry);
  if (!model) {
    console.error(
      '[PROBE] no model resolved — set NANOCLAW_LLM_MODEL or ensure deepseek auth is registered',
    );
    return 1;
  }
  console.log(`[PROBE] using model ${model.provider}/${model.id}`);

  const customBash = createBashToolDefinition(cwd, { operations });

  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    authStorage,
    modelRegistry,
    model,
    noTools: 'builtin',
    customTools: [
      customBash,
      createReadToolDefinition(cwd),
      createEditToolDefinition(cwd),
      createWriteToolDefinition(cwd),
      createGrepToolDefinition(cwd),
      createFindToolDefinition(cwd),
      createLsToolDefinition(cwd),
    ],
  });

  // Surface text deltas so we can see the agent reasoning if anything goes
  // sideways.
  session.subscribe((event) => {
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta'
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  try {
    await session.prompt(
      'run this bash command using your bash tool and report back the output: echo hello',
    );
  } finally {
    session.dispose();
  }

  console.log(`\n[PROBE] override invocations: ${overrideCalls}`);
  return overrideCalls > 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[PROBE] error:', err);
    process.exit(1);
  });
