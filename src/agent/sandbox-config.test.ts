import { describe, it, expect } from 'vitest';
import { loadSandboxConfig } from './sandbox-config.js';

describe('loadSandboxConfig', () => {
  it('returns the built-in default config', () => {
    const cfg = loadSandboxConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.network?.allowedDomains).toContain('registry.npmjs.org');
    expect(cfg.filesystem?.allowWrite).toContain('.');
  });

  it('takes no arguments — per-group overrides are intentionally unsupported', () => {
    // Calling with a path argument used to load groups/<g>/.pi/sandbox.json,
    // letting an agent rewrite its own sandbox policy. The signature is now
    // a no-arg function; this test exists to document the removal.
    expect(loadSandboxConfig.length).toBe(0);
  });
});
