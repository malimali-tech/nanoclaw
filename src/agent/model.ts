import type { ModelRegistry } from '@mariozechner/pi-coding-agent';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * Resolve the LLM model to use for an AgentSession.
 * Honors NANOCLAW_LLM_MODEL ("provider/id") env var; falls back to
 * deepseek/deepseek-v4-flash. Returns undefined (pi auto-picks) if the
 * configured model is not registered.
 */
export function resolveModel(registry: ModelRegistry) {
  const raw = process.env.NANOCLAW_LLM_MODEL?.trim() || DEFAULT_MODEL;
  const slash = raw.indexOf('/');
  if (slash <= 0) return undefined;
  const provider = raw.slice(0, slash);
  const id = raw.slice(slash + 1);
  return registry.find(provider, id) ?? undefined;
}
