import { describe, it, expect } from 'vitest';
import { mapHostPath, type PathMapConfig } from './path-map.js';

const cfg: PathMapConfig = {
  repoRoot: '/abs/nanoclaw',
  groupsDir: '/abs/nanoclaw/groups',
  storeDir: '/abs/nanoclaw/store',
  globalDir: '/abs/nanoclaw/groups/global',
};

describe('mapHostPath', () => {
  it('maps repo root', () => {
    expect(mapHostPath('/abs/nanoclaw/src/index.ts', cfg)).toBe(
      '/workspace/project/src/index.ts',
    );
  });
  it('maps store', () => {
    expect(mapHostPath('/abs/nanoclaw/store/messages.db', cfg)).toBe(
      '/workspace/store/messages.db',
    );
  });
  it('maps groups', () => {
    expect(mapHostPath('/abs/nanoclaw/groups/main/notes.md', cfg)).toBe(
      '/workspace/groups/main/notes.md',
    );
  });
  it('maps global', () => {
    expect(mapHostPath('/abs/nanoclaw/groups/global/x.md', cfg)).toBe(
      '/workspace/global/x.md',
    );
  });
  it('throws on path outside roots', () => {
    expect(() => mapHostPath('/etc/passwd', cfg)).toThrow(/outside/);
  });
  it('rejects path traversal', () => {
    expect(() => mapHostPath('/abs/nanoclaw/../etc/passwd', cfg)).toThrow();
  });
});
