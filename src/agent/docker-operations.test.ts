import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PathMapConfig } from './path-map.js';

type DockerExecCall = {
  container: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
  onData: (b: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
};

const calls: DockerExecCall[] = [];
type ExecResponder = (call: DockerExecCall) => {
  exitCode: number;
  output?: string;
};
let responder: ExecResponder = () => ({ exitCode: 0, output: '' });

vi.mock('./docker-exec.js', () => ({
  dockerExec: vi.fn(async (args: DockerExecCall) => {
    calls.push(args);
    const r = responder(args);
    if (r.output && r.output.length > 0) {
      args.onData(Buffer.from(r.output, 'utf8'));
    }
    return { exitCode: r.exitCode };
  }),
}));

import {
  createDockerBashOperations,
  createDockerReadOperations,
  createDockerEditOperations,
  createDockerWriteOperations,
  createDockerGrepOperations,
  createDockerFindOperations,
  createDockerLsOperations,
  createDockerOperations,
  shellQuote,
  type DockerOpsConfig,
} from './docker-operations.js';

const paths: PathMapConfig = {
  repoRoot: '/abs/nanoclaw',
  groupsDir: '/abs/nanoclaw/groups',
  storeDir: '/abs/nanoclaw/store',
  globalDir: '/abs/nanoclaw/groups/global',
};

const cfg: DockerOpsConfig = { container: 'sb', paths };

beforeEach(() => {
  calls.length = 0;
  responder = () => ({ exitCode: 0, output: '' });
});

describe('shellQuote', () => {
  it('wraps in single quotes', () => {
    expect(shellQuote('hello')).toBe(`'hello'`);
  });
  it('escapes interior single quotes', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });
  it('handles paths with spaces and quotes', () => {
    expect(shellQuote(`a b'c`)).toBe(`'a b'\\''c'`);
  });
});

describe('bash operations', () => {
  it('forwards command with mapped cwd and env', async () => {
    const bash = createDockerBashOperations(cfg);
    const seen: string[] = [];
    const { exitCode } = await bash.exec(
      'echo hi',
      '/abs/nanoclaw/groups/main',
      {
        onData: (b) => seen.push(b.toString()),
        env: { FOO: 'bar' },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].container).toBe('sb');
    expect(calls[0].cwd).toBe('/workspace/groups/main');
    expect(calls[0].command).toBe('echo hi');
    expect(calls[0].env).toEqual({ FOO: 'bar' });
  });

  it('throws when cwd escapes sandbox', async () => {
    const bash = createDockerBashOperations(cfg);
    await expect(
      bash.exec('echo', '/etc', { onData: () => {} }),
    ).rejects.toThrow(/outside/);
  });

  it('passes signal and timeout through', async () => {
    const bash = createDockerBashOperations(cfg);
    const ac = new AbortController();
    await bash.exec('true', '/abs/nanoclaw', {
      onData: () => {},
      signal: ac.signal,
      timeout: 5,
    });
    expect(calls[0].signal).toBe(ac.signal);
    expect(calls[0].timeout).toBe(5);
  });
});

describe('read operations', () => {
  it('readFile cats the mapped path and returns Buffer', async () => {
    responder = () => ({ exitCode: 0, output: 'file body' });
    const read = createDockerReadOperations(cfg);
    const buf = await read.readFile('/abs/nanoclaw/src/index.ts');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString()).toBe('file body');
    expect(calls[0].command).toBe(`cat -- '/workspace/project/src/index.ts'`);
  });

  it('access uses test -r and rejects on nonzero', async () => {
    responder = () => ({ exitCode: 1 });
    const read = createDockerReadOperations(cfg);
    await expect(read.access('/abs/nanoclaw/x')).rejects.toThrow(/access/);
    expect(calls[0].command).toBe(`test -r '/workspace/project/x'`);
  });

  it('readFile escapes single quotes in path', async () => {
    responder = () => ({ exitCode: 0, output: '' });
    const read = createDockerReadOperations(cfg);
    await read.readFile(`/abs/nanoclaw/it's.txt`);
    expect(calls[0].command).toBe(`cat -- '/workspace/project/it'\\''s.txt'`);
  });
});

describe('edit operations', () => {
  it('readFile reads and writeFile pipes content via env', async () => {
    responder = () => ({ exitCode: 0, output: '' });
    const edit = createDockerEditOperations(cfg);
    await edit.writeFile('/abs/nanoclaw/foo.txt', "hello 'world'\nline2");
    expect(calls[0].command).toBe(
      `printf '%s' "$NANOCLAW_CONTENT" > '/workspace/project/foo.txt'`,
    );
    expect(calls[0].env).toEqual({
      NANOCLAW_CONTENT: "hello 'world'\nline2",
    });
  });

  it('access checks both -r and -w', async () => {
    const edit = createDockerEditOperations(cfg);
    await edit.access('/abs/nanoclaw/foo');
    expect(calls[0].command).toBe(
      `test -r '/workspace/project/foo' && test -w '/workspace/project/foo'`,
    );
  });
});

