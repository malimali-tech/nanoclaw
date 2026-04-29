// container/agent-runner/src/providers.ts
import { createRequire } from 'node:module';

export type LlmProvider = 'anthropic' | 'openclaude' | 'open-agent-sdk';

// open-agent-sdk mode is locked to OpenAI-compatible endpoints only.
export type OpenAgentApiType = 'openai-completions';

export interface OpenAgentSdkConfig {
  apiType: OpenAgentApiType;
  model: string;
  apiKey: string;
  baseURL?: string;
}

export interface ProviderConfig {
  pathToClaudeCodeExecutable?: string;
  executable?: 'node' | 'bun';
  env: Record<string, string>;
  meta: { provider: LlmProvider; model?: string };
  // Set only when provider runs the agent loop in-process via @codeany/open-agent-sdk
  // (no claude-code CLI subprocess).
  sdkConfig?: OpenAgentSdkConfig;
}

const DEFAULT_OPENCLAUDE_MODEL = 'deepseek-chat';
const OPEN_AGENT_API_TYPE: OpenAgentApiType = 'openai-completions';
const DEFAULT_OPEN_AGENT_MODEL = 'deepseek-chat';

const require = createRequire(import.meta.url);

const VALID_PROVIDER_SET = new Set<string>([
  'anthropic',
  'openclaude',
  'open-agent-sdk',
]);

function parseProvider(raw: string): LlmProvider {
  if (!VALID_PROVIDER_SET.has(raw)) {
    throw new Error(
      `NANOCLAW_LLM_PROVIDER must be one of 'anthropic', 'openclaude', or 'open-agent-sdk', got: '${raw}'`,
    );
  }
  return raw as LlmProvider;
}

export function resolveProvider(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): ProviderConfig {
  const raw = (sourceEnv.NANOCLAW_LLM_PROVIDER ?? 'openclaude').toLowerCase();
  const provider = parseProvider(raw);

  // Discriminated switch over a LlmProvider-typed value — TS forces a new
  // case whenever the union grows (the never default becomes unreachable and
  // the compiler errors on 'const _exhaustive: never = provider').
  switch (provider) {
    case 'anthropic':
      return { env: {}, meta: { provider: 'anthropic' } };
    case 'openclaude':
      return buildOpenclaudeConfig(sourceEnv);
    case 'open-agent-sdk':
      return buildOpenAgentSdkConfig(sourceEnv);
    default: {
      const _exhaustive: never = provider;
      throw new Error(
        `Unhandled provider: '${_exhaustive}'`,
      );
    }
  }
}

// Unified inputs across all providers. Per-upstream env names (GEMINI_*,
// CODEANY_*) are derived inside each builder — callers only ever set the
// NANOCLAW_LLM_* trio.
function readUnifiedEnv(sourceEnv: NodeJS.ProcessEnv, provider: LlmProvider) {
  const apiKey = sourceEnv.NANOCLAW_LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      `NANOCLAW_LLM_API_KEY is required when NANOCLAW_LLM_PROVIDER='${provider}'`,
    );
  }
  return {
    apiKey,
    model: sourceEnv.NANOCLAW_LLM_MODEL?.trim() || undefined,
    baseURL: sourceEnv.NANOCLAW_LLM_BASE_URL?.trim() || undefined,
  };
}

function buildOpenclaudeConfig(
  sourceEnv: NodeJS.ProcessEnv,
): ProviderConfig {
  const { apiKey, model: modelOverride, baseURL } = readUnifiedEnv(
    sourceEnv,
    'openclaude',
  );
  const model = modelOverride || DEFAULT_OPENCLAUDE_MODEL;
  const cliPath = require.resolve('@gitlawb/openclaude/dist/cli.mjs');

  // openclaude CLI (a claude-code fork) supports OpenAI-compatible backends
  // via CLAUDE_CODE_USE_OPENAI. Translate the unified inputs to OPENAI_*.
  const env: Record<string, string> = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_API_KEY: apiKey,
    OPENAI_MODEL: model,
  };
  if (baseURL) env.OPENAI_BASE_URL = baseURL;

  // Explicitly clear conflicting backend flags so a stale CLAUDE_CODE_USE_GEMINI
  // (or similar) inherited from process.env can't override our OpenAI mode.
  for (const flag of [
    'CLAUDE_CODE_USE_GEMINI',
    'CLAUDE_CODE_USE_MISTRAL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_GITHUB',
    'GEMINI_API_KEY',
    'GEMINI_MODEL',
    'GEMINI_BASE_URL',
  ]) {
    env[flag] = '';
  }

  try {
    const debugLine = `[${new Date().toISOString()}] openclaude → CLAUDE_CODE_USE_OPENAI=1 OPENAI_MODEL=${model} OPENAI_BASE_URL=${baseURL ?? '<default>'} apiKey.len=${apiKey.length} provider_env_keys=${Object.keys(env).sort().join(',')} processEnv_USE_GEMINI=${sourceEnv.CLAUDE_CODE_USE_GEMINI ?? '<unset>'} processEnv_OPENAI_BASE=${sourceEnv.OPENAI_BASE_URL ?? '<unset>'}\n`;
    require('node:fs').appendFileSync('/workspace/group/.providers-debug.log', debugLine);
  } catch {
    /* best-effort debug */
  }

  return {
    pathToClaudeCodeExecutable: cliPath,
    executable: 'node',
    env,
    meta: { provider: 'openclaude', model },
  };
}

function buildOpenAgentSdkConfig(
  sourceEnv: NodeJS.ProcessEnv,
): ProviderConfig {
  const { apiKey, model: modelOverride, baseURL } = readUnifiedEnv(
    sourceEnv,
    'open-agent-sdk',
  );
  const model = modelOverride || DEFAULT_OPEN_AGENT_MODEL;

  // @codeany/open-agent-sdk accepts these via createAgent({apiKey, model,
  // baseURL}) directly, but we also surface them as CODEANY_* in the env
  // so any nested SDK lookup falls back consistently.
  const env: Record<string, string> = {
    CODEANY_API_KEY: apiKey,
    CODEANY_API_TYPE: OPEN_AGENT_API_TYPE,
    CODEANY_MODEL: model,
  };
  if (baseURL) env.CODEANY_BASE_URL = baseURL;

  return {
    env,
    meta: { provider: 'open-agent-sdk', model },
    sdkConfig: { apiType: OPEN_AGENT_API_TYPE, model, apiKey, baseURL },
  };
}
