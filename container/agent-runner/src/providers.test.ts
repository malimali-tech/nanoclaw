// container/agent-runner/src/providers.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider } from './providers.js';

describe('resolveProvider', () => {
  it('defaults to openclaude + gemini-3.1-pro-preview when only API key is set', () => {
    const cfg = resolveProvider({ NANOCLAW_LLM_API_KEY: 'test-key' });
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

  it('honours NANOCLAW_LLM_MODEL override for openclaude', () => {
    const cfg = resolveProvider({
      NANOCLAW_LLM_API_KEY: 'k',
      NANOCLAW_LLM_MODEL: 'gemini-3.1-flash-lite',
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

  it('throws when provider=openclaude but NANOCLAW_LLM_API_KEY is missing', () => {
    assert.throws(
      () => resolveProvider({ NANOCLAW_LLM_PROVIDER: 'openclaude' }),
      /NANOCLAW_LLM_API_KEY/,
    );
  });

  it('throws on unknown provider value', () => {
    assert.throws(
      () => resolveProvider({ NANOCLAW_LLM_PROVIDER: 'gmini' }),
      /anthropic.*openclaude.*open-agent-sdk/,
    );
  });

  it('treats whitespace-only NANOCLAW_LLM_API_KEY as missing', () => {
    assert.throws(
      () => resolveProvider({ NANOCLAW_LLM_API_KEY: '   ' }),
      /NANOCLAW_LLM_API_KEY/,
    );
  });

  it('returns sdkConfig for provider=open-agent-sdk with defaults', () => {
    const cfg = resolveProvider({
      NANOCLAW_LLM_PROVIDER: 'open-agent-sdk',
      NANOCLAW_LLM_API_KEY: 'sk-test',
    });
    assert.equal(cfg.meta.provider, 'open-agent-sdk');
    assert.equal(cfg.meta.model, 'deepseek-chat');
    assert.equal(cfg.pathToClaudeCodeExecutable, undefined);
    assert.equal(cfg.executable, undefined);
    assert.equal(cfg.sdkConfig?.apiType, 'openai-completions');
    assert.equal(cfg.sdkConfig?.model, 'deepseek-chat');
    assert.equal(cfg.sdkConfig?.apiKey, 'sk-test');
    assert.equal(cfg.sdkConfig?.baseURL, undefined);
    assert.equal(cfg.env.CODEANY_API_KEY, 'sk-test');
    assert.equal(cfg.env.CODEANY_API_TYPE, 'openai-completions');
    assert.equal(cfg.env.CODEANY_MODEL, 'deepseek-chat');
    assert.equal(cfg.env.CODEANY_BASE_URL, undefined);
  });

  it('passes through NANOCLAW_LLM_MODEL / NANOCLAW_LLM_BASE_URL for open-agent-sdk', () => {
    const cfg = resolveProvider({
      NANOCLAW_LLM_PROVIDER: 'open-agent-sdk',
      NANOCLAW_LLM_API_KEY: 'sk-test',
      NANOCLAW_LLM_MODEL: 'deepseek-reasoner',
      NANOCLAW_LLM_BASE_URL: 'https://api.deepseek.com/v1',
    });
    assert.equal(cfg.sdkConfig?.apiType, 'openai-completions');
    assert.equal(cfg.sdkConfig?.model, 'deepseek-reasoner');
    assert.equal(cfg.sdkConfig?.baseURL, 'https://api.deepseek.com/v1');
    assert.equal(cfg.env.CODEANY_BASE_URL, 'https://api.deepseek.com/v1');
  });

  it('throws when provider=open-agent-sdk but NANOCLAW_LLM_API_KEY is missing', () => {
    assert.throws(
      () => resolveProvider({ NANOCLAW_LLM_PROVIDER: 'open-agent-sdk' }),
      /NANOCLAW_LLM_API_KEY/,
    );
  });
});
