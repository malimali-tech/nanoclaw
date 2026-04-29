import path from 'node:path';

export interface PathMapConfig {
  repoRoot: string;
  groupsDir: string;
  storeDir: string;
  globalDir: string;
}

const PROJECT_PREFIX = '/workspace/project';
const STORE_PREFIX = '/workspace/store';
const GROUPS_PREFIX = '/workspace/groups';
const GLOBAL_PREFIX = '/workspace/global';

/**
 * Translate a host-absolute path under the nanoclaw repo into the corresponding
 * container-side path under `/workspace/...`.
 *
 * This is the single point that enforces the sandbox boundary: any path that
 * does not resolve into one of the four configured roots throws.
 */
export function mapHostPath(p: string, cfg: PathMapConfig): string {
  const resolved = path.resolve(p);

  // Order matters: most-specific roots first, since globalDir is a sub-path of
  // groupsDir, and storeDir may be a sub-path of repoRoot.
  const roots: Array<{ host: string; container: string }> = [
    { host: cfg.globalDir, container: GLOBAL_PREFIX },
    { host: cfg.groupsDir, container: GROUPS_PREFIX },
    { host: cfg.storeDir, container: STORE_PREFIX },
    { host: cfg.repoRoot, container: PROJECT_PREFIX },
  ];

  for (const { host, container } of roots) {
    const rel = path.relative(host, resolved);
    if (rel === '') {
      return container;
    }
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return path.posix.join(container, rel.split(path.sep).join('/'));
    }
  }

  throw new Error(`Path is outside sandbox-mounted roots: ${p}`);
}
