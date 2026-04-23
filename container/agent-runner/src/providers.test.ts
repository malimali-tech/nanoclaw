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
