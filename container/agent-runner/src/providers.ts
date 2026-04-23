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
