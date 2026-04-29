import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadSandboxConfig } from './sandbox-config.js';

describe('loadSandboxConfig', () => {
  it('returns built-in default when no project override exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcfg-'));
    const cfg = loadSandboxConfig(tmp);
    expect(cfg.enabled).toBe(true);
    expect(cfg.network?.allowedDomains).toContain('registry.npmjs.org');
  });

  it('deep-merges project override over defaults', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcfg-'));
    fs.mkdirSync(path.join(tmp, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.pi', 'sandbox.json'),
      JSON.stringify({
        network: { allowedDomains: ['my.example.com'] },
        filesystem: { denyWrite: ['secret.txt'] },
      }),
    );
    const cfg = loadSandboxConfig(tmp);
    expect(cfg.network?.allowedDomains).toEqual(['my.example.com']);
    expect(cfg.filesystem?.denyWrite).toEqual(['secret.txt']);
    expect(cfg.filesystem?.allowWrite).toContain('.'); // default preserved
  });

  it('disables when project sets enabled=false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcfg-'));
    fs.mkdirSync(path.join(tmp, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.pi', 'sandbox.json'),
      JSON.stringify({ enabled: false }),
    );
    expect(loadSandboxConfig(tmp).enabled).toBe(false);
  });
});
