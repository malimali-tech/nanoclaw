# Docker Tool Sandbox Implementation Plan

> **Status:** REVERTED. This feature was removed from `main`. Kept for historical reference.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move pi-coding-agent file/shell tool execution into a long-running Docker container while keeping pi-mono and credentials on host.

**Architecture:** Single shared container `nanoclaw-sandbox` (Mom-style), managed by user via `scripts/sandbox.sh`. NanoClaw's startup health-checks it but never `docker run`s. A new `DockerOperations` set overrides pi-coding-agent's `BashOperations`/`ReadOperations`/etc., translating each call into `docker exec --workdir <containerPath> nanoclaw-sandbox <cmd>`. `runtime` config field selects between `docker` (new), `sandbox-runtime` (current behavior, fallback), and `off`.

**Tech Stack:** TypeScript (Node 22+, ESM), `@mariozechner/pi-coding-agent` 0.70.6, `@anthropic-ai/sandbox-runtime` 0.0.49 (kept for fallback), `child_process.spawn('docker', ...)`, vitest, bash for `sandbox.sh`.

**Design doc:** `docs/plans/2026-04-29-docker-tool-sandbox-design.md`

---

## Phase 0 — Spike: prove tool-override path works

**Outcome (commit `2d53170`)**: override path works **only** via `noTools: 'builtin'` + a full `customTools` rebuild (every tool, not just bash). There is no public option to override `BashOperations` while keeping default builtins. This means Phase 3 must build adapters for ALL seven tools (already planned), and Phase 4.2's wiring uses the `noTools+customTools` shape shown in the design doc. Issue #243 is moot: we're not relying on operations injection through default tools.

The whole design depends on pi-coding-agent honoring our `Operations` overrides. Issue #243 says it sometimes doesn't. Verify before building anything else. **If the spike fails, stop and revise the design** (replacement-tool strategy instead of Operations override).

### Task 0.1: Write a probe extension that overrides BashOperations

**Files:**
- Create: `scripts/spikes/bash-override-probe.ts`

**Step 1: Read current run.ts to understand wiring**

Run: `cat src/agent/run.ts`
Note where `SandboxManager.initialize` and `createAgentSession` are called and whether `bashOperations` is a parameter to either.

**Step 2: Read pi-coding-agent's tool registration entry points**

Run: `grep -rn "bashOperations\|registerTool\|tools:" node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts | head -30`
Note which API surfaces `bashOperations`. If the spec shows it's a parameter to `createAgentSession`, the override path is direct. If only via extension `registerTool`, we need to replace the tool definition.

**Step 3: Write the probe**

```ts
// scripts/spikes/bash-override-probe.ts
// Run with: npx tsx scripts/spikes/bash-override-probe.ts
// Asks the agent to "run echo hello" and confirms our exec was called.
import { createAgentSession } from '@mariozechner/pi-coding-agent';

let calls = 0;
const probe = {
  exec: async (command: string) => {
    calls++;
    console.log(`[PROBE] override called, cmd=${command}`);
    return { exitCode: 0 };
  },
};

// Try API #1: pass via createAgentSession options
// (substitute actual property name discovered in step 2)
const session = await createAgentSession({
  /* … */
  bashOperations: probe,
} as any);

await session.send('run: echo hello');
console.log(`[PROBE] override invocations: ${calls}`);
process.exit(calls > 0 ? 0 : 1);
```

**Step 4: Run the probe**

Run: `npx tsx scripts/spikes/bash-override-probe.ts`
Expected if direct API works: `[PROBE] override called` printed at least once, exit 0.
Expected if it doesn't: SDK runs its own bash, exit 1 — proceed to Task 0.2.

**Step 5: Commit (only if it works)**

If exit 0:
```bash
git add scripts/spikes/bash-override-probe.ts
git commit -m "spike: confirm BashOperations override is honored by pi-coding-agent"
```
If exit 1: do NOT commit. Proceed to Task 0.2.

### Task 0.2: Fallback spike — replace tool via extension API

Only run if Task 0.1 failed.

**Files:**
- Create: `scripts/spikes/bash-replace-probe.ts`

**Step 1: Write a probe that uses `pi.registerTool` to replace bash**

```ts
// Registers a tool also named "bash" with our own exec, expects pi to use the
// last-registered or to error on duplicate (informing strategy).
```

**Step 2: Run, observe behavior**

