# Switch NanoClaw's agent CLI to openclaude + Gemini (soft replacement)

- **Date**: 2026-04-23
- **Status**: Design approved (implementation pending)
- **Security note**: `.env` contains an API key in plaintext. Suitable for personal-use NanoClaw only. Multi-tenant / cloud deployment must migrate `GEMINI_API_KEY` to OneCLI vault before going live.

## Context

NanoClaw currently runs `@anthropic-ai/claude-agent-sdk` inside `container/agent-runner/`, which spawns the bundled `@anthropic-ai/claude-code` CLI as a subprocess. The goal is to swap the CLI binary for `@gitlawb/openclaude` so NanoClaw can route `query()` traffic through Gemini (specifically `gemini-3.1-pro-preview`) instead of the Anthropic API, while keeping the Anthropic path available as a fallback.

Feasibility was validated by a three-step PoC in `/Users/haoyiqiang/Workspace/haoyiqiang/test` that confirmed:

1. The SDK's `pathToClaudeCodeExecutable` + `executable: 'node'` options are a stable extension point.
2. openclaude's `dist/cli.mjs` is a drop-in replacement over the stream-json protocol.
3. `options.env` injection of `CLAUDE_CODE_USE_GEMINI=1` + `GEMINI_API_KEY` + `GEMINI_MODEL=gemini-3.1-pro-preview` produces correct Gemini responses.

No NanoClaw business logic (MessageStream, PreCompact hook, x-integration `tool()`, IPC MCP server) needs to change.

## Scope decisions (from brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Replacement depth | **Soft replace**: openclaude + Gemini is the default; Anthropic remains available as fallback via env var. |
| 2 | `GEMINI_API_KEY` source | **Project root `.env`**, no OneCLI integration in this change. |
| 3 | Default Gemini model | **`gemini-3.1-pro-preview`** (quality over latency; ~20s / $0.17 per turn). |
| 4 | Switch mechanism | **`NANOCLAW_LLM_PROVIDER=anthropic\|openclaude`**, default `openclaude`. |
| 5 | Acceptance | **Smoke test + Feishu 1v1 end-to-end** (same conversation). |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Main process (nanoclaw)                                     │
│  Reads .env into process.env at startup                     │
│  container-runner.ts forwards to container:                 │
│    - NANOCLAW_LLM_PROVIDER (default openclaude)             │
│    - GEMINI_API_KEY (when provider=openclaude)              │
│    - GEMINI_MODEL (optional, default gemini-3.1-pro-preview)│
└───────────────────────┬─────────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Container agent-runner (index.ts)                           │
│  Calls resolveProvider() at startup [providers.ts]          │
│    ├─ Reads process.env.NANOCLAW_LLM_PROVIDER               │
│    └─ Returns { pathToClaudeCodeExecutable,                 │
│                 executable, env, meta }                     │
│  Merges into query() options unchanged.                     │
│                                                             │
│  SDK spawns CLI subprocess:                                 │
│    - provider=anthropic → bundled @anthropic-ai/claude-code │
│    - provider=openclaude → @gitlawb/openclaude/dist/cli.mjs │
│                             + CLAUDE_CODE_USE_GEMINI=1      │
│                             + GEMINI_API_KEY/MODEL          │
└─────────────────────────────────────────────────────────────┘
```

### Invariants

1. Both `@anthropic-ai/claude-code` (installed globally in the Dockerfile) and `@gitlawb/openclaude` (installed as a dependency) ship in the container image. Image size grows by ~20 MB.
2. Business logic is untouched — MessageStream, PreCompact hook, x-integration `tool()`, IPC MCP server remain.
3. Rollback is a single edit: change `NANOCLAW_LLM_PROVIDER=anthropic` in `.env` and restart NanoClaw.
4. `.env` is gitignored. `.env.example` ships in git as the contract.

## File changes

```
nanoclaw/
├── .env                               [NEW, gitignored]
├── .env.example                       [NEW, tracked]
├── .gitignore                         [VERIFY contains .env]
├── container/
│   ├── Dockerfile                     [MODIFY: keep claude-code, ensure openclaude installs via agent-runner npm install]
│   └── agent-runner/
│       ├── package.json               [MODIFY: add @gitlawb/openclaude dep]
│       └── src/
│           ├── providers.ts           [NEW: provider resolver]
│           ├── providers.test.ts      [NEW: unit tests]
│           └── index.ts               [MODIFY: use resolveProvider() in query() options]
├── src/
│   └── container-runner.ts            [MODIFY: forward provider env vars to container]
└── docs/plans/
    └── 2026-04-23-nanoclaw-openclaude-gemini-design.md   [NEW: this file]
