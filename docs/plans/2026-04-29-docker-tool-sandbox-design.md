# Docker Tool Sandbox — Design

**Date:** 2026-04-29
**Status:** REVERTED — feature removed from `main`. The OS-level `sandbox-runtime` is the only sandbox going forward. The Docker tool forwarding path produced binary/MIME caveats that outweighed its marginal isolation benefit. Kept for historical reference.
**Predecessor:** `docs/plans/2026-04-29-pi-mono-host-agent-plan.md` (pi-mono in-process migration)

## Problem

NanoClaw currently runs `@mariozechner/pi-coding-agent` in the main Node.js process, with bash commands wrapped by `@anthropic-ai/sandbox-runtime` (`sandbox-exec` on macOS, `bubblewrap` on Linux). This is OS-level path/network ACL only — there is no filesystem isolation, no namespace boundary, and an exploit in any tool the agent invokes can reach the entire host.

The old claude-agent-sdk architecture ran the entire agent inside a Docker container (per-message `docker run --rm`). That delivered isolation but is incompatible with pi-mono's design (LLM loop must stay in the host process).

We want the security posture of the old architecture without giving up pi-mono. The community pattern that already solves this — the official `pi-mono/packages/mom` Docker sandbox — points the way.

## Goal

Keep pi-mono and all LLM/credential traffic on the host. Move every file/shell tool the agent invokes into a long-running Docker container. NanoClaw extension tools (state-bearing IPC like `send_message`, `schedule_task`) stay on host because they need NanoClaw's runtime state.

## Non-goals (v1)

- Network egress allowlist or credential proxy — match Mom's permissive default.
- Per-group containers — single shared container; strong group isolation deferred.
- `runtime=docker` automatic container creation — user manages lifecycle via `scripts/sandbox.sh`, NanoClaw only health-checks.
- Replacing the existing `runtime=sandbox-runtime` path — kept as fallback for environments without Docker (CI, dev laptops).

## Architecture

```
┌─ host (nanoclaw process) ───────────────────────────────┐
│  Feishu inbound → Router → SessionPool → AgentSession  │
│                              │                          │
│                              │ pi-coding-agent loop     │
│                              │  ↓ tool call             │
│                              ▼                          │
│  ┌──────────────────────────────────────┐              │
│  │ DockerToolOperations                 │              │
│  │   bash/read/write/edit/grep/find/ls  │              │
│  └────────────────┬─────────────────────┘              │
│                   │ docker exec --workdir /workspace/groups/<group>
│                   │                                     │
│  nanoclaw extension tools (send_message, schedule …)   │
│    → run in-process on host (NOT sandboxed)            │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─ docker container "nanoclaw-sandbox" (persistent) ─────┐
│  debian:12-slim + sleep infinity                       │
│  bind mounts:                                          │
│    /workspace/project   ← $REPO          (RO + .env shadow) │
│    /workspace/store     ← $REPO/store    (RW)          │
│    /workspace/groups    ← $REPO/groups   (RW)          │
│    /workspace/global    ← $REPO/groups/global (RW)     │
│  agent self-installs: apt install ripgrep jq git curl …│
└─────────────────────────────────────────────────────────┘
```

## Components

### Container management — `scripts/sandbox.sh`

Modeled on `pi-mono/packages/mom/docker.sh`. Subcommands:

- `create [--image <img>]` — `docker run -d --name nanoclaw-sandbox <mounts> <image> sleep infinity`
- `start` / `stop` — pass-through to `docker start/stop`
- `remove` — `docker rm -f`; user opts in to wipe accumulated tool state
- `status` — exit 0 if container exists and is `running`, else nonzero with reason
- `shell` — `docker exec -it nanoclaw-sandbox /bin/bash` for human debugging

NanoClaw's startup verifies container reachability via `status`. If absent or stopped, it logs an actionable error and refuses to start the agent path (channels still connect; user gets a chat-side error message). NanoClaw never auto-creates the container — Mom-style separation of concerns.

### Mounts (preserves `main` group privileges per Q3)