Document in `scripts/spikes/SPIKE-RESULTS.md`:
- Does same-name registration win, lose, or error?
- If error: try `bash_sandboxed` + an extension that intercepts `tool_call` for `bash` with `{ block: true, reason: "use bash_sandboxed" }`.

**Step 3: Commit results doc**

```bash
git add scripts/spikes/
git commit -m "spike: bash replacement strategy results"
```

**Decision gate:** if neither override nor replacement works, stop and revisit the design. The rest of the plan assumes one of them does.

---

## Phase 1 — Pure-function foundation (path mapping)

### Task 1.1: Failing test for `mapHostPath`

**Files:**
- Create: `src/agent/path-map.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mapHostPath, type PathMapConfig } from './path-map.js';

const cfg: PathMapConfig = {
  repoRoot: '/abs/nanoclaw',
  groupsDir: '/abs/nanoclaw/groups',
  storeDir: '/abs/nanoclaw/store',
  globalDir: '/abs/nanoclaw/groups/global',
};

describe('mapHostPath', () => {
  it('maps repo root', () => {
    expect(mapHostPath('/abs/nanoclaw/src/index.ts', cfg))
      .toBe('/workspace/project/src/index.ts');
  });
  it('maps store', () => {
    expect(mapHostPath('/abs/nanoclaw/store/messages.db', cfg))
      .toBe('/workspace/store/messages.db');
  });
  it('maps groups', () => {
    expect(mapHostPath('/abs/nanoclaw/groups/main/notes.md', cfg))
      .toBe('/workspace/groups/main/notes.md');
  });
  it('maps global', () => {
    expect(mapHostPath('/abs/nanoclaw/groups/global/x.md', cfg))
      .toBe('/workspace/global/x.md');
  });
  it('throws on path outside roots', () => {
    expect(() => mapHostPath('/etc/passwd', cfg)).toThrow(/outside/);
  });
  it('rejects path traversal', () => {
    expect(() => mapHostPath('/abs/nanoclaw/../etc/passwd', cfg)).toThrow();
  });
});
```

**Step 2: Run test**

Run: `npx vitest run src/agent/path-map.test.ts`
Expected: all FAIL ("Cannot find module './path-map.js'").

**Step 3: Implement**

**Files:**
- Create: `src/agent/path-map.ts`

```ts
import path from 'path';

export interface PathMapConfig {
  repoRoot: string;
  groupsDir: string;
  storeDir: string;
  globalDir: string;
}

const CONTAINER = {
  project: '/workspace/project',
  store: '/workspace/store',
  groups: '/workspace/groups',
  global: '/workspace/global',
};

export function mapHostPath(p: string, cfg: PathMapConfig): string {
  const resolved = path.resolve(p);
  // Order matters: more specific (global is under groups) wins.
  const rules: Array<[string, string]> = [
    [cfg.globalDir, CONTAINER.global],
    [cfg.storeDir, CONTAINER.store],
    [cfg.groupsDir, CONTAINER.groups],
    [cfg.repoRoot, CONTAINER.project],
  ];
  for (const [host, container] of rules) {
    const rel = path.relative(host, resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel === '' ? container : `${container}/${rel}`;
    }
  }
  throw new Error(`Path is outside sandbox-mounted roots: ${p}`);
}
```

**Step 4: Run test**

Run: `npx vitest run src/agent/path-map.test.ts`
Expected: all PASS.

**Step 5: Commit**

```bash
git add src/agent/path-map.ts src/agent/path-map.test.ts
git commit -m "feat(agent): add host→container path mapping utility"
```

---

## Phase 2 — Container management script

### Task 2.1: `scripts/sandbox.sh` skeleton

**Files:**
- Create: `scripts/sandbox.sh`

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Manage the nanoclaw-sandbox Docker container.
# Subcommands: create, start, stop, remove, status, shell
set -euo pipefail
NAME="${NANOCLAW_SANDBOX_NAME:-nanoclaw-sandbox}"
IMAGE="${NANOCLAW_SANDBOX_IMAGE:-debian:12-slim}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cmd_status() {
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "missing"; exit 2
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "running"; exit 0
  fi
  echo "stopped"; exit 1
}

