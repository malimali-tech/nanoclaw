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

const require = createRequire(import.meta.url);

const VALID_PROVIDER_SET = new Set<string>(['anthropic', 'openclaude']);

function parseProvider(raw: string): LlmProvider {
  if (!VALID_PROVIDER_SET.has(raw)) {
    throw new Error(
      `NANOCLAW_LLM_PROVIDER must be one of 'anthropic' or 'openclaude', got: '${raw}'`,
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
    default: {
      const _exhaustive: never = provider;
      throw new Error(
        `Unhandled provider: '${_exhaustive}'`,
      );
    }
  }
}

function buildOpenclaudeConfig(
  sourceEnv: NodeJS.ProcessEnv,
): ProviderConfig {
  const geminiKey = sourceEnv.GEMINI_API_KEY?.trim();
  if (!geminiKey) {
    throw new Error(
      "GEMINI_API_KEY is required when NANOCLAW_LLM_PROVIDER='openclaude'",
    );
  }
  const model = sourceEnv.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const cliPath = require.resolve('@gitlawb/openclaude/dist/cli.mjs');

  return {
    pathToClaudeCodeExecutable: cliPath,
    executable: 'node',
    env: {
      CLAUDE_CODE_USE_GEMINI: '1',
      GEMINI_API_KEY: geminiKey,
      GEMINI_MODEL: model,
    },
    meta: { provider: 'openclaude', model },
  };
}