```

## `providers.ts` module

### Interface

```ts
export type LlmProvider = 'anthropic' | 'openclaude';

export interface ProviderConfig {
  /** SDK pathToClaudeCodeExecutable; omitted for anthropic (SDK uses bundled). */
  pathToClaudeCodeExecutable?: string;
  /** SDK executable runtime; 'node' for openclaude cli.mjs. */
  executable?: 'node' | 'bun';
  /** Extra env vars to merge into query() options.env. */
  env: Record<string, string>;
  /** Diagnostic metadata used for logging. */
  meta: { provider: LlmProvider; model?: string };
}

export function resolveProvider(sourceEnv?: NodeJS.ProcessEnv): ProviderConfig;
```

### Resolver behavior

- Reads `NANOCLAW_LLM_PROVIDER` from `sourceEnv` (default `process.env`). Default value is `openclaude`.
- Lowercases the value. Throws `Error` if not in `{anthropic, openclaude}`.
- **anthropic**: returns `{ env: {}, meta: { provider: 'anthropic' } }`. No CLI override.
- **openclaude**:
  - Requires `GEMINI_API_KEY` in `sourceEnv`; throws if missing with a clear message.
  - Reads `GEMINI_MODEL` or defaults to `gemini-3.1-pro-preview`.
  - Resolves CLI path via `createRequire(import.meta.url).resolve('@gitlawb/openclaude/dist/cli.mjs')`.
  - Returns `{ pathToClaudeCodeExecutable, executable: 'node', env: { CLAUDE_CODE_USE_GEMINI, GEMINI_API_KEY, GEMINI_MODEL }, meta: { provider: 'openclaude', model } }`.

### `index.ts` consumption

Add at startup (after existing init logging):

```ts
import { resolveProvider } from './providers.js';

const providerCfg = resolveProvider();
console.log(
  `[agent-runner] LLM provider = ${providerCfg.meta.provider}` +
  (providerCfg.meta.model ? ` (${providerCfg.meta.model})` : '')
);
```

In the `query({ options })` call, merge:

```ts
options: {
  cwd: '/workspace/group',
  // ...all existing options unchanged...
  env: { ...sdkEnv, ...providerCfg.env },
  pathToClaudeCodeExecutable: providerCfg.pathToClaudeCodeExecutable,
  executable: providerCfg.executable,
  // ...
}
```

### Design tradeoffs

- **Pure function**: `resolveProvider` has no I/O and no side effects, so unit tests are trivial.
- **Fail fast**: Missing key or bad provider name throws at startup, not mid-message.
- **Single validation site**: Main process only forwards env; it does not pre-validate. This avoids two places to edit when rules change.
- **No `GEMINI_BASE_URL` support** (YAGNI): openclaude has working defaults. Add only if a user need appears.
- **`createRequire` over hardcoded path**: Container `node_modules` location can vary with npm layout; `require.resolve` is the only reliable resolver in ESM.

## Credential & env flow

### `.env` loading in main process

First check whether NanoClaw already loads `.env` (via `dotenv` or equivalent). If yes, reuse. If no, prefer **Node 20+'s `--env-file=.env` CLI flag** over adding a `dotenv` dep. Adjust `package.json` scripts and the launchd plist accordingly.

### `.env.example` (tracked in git)

```bash
# LLM provider selection. One of: openclaude | anthropic
NANOCLAW_LLM_PROVIDER=openclaude

# Required when NANOCLAW_LLM_PROVIDER=openclaude
GEMINI_API_KEY=