cmd_create() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "Container $NAME already exists. Use 'remove' first to recreate." >&2; exit 1
  fi
  docker run -d --name "$NAME" \
    --mount type=bind,source="$REPO",target=/workspace/project,readonly \
    --mount type=tmpfs,destination=/workspace/project/.env \
    --mount type=bind,source="$REPO/store",target=/workspace/store \
    --mount type=bind,source="$REPO/groups",target=/workspace/groups \
    "$IMAGE" sleep infinity
  echo "Created $NAME"
}

cmd_start()  { docker start "$NAME" >/dev/null && echo "Started $NAME"; }
cmd_stop()   { docker stop  "$NAME" >/dev/null && echo "Stopped $NAME"; }
cmd_remove() { docker rm -f "$NAME" >/dev/null && echo "Removed $NAME"; }
cmd_shell()  { exec docker exec -it "$NAME" /bin/bash; }

case "${1:-}" in
  create|start|stop|remove|status|shell) "cmd_$1" ;;
  *) echo "usage: $0 {create|start|stop|remove|status|shell}" >&2; exit 64 ;;
esac
```

**Step 2: Make executable**

Run: `chmod +x scripts/sandbox.sh`

**Step 3: Manual smoke test**

Run:
```
./scripts/sandbox.sh status   # expect: missing (exit 2)
./scripts/sandbox.sh create   # expect: Created
./scripts/sandbox.sh status   # expect: running (exit 0)
docker exec nanoclaw-sandbox ls /workspace/groups   # see group dirs
docker exec nanoclaw-sandbox cat /workspace/project/.env   # expect empty (tmpfs shadow)
./scripts/sandbox.sh remove
```

**Step 4: Commit**

```bash
git add scripts/sandbox.sh
git commit -m "feat(sandbox): add scripts/sandbox.sh container manager (Mom-style)"
```

### Task 2.2: Container health-check helper

**Files:**
- Create: `src/agent/container-health.ts`
- Create: `src/agent/container-health.test.ts`

**Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { checkContainerHealth } from './container-health.js';

describe('checkContainerHealth', () => {
  it('returns running when docker reports running', async () => {
    const fakeExec = vi.fn().mockResolvedValue({ stdout: 'running\n', code: 0 });
    expect(await checkContainerHealth('foo', fakeExec))
      .toEqual({ status: 'running' });
    expect(fakeExec).toHaveBeenCalledWith(
      ['docker', 'inspect', '-f', '{{.State.Status}}', 'foo']
    );
  });
  it('returns missing when inspect exits nonzero', async () => {
    const fakeExec = vi.fn().mockResolvedValue({ stdout: '', code: 1 });
    expect(await checkContainerHealth('foo', fakeExec))
      .toEqual({ status: 'missing' });
  });
  it('returns stopped when status is exited', async () => {
    const fakeExec = vi.fn().mockResolvedValue({ stdout: 'exited\n', code: 0 });
    expect(await checkContainerHealth('foo', fakeExec))
      .toEqual({ status: 'stopped' });
  });
});
```

**Step 2: Run test**

Run: `npx vitest run src/agent/container-health.test.ts`
Expected: FAIL (module missing).

**Step 3: Implement**

```ts
// src/agent/container-health.ts
export type ContainerHealth =
  | { status: 'running' }
  | { status: 'stopped' }
  | { status: 'missing' };

export type ExecFn = (argv: string[]) => Promise<{ stdout: string; code: number }>;

export async function checkContainerHealth(
  name: string,
  exec: ExecFn,
): Promise<ContainerHealth> {
  const { stdout, code } = await exec(
    ['docker', 'inspect', '-f', '{{.State.Status}}', name],
  );
  if (code !== 0) return { status: 'missing' };
  return stdout.trim() === 'running' ? { status: 'running' } : { status: 'stopped' };
}
```

**Step 4: Run test**

Run: `npx vitest run src/agent/container-health.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/container-health.ts src/agent/container-health.test.ts
git commit -m "feat(agent): add container health probe (pure function + injectable exec)"
```

---

## Phase 3 — DockerOperations (one tool at a time)

For each tool: write a small integration test that boots a real container (skip if `docker` not on PATH), exercises the operation, asserts the host-side observable result. The container is created/destroyed by the test setup.

### Task 3.1: Docker exec helper with streaming

**Files:**
- Create: `src/agent/docker-exec.ts`
- Create: `src/agent/docker-exec.test.ts`

**Step 1: Skipping-friendly integration test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { dockerExec } from './docker-exec.js';

const haveDocker = (() => { try { execSync('docker info', {stdio:'ignore'}); return true; } catch { return false; } })();
const NAME = 'nanoclaw-test-sandbox';

