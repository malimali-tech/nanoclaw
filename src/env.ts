import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

// Provider env vars recognised by @mariozechner/pi-coding-agent.
// Anchored at line start so prefix substrings won't false-match.
export const PI_PROVIDER_ENV_RE =
  /^(ANTHROPIC_API_KEY|ANTHROPIC_OAUTH_TOKEN|OPENAI_API_KEY|AZURE_OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_CLOUD_API_KEY|DEEPSEEK_API_KEY|GROQ_API_KEY|XAI_API_KEY|MISTRAL_API_KEY|CEREBRAS_API_KEY|AWS_BEARER_TOKEN_BEDROCK|PI_OAUTH)=/m;

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