# Optional. Default: gemini-3.1-pro-preview
# GEMINI_MODEL=gemini-3.1-pro-preview
```

### `container-runner.ts` env forwarding

Add a block that extracts the three variables from `process.env` and merges them into the container's environment:

```ts
const provider = process.env.NANOCLAW_LLM_PROVIDER ?? 'openclaude';
const llmEnv: Record<string, string> = { NANOCLAW_LLM_PROVIDER: provider };
if (provider === 'openclaude') {
  if (process.env.GEMINI_API_KEY) llmEnv.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (process.env.GEMINI_MODEL) llmEnv.GEMINI_MODEL = process.env.GEMINI_MODEL;
}
// merge llmEnv into the existing container env object
```

Main process does **not** validate — validation happens in `providers.ts` inside the container, so errors surface in one consistent place.

### Boundaries

- Existing OneCLI Anthropic credential injection path is unchanged. `NANOCLAW_LLM_PROVIDER=anthropic` uses it as before.
- OneCLI does not need to know about `GEMINI_API_KEY` in this change (it remains in project `.env`).
- Dockerfile does not set `ENV GEMINI_API_KEY=...` — the key is not baked into the image.

## Error handling

| # | Scenario | Surface | Handling |
|---|----------|---------|----------|
| 1 | `GEMINI_API_KEY` missing while provider=openclaude | Container exit≠0 during startup | Main process logs container error; user fills `.env` |
| 2 | Bad `NANOCLAW_LLM_PROVIDER` value (typo) | Same as #1, message names the legal values | User corrects |
| 3 | Revoked / malformed `GEMINI_API_KEY` | Assistant message says model unavailable; `result.is_error=true`; SDK throws | agent-runner's existing catch writes the error back to the channel |
| 4 | Outdated `GEMINI_MODEL` name | Same as #3 | Same as #3 |
| 5 | `require.resolve` fails (openclaude not installed) | Startup throws | Build-time check — should never reach runtime |
| 6 | Gemini API network timeout | openclaude formats as #3 | Same as #3 |

**Principles**: Every failure is visible (container log or channel message). Nothing is silently swallowed.

## Rollback procedure

```bash
# Edit .env
NANOCLAW_LLM_PROVIDER=anthropic

# Restart NanoClaw main process (the running one)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw        # launchd (macOS)
# or
systemctl --user restart nanoclaw                        # systemd (Linux)
# or
npm run dev                                              # dev mode
```

Container lifetimes are short (one per session), so the next incoming message will spin up a container that reads the new env.

## Testing / validation plan

### Round 1 — Smoke (code layer)

**A. Unit test `providers.test.ts`** — covers four cases:

- default (no env) → openclaude + default model
- explicit anthropic → no CLI override
- openclaude without `GEMINI_API_KEY` → throws
- bad provider value → throws

Run: `cd container/agent-runner && npm test`. Must exit 0.

**B. Compile check**

```
npm run build                                 # main process
cd container/agent-runner && npm run build    # agent-runner
./container/build.sh                          # image
```

All three exit codes must be 0.

**C. Manual container run** — spawn a container with `--env-file .env`, inject a synthetic user message, read stream-json output. Expect log line `[agent-runner] LLM provider = openclaude (gemini-3.1-pro-preview)` and `assistant` + `result` messages.

### Round 2 — Feishu 1v1 end-to-end

Prerequisites: `.env` populated, NanoClaw running, Feishu 1v1 established.

1. **Baseline (openclaude default)**: Send "What model are you using?" → expect reply mentioning `gemini`; container log shows `LLM provider = openclaude (gemini-3.1-pro-preview)`.
2. **Tool call validation**: Send "Read the file README.md in /workspace/group and tell me its first line." → expect Gemini to invoke the `Read` tool and return the first line correctly.
3. **Rollback validation**: Change `.env` to `NANOCLAW_LLM_PROVIDER=anthropic`, restart NanoClaw, send "What model are you using?" again → expect reply mentioning `claude`; log shows `LLM provider = anthropic`.
4. **Restore**: Change `.env` back to `openclaude` (or delete the line), restart.

**Pass criteria**: Tests 1, 2, 3 all succeed.

## Out of scope / known gaps

- **PreCompact hook behavior under Gemini**: requires a long session to observe; tracked for later.
- **x-integration `tool()` under Gemini**: requires explicit trigger (posting a tweet); not covered here, tracked for later.
- **Rate limit behavior on Gemini**: single-run acceptance won't hit limits; observe in production.
- **Cost comparison Anthropic vs Gemini**: user chose Pro model — cost is not the focus this round.
- **Multi-tenant hardening (OneCLI vault for `GEMINI_API_KEY`)**: deferred. Required before the code ships to any shared or multi-user deployment.

## Next step

Transition to `superpowers:writing-plans` to produce a concrete implementation plan derived from this design.