describe.skipIf(!haveDocker)('dockerExec', () => {
  beforeAll(() => {
    execSync(`docker rm -f ${NAME} 2>/dev/null || true`);
    execSync(`docker run -d --name ${NAME} debian:12-slim sleep infinity`);
  });
  afterAll(() => execSync(`docker rm -f ${NAME}`));

  it('streams stdout', async () => {
    const chunks: string[] = [];
    const { exitCode } = await dockerExec({
      container: NAME,
      cwd: '/',
      command: 'echo hello && echo world',
      onData: (b) => chunks.push(b.toString()),
    });
    expect(exitCode).toBe(0);
    expect(chunks.join('')).toMatch(/hello[\s\S]*world/);
  });

  it('returns nonzero exit on failure', async () => {
    const { exitCode } = await dockerExec({
      container: NAME, cwd: '/', command: 'exit 42', onData: () => {},
    });
    expect(exitCode).toBe(42);
  });

  it('honors abort signal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(dockerExec({
      container: NAME, cwd: '/', command: 'sleep 5', onData: () => {}, signal: ac.signal,
    })).rejects.toThrow(/abort/i);
  });
});
```

**Step 2: Run, verify FAIL**

Run: `npx vitest run src/agent/docker-exec.test.ts`
Expected: FAIL (module missing) — or skipped if no docker.

**Step 3: Implement**

```ts
// src/agent/docker-exec.ts
import { spawn } from 'child_process';

export interface DockerExecArgs {
  container: string;
  cwd: string;
  command: string;
  onData: (buf: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: Record<string, string>;
}

export async function dockerExec(args: DockerExecArgs): Promise<{ exitCode: number }> {
  const argv = ['exec', '--workdir', args.cwd];
  for (const [k, v] of Object.entries(args.env ?? {})) argv.push('-e', `${k}=${v}`);
  argv.push(args.container, '/bin/sh', '-c', args.command);

  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timer: NodeJS.Timeout | undefined;
    if (args.timeout && args.timeout > 0) {
      timer = setTimeout(() => child.kill('SIGKILL'), args.timeout * 1000);
    }
    const onAbort = () => child.kill('SIGKILL');
    args.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', args.onData);
    child.stderr.on('data', args.onData);
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      args.signal?.removeEventListener('abort', onAbort);
      if (args.signal?.aborted) return reject(new Error('aborted'));
      resolve({ exitCode: code ?? -1 });
    });
  });
}
```

**Step 4: Run, verify PASS**

Run: `npx vitest run src/agent/docker-exec.test.ts`
Expected: PASS (or skipped if no docker).

**Step 5: Commit**

```bash
git add src/agent/docker-exec.ts src/agent/docker-exec.test.ts
git commit -m "feat(agent): add streaming docker exec helper with abort + timeout"
```

### Task 3.2: BashOperations adapter

**Files:**
- Create: `src/agent/docker-operations.ts`
- Create: `src/agent/docker-operations.test.ts`

**Step 1: Failing test**

Test that `createDockerBashOperations({ container, repoRoot, ... }).exec(cmd, hostCwd, opts)` translates `hostCwd` via `mapHostPath` and calls `dockerExec` with the expected argv. Mock `dockerExec`.

```ts
// src/agent/docker-operations.test.ts (excerpt)
import { describe, it, expect, vi } from 'vitest';
import { createDockerBashOperations } from './docker-operations.js';

vi.mock('./docker-exec.js', () => ({ dockerExec: vi.fn() }));
import { dockerExec } from './docker-exec.js';

describe('createDockerBashOperations', () => {
  it('maps cwd and calls dockerExec', async () => {
    (dockerExec as any).mockResolvedValue({ exitCode: 0 });
    const ops = createDockerBashOperations({
      container: 'sb',
      paths: { repoRoot:'/r', groupsDir:'/r/groups', storeDir:'/r/store', globalDir:'/r/groups/global' },
    });
    await ops.exec('ls', '/r/groups/main', { onData: () => {} });
    expect(dockerExec).toHaveBeenCalledWith(expect.objectContaining({
      container: 'sb',
      cwd: '/workspace/groups/main',
      command: 'ls',
    }));
  });
});
```

**Step 2: Run, verify FAIL**

Run: `npx vitest run src/agent/docker-operations.test.ts`

**Step 3: Implement BashOperations only**

```ts
// src/agent/docker-operations.ts (initial)
import type { BashOperations } from '@mariozechner/pi-coding-agent';
import { dockerExec } from './docker-exec.js';
import { mapHostPath, type PathMapConfig } from './path-map.js';

