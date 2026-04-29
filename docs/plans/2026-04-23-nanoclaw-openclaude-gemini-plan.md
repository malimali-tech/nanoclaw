# NanoClaw openclaude+Gemini Soft-Replacement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Switch NanoClaw's container agent-runner from `@anthropic-ai/claude-code` CLI to `@gitlawb/openclaude` + Gemini as default, with `NANOCLAW_LLM_PROVIDER` env var allowing runtime rollback to Anthropic.

**Architecture:** A new pure-function `providers.ts` module in `container/agent-runner/src/` resolves which CLI binary, runtime, and extra env vars to feed to the SDK's `query()` options based on `NANOCLAW_LLM_PROVIDER`. Host-side `container-runner.ts` forwards the three LLM env vars (`NANOCLAW_LLM_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`) from the main process's `.env` (loaded via Node's built-in `--env-file` flag) into the container at spawn time. Business logic (MessageStream, PreCompact hook, x-integration, IPC MCP) is not touched.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 22+, `@anthropic-ai/claude-agent-sdk` ^0.2.92, `@gitlawb/openclaude` ^0.6.0, Node built-in `node:test` runner (no new test dep), Docker/Apple Container.

**Companion design doc:** [`docs/plans/2026-04-23-nanoclaw-openclaude-gemini-design.md`](./2026-04-23-nanoclaw-openclaude-gemini-design.md)

---

## Task 1: Add `@gitlawb/openclaude` dependency to agent-runner

**Files:**
- Modify: `container/agent-runner/package.json`

**Step 1: Edit package.json**

Add `"@gitlawb/openclaude": "^0.6.0"` to the `dependencies` object, in alphabetical order with the other deps.

**Step 2: Install and lock**

Run: `cd container/agent-runner && npm install`
Expected: `package-lock.json` updated; `node_modules/@gitlawb/openclaude/dist/cli.mjs` exists.

**Step 3: Verify the CLI path resolves**

Run (must exit 0):
```bash
node --input-type=module -e "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); console.log(r.resolve('@gitlawb/openclaude/dist/cli.mjs'))" 2>&1
```
Expected: absolute path ending in `node_modules/@gitlawb/openclaude/dist/cli.mjs`. Run from inside `container/agent-runner/`.

**Step 4: Commit**

```bash
git add container/agent-runner/package.json container/agent-runner/package-lock.json
git commit -m "feat(agent-runner): add @gitlawb/openclaude as alternative CLI"
```

---

## Task 2: Add `node:test` harness to agent-runner scripts

**Files:**
- Modify: `container/agent-runner/package.json`

**Step 1: Add test script**

In `scripts`, add:
```json
"test": "node --test --test-reporter=spec --import tsx src/*.test.ts"
```

**Step 2: Add `tsx` devDependency**

Under `devDependencies`, add `"tsx": "^4.19.0"`. (It's needed to run .ts tests directly without pre-compiling.)

**Step 3: Install**

Run: `cd container/agent-runner && npm install`
Expected: `tsx` added, `package-lock.json` updated.

**Step 4: Sanity-check the harness works on a nonexistent test**

Run: `cd container/agent-runner && npm test 2>&1 | tail -3`
Expected: either "no test files found" or a spec-style report. Not a parse/syntax error. (Exit code may be non-zero if no tests; that's fine for this step.)

**Step 5: Commit**

```bash
git add container/agent-runner/package.json container/agent-runner/package-lock.json
git commit -m "chore(agent-runner): add node:test harness via tsx"
```

---

## Task 3: Write failing test for `providers.ts` (TDD red)

**Files:**
- Create: `container/agent-runner/src/providers.test.ts`

**Step 1: Create the test file with all four cases**

```ts
// container/agent-runner/src/providers.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from './providers.js';

describe('resolveProvider', () => {
  it('defaults to openclaude + gemini-3.1-pro-preview when no env is set', () => {
    const cfg = resolveProvider({ GEMINI_API_KEY: 'test-key' });
    assert.equal(cfg.meta.provider, 'openclaude');
    assert.equal(cfg.meta.model, 'gemini-3.1-pro-preview');
    assert.equal(cfg.executable, 'node');
    assert.match(
      cfg.pathToClaudeCodeExecutable ?? '',
      /@gitlawb\/openclaude\/dist\/cli\.mjs$/,
    );
    assert.equal(cfg.env.CLAUDE_CODE_USE_GEMINI, '1');
    assert.equal(cfg.env.GEMINI_API_KEY, 'test-key');
    assert.equal(cfg.env.GEMINI_MODEL, 'gemini-3.1-pro-preview');
  });

  it('honours GEMINI_MODEL override', () => {
    const cfg = resolveProvider({
      GEMINI_API_KEY: 'k',
      GEMINI_MODEL: 'gemini-3.1-flash-lite',
    });
    assert.equal(cfg.meta.model, 'gemini-3.1-flash-lite');
    assert.equal(cfg.env.GEMINI_MODEL, 'gemini-3.1-flash-lite');
  });

  it('returns empty overrides for provider=anthropic', () => {
    const cfg = resolveProvider({ NANOCLAW_LLM_PROVIDER: 'anthropic' });
    assert.equal(cfg.meta.provider, 'anthropic');
    assert.equal(cfg.pathToClaudeCodeExecutable, undefined);
    assert.equal(cfg.executable, undefined);
    assert.deepEqual(cfg.env, {});
  });

  it('throws when provider=openclaude but GEMINI_API_KEY is missing', () => {
    assert.throws(
      () => resolveProvider({ NANOCLAW_LLM_PROVIDER: 'openclaude' }),
      /GEMINI_API_KEY/,
    );
  });

  it('throws on unknown provider value', () => {
    assert.throws(
      () => resolveProvider({ NANOCLAW_LLM_PROVIDER: 'gmini' }),
      /anthropic.*openclaude/,
    );
  });
});
```

**Step 2: Run tests to confirm they fail**

Run: `cd container/agent-runner && npm test 2>&1 | tail -15`
Expected: FAIL with module-not-found error for `./providers.js` (we haven't created it yet).

**Step 3: Do NOT commit yet** (red test alone is not committed — see Task 4 for green+commit).

---

## Task 4: Implement `providers.ts` (TDD green)

**Files:**
- Create: `container/agent-runner/src/providers.ts`

**Step 1: Create the module**

```ts
// container/agent-runner/src/providers.ts
import { createRequire } from 'node:module';

export type LlmProvider = 'anthropic' | 'openclaude';

export interface ProviderConfig {
  pathToClaudeCodeExecutable?: string;
  executable?: 'node' | 'bun';
  env: Record<string, string>;
  meta: { provider: LlmProvider; model?: string };
}

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';
const VALID_PROVIDERS: readonly LlmProvider[] = ['anthropic', 'openclaude'];

const require = createRequire(import.meta.url);

export function resolveProvider(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): ProviderConfig {
  const raw = (sourceEnv.NANOCLAW_LLM_PROVIDER ?? 'openclaude').toLowerCase();

  if (!VALID_PROVIDERS.includes(raw as LlmProvider)) {
    throw new Error(
      `NANOCLAW_LLM_PROVIDER must be one of 'anthropic' or 'openclaude', got: '${raw}'`,
    );
  }
  const provider = raw as LlmProvider;

  if (provider === 'anthropic') {
    return { env: {}, meta: { provider } };
  }

  const geminiKey = sourceEnv.GEMINI_API_KEY;
  if (!geminiKey) {
    throw new Error(
      "GEMINI_API_KEY is required when NANOCLAW_LLM_PROVIDER='openclaude'",
    );
  }
  const model = sourceEnv.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const cliPath = require.resolve('@gitlawb/openclaude/dist/cli.mjs');

  return {
    pathToClaudeCodeExecutable: cliPath,
    executable: 'node',
    env: {
      CLAUDE_CODE_USE_GEMINI: '1',
      GEMINI_API_KEY: geminiKey,
      GEMINI_MODEL: model,
    },
    meta: { provider, model },
  };
}
```

**Step 2: Run tests**

Run: `cd container/agent-runner && npm test 2>&1 | tail -15`
Expected: all 5 tests PASS.

**Step 3: Typecheck the full agent-runner**

Run: `cd container/agent-runner && npm run build 2>&1 | tail -5`
Expected: exit 0, no type errors.

**Step 4: Commit**

```bash
git add container/agent-runner/src/providers.ts container/agent-runner/src/providers.test.ts
git commit -m "feat(agent-runner): add providers resolver with anthropic/openclaude support"
```

---

## Task 5: Wire `providers.ts` into `index.ts`

**Files:**
- Modify: `container/agent-runner/src/index.ts`

**Step 1: Add the import**

At the top of `container/agent-runner/src/index.ts`, near the other `./` imports, add:

```ts
import { resolveProvider } from './providers.js';
```

**Step 2: Call resolveProvider and log**

Just before the `for await (const message of query({...}))` block (around the `log("Additional directories: ...")` area), add:

```ts
const providerCfg = resolveProvider();
log(
  `LLM provider = ${providerCfg.meta.provider}` +
    (providerCfg.meta.model ? ` (${providerCfg.meta.model})` : ''),
);
```

Use `log()` (the agent-runner's own logger, grep to confirm name) rather than `console.log` to match existing style.

**Step 3: Merge provider config into query() options**

Edit the `options: {...}` object:

- Replace `env: sdkEnv,` with `env: { ...sdkEnv, ...providerCfg.env },`
- Add `pathToClaudeCodeExecutable: providerCfg.pathToClaudeCodeExecutable,` (may be `undefined` for anthropic — that's fine, SDK ignores)
- Add `executable: providerCfg.executable,` (same)

**Step 4: Typecheck**

Run: `cd container/agent-runner && npm run build 2>&1 | tail -5`
Expected: exit 0.

**Step 5: Run unit tests (regression check)**

Run: `cd container/agent-runner && npm test 2>&1 | tail -5`
Expected: all 5 tests still pass.

**Step 6: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(agent-runner): use resolveProvider() to pick CLI binary"
```

---

## Task 6: Forward LLM env vars from main process to container

**Files:**
- Modify: `src/container-runner.ts`

**Step 1: Identify the injection point**

Find `buildContainerArgs()` in `src/container-runner.ts`. Just after the `args.push('-e', \`TZ=${TIMEZONE}\`);` line (around line 254), add the LLM env forwarding block.

**Step 2: Insert the forwarding block**

```ts
// Forward LLM provider selection + Gemini credentials (when applicable).
// Validation happens inside the container (providers.ts), so the host only
// forwards whatever env exists in process.env.
const llmProvider = process.env.NANOCLAW_LLM_PROVIDER ?? 'openclaude';
args.push('-e', `NANOCLAW_LLM_PROVIDER=${llmProvider}`);
if (llmProvider === 'openclaude') {
  if (process.env.GEMINI_API_KEY) {
    args.push('-e', `GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
  }
  if (process.env.GEMINI_MODEL) {
    args.push('-e', `GEMINI_MODEL=${process.env.GEMINI_MODEL}`);
  }
}
```

**Step 3: Typecheck the main project**

Run: `npm run build 2>&1 | tail -5`
Expected: exit 0.

**Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat(container-runner): forward LLM provider env to agent container"
```

---

## Task 7: Create `.env.example` and verify `.gitignore`

**Files:**
- Create: `.env.example`
- Verify: `.gitignore` (no modifications expected)

**Step 1: Create `.env.example`**

```bash
# NanoClaw environment contract. Copy to .env and fill in; .env is gitignored.

# LLM provider selection. One of: openclaude | anthropic
# - openclaude: use openclaude CLI + Gemini (default)
# - anthropic:  use official @anthropic-ai/claude-code CLI (fallback)
NANOCLAW_LLM_PROVIDER=openclaude

# Required when NANOCLAW_LLM_PROVIDER=openclaude
GEMINI_API_KEY=

# Optional. Default: gemini-3.1-pro-preview
# Other options: gemini-3.1-flash-lite, gemini-3-flash-preview
# GEMINI_MODEL=gemini-3.1-pro-preview
```

**Step 2: Verify `.env` is already ignored**

Run: `grep -E '^\.env$' .gitignore`
Expected: prints `.env`. (If absent, add it — but earlier check confirmed it is present.)

**Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add .env.example documenting LLM provider env contract"
```

---

## Task 8: Enable `.env` loading in NanoClaw main process

**Files:**
- Modify: `package.json`
- Verify: `~/Library/LaunchAgents/com.nanoclaw.plist` (do not auto-edit — instructions only)

**Step 1: Add `--env-file` to dev and start scripts**

In root `package.json`'s `scripts`:
- Change `"dev": "tsx src/index.ts"` to `"dev": "tsx --env-file=.env src/index.ts"`
- Change `"start": "node dist/index.js"` to `"start": "node --env-file=.env dist/index.js"`

If either script uses a different invocation (check first with `grep -n '"dev"\|"start"' package.json`), adapt accordingly — the goal is that the process starts with `--env-file=.env` whenever `.env` exists.

Use the `--env-file-if-exists=.env` flag variant (Node 22+) so it silently continues when `.env` is absent. If you're on Node < 22, use `--env-file=.env` and ensure `.env` exists (create an empty file if needed).

**Step 2: Build**

Run: `npm run build 2>&1 | tail -5`
Expected: exit 0.

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: load .env via node --env-file-if-exists flag"
```

**Step 4: (Manual) update launchd plist if used**

If you launch NanoClaw via `launchctl`, edit `~/Library/LaunchAgents/com.nanoclaw.plist` so the `ProgramArguments` array passes `--env-file-if-exists=.env` to node. This is a **manual step outside git** (plist is not in repo). Skip if you only run `npm run dev`.

---

## Task 9: Write the real `.env` (local, not committed)

**Files:**
- Create: `.env` (gitignored, do **not** commit)

**Step 1: Create `.env` with the Gemini key**

```bash
cp .env.example .env
# then edit .env to fill GEMINI_API_KEY with the user-provided key (they will paste it in)
```

**Step 2: Verify git is NOT tracking `.env`**

Run: `git status --short .env`
Expected: **empty output** (file is ignored). If it shows the file, STOP — do not commit it, fix `.gitignore` first.

**Step 3: No commit for this task** (intentional — `.env` is personal).

---

## Task 10: Smoke test — image build + typecheck

**Step 1: Rebuild the agent container image**

Run: `./container/build.sh 2>&1 | tail -20`
Expected: exit 0. The image now contains both `/usr/lib/node_modules/@anthropic-ai/claude-code` (globally installed) and `/app/node_modules/@gitlawb/openclaude` (via agent-runner npm install).

If the buildkit cache is stale (no new `openclaude` layer), see CLAUDE.md's "Container Build Cache" note and prune the builder before retrying.

**Step 2: Run all tests end-to-end**

Run:
```bash
npm run build && cd container/agent-runner && npm test && npm run build && cd - && echo "ALL GREEN"
```
Expected: final line `ALL GREEN`.

**Step 3: No commit** (verification step only).

---

## Task 11: Feishu 1v1 end-to-end acceptance

**Precondition:** `.env` populated with real `GEMINI_API_KEY`, NanoClaw main process running (`npm run dev` or launchd restarted), Feishu 1v1 with bot already set up.

**Step 1: Restart NanoClaw so it picks up `.env`**

If using `npm run dev`: stop (Ctrl-C) and re-run `npm run dev`.
If using launchd: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.

**Step 2: Test case 1 — model identity**

In Feishu 1v1, send:
> What model are you using?

Expected:
- Reply text mentions "gemini" (case-insensitive).
- Host-side NanoClaw log (or container log) contains `LLM provider = openclaude (gemini-3.1-pro-preview)`.

**Step 3: Test case 2 — tool call**

Send:
> Read the file README.md in /workspace/group and tell me its first line.

Expected: Reply quotes the actual first line of NanoClaw's README. Proves the `Read` tool works through openclaude → Gemini.

**Step 4: Test case 3 — rollback to Anthropic**

Edit `.env`: set `NANOCLAW_LLM_PROVIDER=anthropic`. Restart NanoClaw (same command as step 1).

Send the same question:
> What model are you using?

Expected: reply mentions "claude"; log shows `LLM provider = anthropic`.

**Step 5: Restore default**

Edit `.env`: set `NANOCLAW_LLM_PROVIDER=openclaude` (or delete the line entirely — the default is `openclaude`). Restart.

**Step 6: Report results**

If all three cases pass, the implementation is ACCEPTED. If any failed, open a debug loop — check container logs, confirm env vars reached the container (`docker exec` / `container exec` into a running container, `env | grep -E 'LLM|GEMINI'`), verify CLI path exists.

**Step 7: No commit** (acceptance step).

---

## Task 12: Update README / CLAUDE.md with the new env var contract

**Files:**
- Modify: `README.md` (if it has a setup / environment section)
- Modify: `CLAUDE.md` (the project one — add provider switch line to "Secrets / Credentials / Proxy" section)

**Step 1: Find the right spot in README**

Run: `grep -n -E 'Environment|ENV|setup|Setup' README.md | head`
Pick the most relevant section. If there's no natural spot, add a short "## Environment" section near Quick Start.

**Step 2: Add the provider note**

A 3-5 line block explaining:
- NanoClaw supports `NANOCLAW_LLM_PROVIDER` env var (default `openclaude`).
- For `openclaude`, set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`).
- For `anthropic`, rely on OneCLI / Keychain as before.
- Point at `.env.example`.

**Step 3: Update CLAUDE.md "Secrets / Credentials / Proxy" section**

Add one sentence: "NanoClaw selects its LLM provider via `NANOCLAW_LLM_PROVIDER` (`openclaude` default, `anthropic` fallback). `GEMINI_API_KEY` and `GEMINI_MODEL` live in project `.env` when using openclaude."

**Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document NANOCLAW_LLM_PROVIDER env var and Gemini setup"
```

---

## Out of scope (tracked for follow-up, not done here)

- Migrate `GEMINI_API_KEY` to OneCLI vault (required before multi-tenant deployment).
- Verify PreCompact hook behavior under Gemini (needs a long session to trigger).
- Verify x-integration `tool()` invocations under Gemini.
- Observe Gemini rate limit behavior in production.
- Cost comparison between providers.

---

## Definition of Done

- Tasks 1–8 committed on `main` (or chosen branch).
- Task 9's `.env` exists locally, gitignored.
- Task 10 smoke test: all green.
- Task 11 Feishu cases 1–3 pass.
- Task 12 docs committed.
- Running NanoClaw without `NANOCLAW_LLM_PROVIDER` set routes all chat through openclaude+Gemini by default.
- Setting `NANOCLAW_LLM_PROVIDER=anthropic` and restarting routes all chat back through the official Anthropic CLI with no code changes.