| Container path | Host path | Mode | Rationale |
|---|---|---|---|
| `/workspace/project` | repo root | RO | `main` agent can read NanoClaw source for self-modification (read-only by design) |
| `/workspace/project/.env` | `store/.sandbox-empty-env` (zero-byte file, RO bind) | RO | Shadows host `.env` so the container cannot read LLM keys. Tmpfs would be cleaner but Docker only mounts tmpfs onto directories, not files. |
| `/workspace/store` | `repo/store` | RW | `main` writes to `messages.db`; non-`main` should not need it (cwd-restricted via `--workdir`) |
| `/workspace/groups` | `repo/groups` | RW | each group's working dir |
| `/workspace/global` | `repo/groups/global` | RW | shared memory across groups |

`additionalMounts` (per-group extra bind mounts, see §"Reactivated schemas") are appended to the `docker run` invocation by `scripts/sandbox.sh` based on each registered group's `containerConfig`. Because the container is shared and long-lived, changing `additionalMounts` requires `sandbox.sh remove && create` — accepted tradeoff.

### Tool override — `src/agent/docker-operations.ts`

Implements pi-coding-agent's pluggable Operations:

- `BashOperations.exec` (and Read/Write/Edit/Grep/Find/Ls equivalents) translate every call into:

  ```
  docker exec --workdir <hostPathToContainerPath(cwd)> \
              [--env <safe vars only>] \
              nanoclaw-sandbox <cmd / shell-quoted args>
  ```

- A single `mapHostPath(p: string): string` utility translates host paths under `repo/` to `/workspace/...`. Paths outside the bind-mount roots throw — this becomes the *only* place that enforces the boundary, so testing concentrates here.