describe('write operations', () => {
  it('writeFile passes content through env (no shell injection)', async () => {
    const write = createDockerWriteOperations(cfg);
    const evil = `'; rm -rf / #`;
    await write.writeFile('/abs/nanoclaw/x', evil);
    // Content is in env, command does not contain it.
    expect(calls[0].command).not.toContain('rm -rf');
    expect(calls[0].env?.NANOCLAW_CONTENT).toBe(evil);
  });

  it('mkdir uses mkdir -p with mapped path', async () => {
    const write = createDockerWriteOperations(cfg);
    await write.mkdir('/abs/nanoclaw/groups/main/sub');
    expect(calls[0].command).toBe(`mkdir -p -- '/workspace/groups/main/sub'`);
  });

  it('rejects unmapped destinations', async () => {
    const write = createDockerWriteOperations(cfg);
    await expect(write.writeFile('/etc/shadow', 'x')).rejects.toThrow(
      /outside/,
    );
  });
});

describe('grep operations', () => {
  it('isDirectory returns true on exit 0', async () => {
    responder = () => ({ exitCode: 0 });
    const grep = createDockerGrepOperations(cfg);
    expect(await grep.isDirectory('/abs/nanoclaw/src')).toBe(true);
  });

  it('isDirectory returns false on exit 1 (exists, not dir)', async () => {
    responder = () => ({ exitCode: 1 });
    const grep = createDockerGrepOperations(cfg);
    expect(await grep.isDirectory('/abs/nanoclaw/foo')).toBe(false);
  });

  it('isDirectory throws on exit 2 (does not exist)', async () => {
    responder = () => ({ exitCode: 2 });
    const grep = createDockerGrepOperations(cfg);
    await expect(grep.isDirectory('/abs/nanoclaw/missing')).rejects.toThrow(
      /does not exist/,
    );
  });

  it('readFile returns string', async () => {
    responder = () => ({ exitCode: 0, output: 'contents' });
    const grep = createDockerGrepOperations(cfg);
    expect(await grep.readFile('/abs/nanoclaw/x')).toBe('contents');
  });
});

describe('find operations', () => {
  it('exists returns boolean from test -e', async () => {
    responder = () => ({ exitCode: 0 });
    const find = createDockerFindOperations(cfg);
    expect(await find.exists('/abs/nanoclaw/x')).toBe(true);
    responder = () => ({ exitCode: 1 });
    expect(await find.exists('/abs/nanoclaw/x')).toBe(false);
  });

  it('glob runs in mapped cwd and passes pattern via env', async () => {
    responder = () => ({ exitCode: 0, output: 'a.ts\nb.ts\n' });
    const find = createDockerFindOperations(cfg);
    const results = await find.glob('**/*.ts', '/abs/nanoclaw/src', {
      ignore: ['**/node_modules/**'],
      limit: 100,
    });
    expect(results).toEqual(['a.ts', 'b.ts']);
    expect(calls[0].cwd).toBe('/workspace/project/src');
    expect(calls[0].env?.NANOCLAW_PATTERN).toBe('**/*.ts');
    expect(calls[0].env?.NANOCLAW_IGNORE_0).toBe('**/node_modules/**');
    expect(calls[0].env?.NANOCLAW_IGNORE_COUNT).toBe('1');
    expect(calls[0].env?.NANOCLAW_LIMIT).toBe('100');
    // The pattern must NOT be inlined into the command string
    expect(calls[0].command).not.toContain('**/*.ts');
  });

  it('glob returns empty array for no output', async () => {
    responder = () => ({ exitCode: 0, output: '' });
    const find = createDockerFindOperations(cfg);
    const results = await find.glob('*.none', '/abs/nanoclaw', {
      ignore: [],
      limit: 10,
    });
    expect(results).toEqual([]);
  });
});

describe('ls operations', () => {
  it('exists returns boolean', async () => {
    responder = () => ({ exitCode: 0 });
    const ls = createDockerLsOperations(cfg);
    expect(await ls.exists('/abs/nanoclaw/x')).toBe(true);
  });

  it('stat returns isDirectory true for dir', async () => {
    let n = 0;
    responder = () => ({ exitCode: n++ === 0 ? 0 : 0 });
    const ls = createDockerLsOperations(cfg);
    const s = await ls.stat('/abs/nanoclaw/src');
    expect(s.isDirectory()).toBe(true);
  });

  it('stat throws when path missing', async () => {
    responder = () => ({ exitCode: 1 });
    const ls = createDockerLsOperations(cfg);
    await expect(ls.stat('/abs/nanoclaw/missing')).rejects.toThrow(
      /does not exist/,
    );
  });

  it('readdir splits ls output', async () => {
    responder = () => ({ exitCode: 0, output: 'a\nb\n.hidden\n' });
    const ls = createDockerLsOperations(cfg);
    const entries = await ls.readdir('/abs/nanoclaw/src');
    expect(entries).toEqual(['a', 'b', '.hidden']);
    expect(calls[0].command).toBe(`ls -1A -- '/workspace/project/src'`);
  });
});

describe('bundle factory', () => {
  it('returns all 7 typed operations', () => {
    const ops = createDockerOperations(cfg);
    expect(typeof ops.bash.exec).toBe('function');
    expect(typeof ops.read.readFile).toBe('function');
    expect(typeof ops.edit.writeFile).toBe('function');
    expect(typeof ops.write.writeFile).toBe('function');
    expect(typeof ops.grep.isDirectory).toBe('function');
    expect(typeof ops.find.glob).toBe('function');
    expect(typeof ops.ls.readdir).toBe('function');
  });
});
