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

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';
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
  const { apiKey, model: modelOverride } = readUnifiedEnv(sourceEnv, 'openclaude');
  const model = modelOverride || DEFAULT_GEMINI_MODEL;
  const cliPath = require.resolve('@gitlawb/openclaude/dist/cli.mjs');

  // openclaude CLI (a claude-code fork) reads these specific env vars at
  // runtime — translate the unified inputs to its native names.
  return {
    pathToClaudeCodeExecutable: cliPath,
    executable: 'node',
    env: {
      CLAUDE_CODE_USE_GEMINI: '1',
      GEMINI_API_KEY: apiKey,
      GEMINI_MODEL: model,
    },
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