- Streaming: `child_process.spawn('docker', ['exec', ...])` with `stdio: ['ignore', 'pipe', 'pipe']`, forward `onData(buf)` per chunk, abort via `child.kill('SIGKILL')` (docker forwards SIGKILL to the exec'd process).

Wired into pi-coding-agent at `src/agent/run.ts:bootstrapSandbox` — branch on the new `runtime` config to call `bootstrapDockerSandbox()` instead of `bootstrapNativeSandbox()`.

### SDK override mechanism (validated by Phase 0 spike, commit 2d53170)

`@mariozechner/pi-coding-agent` 0.70.6 has **no top-level `bashOperations` (or any other tool) option** on `createAgentSession`. The only path that lets us inject custom `Operations` is:

1. Pass `noTools: 'builtin'` to `createAgentSession`, which disables ALL default tools (`read`, `bash`, `edit`, `write`, plus the rest).
2. Pass `customTools` containing tool definitions we built ourselves, including the non-sandboxed ones we still want default behavior for.

So even though the design selected "all tools sandboxed" (Q1 = option 2), the structural cost is the same: we rebuild every tool definition. There is no "override only bash, leave the rest default" path through the public SDK.

Concretely, `src/agent/run.ts` will switch from its current zero-option `createAgentSession({ … })` to:

```ts
createAgentSession({
  …existing fields,
  noTools: 'builtin',
  customTools: [
    createBashToolDefinition(cwd, { operations: dockerOps.bash }),
    createReadToolDefinition(cwd, { operations: dockerOps.read }),
    createEditToolDefinition(cwd, { operations: dockerOps.edit }),
    createWriteToolDefinition(cwd, { operations: dockerOps.write }),
    createGrepToolDefinition(cwd, { operations: dockerOps.grep }),
    createFindToolDefinition(cwd, { operations: dockerOps.find }),
    createLsToolDefinition(cwd, { operations: dockerOps.ls }),
  ],
});
```

Each `create<Tool>ToolDefinition` factory and its `<Tool>Operations` interface live in `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/<tool>.d.ts`. Issue #243 (which originally motivated the spike) is therefore irrelevant to nanoclaw: there's nothing to override on the default surface; we always rebuild.

### NanoClaw extension tools stay on host

`src/agent/extension.ts` provides 8 IPC tools (`send_message`, `list_groups`, `schedule_task`, etc.). These:

1. Take typed arguments — no arbitrary code execution
2. Need NanoClaw's in-memory state (channel registry, scheduler, DB handles) which the container does not have
3. Sandboxing them adds plumbing for zero security delta

These tools register with pi-coding-agent the same way they do today. They are not part of the Docker rewiring.

### Configuration

`config/sandbox.default.json` gains a top-level `runtime` field:

```json
{
  "runtime": "docker",
  "docker": {
    "containerName": "nanoclaw-sandbox",
    "image": "debian:12-slim"
  }
}
```

`runtime` values:

| Value | Behavior |
|---|---|
| `docker` | This design. Default for new installs. |
| `sandbox-runtime` | Existing `@anthropic-ai/sandbox-runtime` path. Fallback for CI / Docker-less hosts. |
| `off` | No sandbox. Dev-only. |

Per-group override at `groups/<group>/.pi/sandbox.json` honored as today.

### Reactivated schemas (replaces the "dead code" cleanup proposed earlier)

The earlier simplify pass identified `containerConfig` / `AdditionalMount` / `MountAllowlist` / `setup/mounts.ts` as dead. This design re-activates them:

| Symbol | New role |
|---|---|
| `RegisteredGroup.containerConfig.additionalMounts` | Per-group extra bind mounts injected into `docker run` at container create time |
| `MountAllowlist` / `AllowedRoot` | Host-side validator: every entry in `additionalMounts` must resolve under an allow-listed root |
| `setup/mounts.ts` + setup step 6 | Maintains `~/.config/nanoclaw/mount-allowlist.json` |
| `container_config` DB column | Persists each group's `containerConfig` |

`groups/main/CLAUDE.md` "Container Mounts" section: rewritten to describe the new layout (was stale from container era).

## Security model

| Threat | Defense |
|---|---|
| Agent runs `rm -rf /` from bash | Confined to `/workspace/*`; host is unreachable |
| Agent reads `~/.ssh/id_rsa` | Not bind-mounted; container cannot see it |
| Agent reads NanoClaw's `.env` (LLM keys) | tmpfs shadow at `/workspace/project/.env` |
| Agent exfiltrates DB | `main` only — DB is part of NanoClaw's trust boundary by design |
| Agent calls hostile network endpoint | **NOT defended in v1** (Mom default). Future: egress allowlist. |
| Container escape (kernel exploit) | Out of scope; stock Docker hardening only |

## Implementation notes (Phase 3 outcomes)

- **Image dependency**: `find.glob` uses `bash` with `shopt -s globstar nullglob dotglob`. `debian:12-slim` ships bash; if the image is swapped in `runtime.docker.image`, ensure bash is present.
- **Binary write trailing-NUL edge case**: `write` and `edit` pass content via env var + `printf '%s'`. This is byte-faithful for text but does NOT preserve a literal trailing NUL byte. Agent must use `bash` directly for binary writes that require NUL preservation.
- **Image MIME detection deferred**: `read.detectImageMimeType` is not implemented; the read tool treats all files as non-image. Add later if image preview becomes a requirement.

## Tradeoffs explicitly accepted

- **No per-group container** — group-to-group isolation is weak (a non-`main` group's bash can read other groups' files via `/workspace/groups/<other>`). Same trust domain (single user); strong isolation = future variant.
- **No egress controls** — agent can `curl` any endpoint. Mom doesn't defend this; we don't either in v1.
- **`additionalMounts` change requires container recreate** — long-lived container is the whole point; a config that requires restart is acceptable for an admin-managed resource.
- **~100ms `docker exec` overhead per tool call** — agent loops do tens of tool calls per message; expect 1-3s overhead per message. Acceptable; would need batching/streaming optimization only if it becomes a complaint.

## Open question (deferred to implementation)

- Should `--workdir` be set per-call from `cwd` (current plan), or should we exec a long-running shell in the container and pipe commands to it? Per-call is simpler and what Mom does; long-running shell saves a few ms but adds state coordination. Default to per-call.

## Sources

- [pi-mono Mom sandbox docs](https://github.com/badlogic/pi-mono/blob/main/packages/mom/docs/sandbox.md)
- [pi-mono `docker.sh`](https://github.com/badlogic/pi-mono/blob/main/packages/mom/docker.sh)
- [pi-coding-agent sandbox extension example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
- [pi-coding-agent BashOperations interface](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/bash.ts)
- Old container-runner architecture: commit `9382e70~1`, `src/container-runner.ts`
- [Issue #243 — SDK overrides sandboxed tools](https://github.com/openclaw/openclaw/issues/243)