export interface DockerOpsConfig {
  container: string;
  paths: PathMapConfig;
}

export function createDockerBashOperations(cfg: DockerOpsConfig): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout, env }) =>
      dockerExec({
        container: cfg.container,
        cwd: mapHostPath(cwd, cfg.paths),
        command,
        onData,
        signal,
        timeout,
        env: env as Record<string,string> | undefined,
      }),
  };
}
```

**Step 4: Run, verify PASS**

**Step 5: Commit**

```bash
git add src/agent/docker-operations.ts src/agent/docker-operations.test.ts
git commit -m "feat(agent): add Docker BashOperations adapter"
```

### Tasks 3.3 – 3.8: One task per remaining tool

Repeat the pattern (test → implement → commit) for each. Each task is small because we use `dockerExec` for everything; the only differences are how arguments are quoted.

| Task | Tool | Container command pattern |
|---|---|---|
| 3.3 | `read` | `cat -- <path>` (with line/byte slicing if pi's interface has it) |
| 3.4 | `write` | `tee -- <path> <<'EOF' … EOF` (heredoc with random delimiter) |
| 3.5 | `edit` | `python3 -c '<replacer>'` or `node <inline>` — pick whatever's in the base image |
| 3.6 | `grep` | `grep -rEn -- <pattern> <path>` |
| 3.7 | `find` | `find <path> <flags>` |
| 3.8 | `ls`   | `ls -la --color=never -- <path>` |

For each:
1. Write a unit test asserting the constructed `dockerExec` argv (mock `dockerExec`).
2. Implement.
3. Run unit tests.
4. Commit (`feat(agent): add Docker <tool> adapter`).

**Note**: pi-coding-agent's tool interfaces will dictate exact signatures. When writing each task, run `grep -n "Operations" node_modules/@mariozechner/pi-coding-agent/dist/*.d.ts` to find the actual TS shapes, then mirror them.

### Task 3.9: Bundle factory

**Files:**
- Modify: `src/agent/docker-operations.ts`

**Step 1: Add `createDockerOperations` aggregator**

```ts
export function createDockerOperations(cfg: DockerOpsConfig) {
  return {
    bash:  createDockerBashOperations(cfg),
    read:  createDockerReadOperations(cfg),
    write: createDockerWriteOperations(cfg),
    edit:  createDockerEditOperations(cfg),
    grep:  createDockerGrepOperations(cfg),
    find:  createDockerFindOperations(cfg),
    ls:    createDockerLsOperations(cfg),
  };
}
```

**Step 2: Type-check**

Run: `npm run typecheck`
Expected: clean.

**Step 3: Commit**

```bash
git add src/agent/docker-operations.ts
git commit -m "feat(agent): bundle DockerOperations factory"
```

---

## Phase 4 — Wire the runtime selector

### Task 4.1: Extend SandboxConfig schema

**Files:**
- Modify: `src/agent/sandbox-config.ts`
- Modify: `config/sandbox.default.json`

**Step 1: Add `runtime` + `docker` fields**

```ts
// sandbox-config.ts: extend interface
export interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
  runtime?: 'docker' | 'sandbox-runtime' | 'off';
  docker?: { containerName?: string; image?: string };
}
```

```jsonc
// config/sandbox.default.json — append
{
  "runtime": "sandbox-runtime",   // keep existing behavior as default until docker is fully tested
  "docker": { "containerName": "nanoclaw-sandbox", "image": "debian:12-slim" },
  /* … existing fields unchanged … */
}
```

**Step 2: Run existing tests**

Run: `npx vitest run src/agent/sandbox-config.test.ts`
Expected: PASS — schema additions are additive.

**Step 3: Commit**

```bash
git add src/agent/sandbox-config.ts config/sandbox.default.json
git commit -m "feat(sandbox): add runtime selector to sandbox config schema"
```

### Task 4.2: Replace `ensureSandbox` with runtime dispatcher

**Files:**
- Modify: `src/agent/run.ts`

**Step 1: Refactor `ensureSandbox`**

Replace lines around `ensureSandbox` with a dispatcher that:
- `runtime === 'off'`: log and return.
- `runtime === 'sandbox-runtime'`: existing `SandboxManager.initialize` path.
- `runtime === 'docker'`:
  1. Call `checkContainerHealth(cfg.docker.containerName, dockerCli)`. If not running, throw a clear error mentioning `./scripts/sandbox.sh create`.
  2. Build `pathMap` from `process.cwd()` and `GROUPS_DIR`.
  3. Call `createDockerOperations({ container, paths })` and pass each into `createAgentSession` (or via the override mechanism resolved in Phase 0).

**Step 2: Run agent tests**

Run: `npx vitest run src/agent/`
Expected: existing tests PASS; any new wiring covered by container-health and docker-operations tests.

**Step 3: Manual smoke (gated on having container)**

```bash
./scripts/sandbox.sh create
NANOCLAW_RUNTIME_OVERRIDE=docker npm run dev
# Send a chat message that triggers bash, e.g. "what's the date?"
# Verify in logs: "[agent] docker sandbox ready"
# Verify by exec: docker exec nanoclaw-sandbox cat /workspace/groups/main/<some test file>
./scripts/sandbox.sh remove
```

**Step 4: Commit**

```bash
git add src/agent/run.ts
git commit -m "feat(agent): runtime dispatcher (docker | sandbox-runtime | off)"
```

---

## Phase 5 — Reactivate per-group additionalMounts (low risk; deferrable to v1.1)

If timebox tight, ship Phase 4 and stop here; revisit later. Otherwise:

### Task 5.1: Re-enable setup step 6

**Files:**
- Modify: `setup/index.ts`, `setup/mounts.ts`, `setup/verify.ts`
- Verify: `setup/mounts.ts` is intact from before the dead-code era (it still exists per current grep).

Steps mirror existing patterns: ensure `npx tsx setup/index.ts --step mounts` works again, and verify recognizes the file.

### Task 5.2: Wire `additionalMounts` into `scripts/sandbox.sh`

`scripts/sandbox.sh create` reads `~/.config/nanoclaw/mount-allowlist.json` and each registered group's `containerConfig.additionalMounts`, intersects with the allowlist, appends `--mount type=bind,source=...,target=/workspace/extra/<name>[,readonly]` flags.

Acceptance: a registered group's `additionalMounts` entry appears in `docker inspect nanoclaw-sandbox` output after recreate.

### Task 5.3: Update `groups/main/CLAUDE.md` Container Mounts table

Replace stale `/workspace/project/store` etc. with the actual current layout.

Each task: failing test where applicable, implement, commit.

---

## Phase 6 — Documentation

### Task 6.1: Update `README.md` and `CLAUDE.md`

- README "Pi-coding-agent in-process" section: add a paragraph about Docker tool sandbox + link to design doc.
- CLAUDE.md "Quick Context": adjust sentence "Bash commands from the agent run inside `sandbox-exec` (macOS) or `bubblewrap` (Linux)" → describe the runtime selector.

### Task 6.2: Update `.claude/skills/setup/SKILL.md` and `.claude/skills/debug/SKILL.md`

- setup SKILL: add Docker prerequisite + `./scripts/sandbox.sh create` step before service start.
- debug SKILL: add a "Docker sandbox not running" troubleshooting section.

### Task 6.3: Single-commit docs sweep

```bash
git add README.md CLAUDE.md .claude/skills/setup/SKILL.md .claude/skills/debug/SKILL.md groups/main/CLAUDE.md
git commit -m "docs: document docker tool sandbox architecture"
```

---

## Acceptance criteria

- `npx vitest run` passes (all new + existing tests).
- `npm run typecheck` clean.
- With `runtime=sandbox-runtime` (default), no behavioral change vs main.
- With `runtime=docker` and `./scripts/sandbox.sh create` run:
  - Sending a chat message that triggers `bash` causes `docker exec` invocations (visible via `docker top` or process tree).
  - Files written by the agent appear at `groups/<name>/...` on host.
  - `cat /workspace/project/.env` inside container is empty.
  - Stopping the container yields a clear error in `logs/nanoclaw.log` directing user to `./scripts/sandbox.sh create`.
- `runtime=off` skips both sandboxes (dev escape hatch).

## Open items recorded for later

- Egress allowlist / network policy (deferred from design §6).
- Per-group containers if isolation requirement strengthens (deferred).
- Performance benchmark of `docker exec` overhead vs in-process baseline (instrument once shipped).
