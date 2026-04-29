import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { dockerExec } from './docker-exec.js';

const haveDocker = (() => {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const NAME = 'nanoclaw-docker-exec-test';

describe.skipIf(!haveDocker)('dockerExec', () => {
  beforeAll(() => {
    execSync(`docker rm -f ${NAME} 2>/dev/null || true`);
    execSync(`docker run -d --name ${NAME} debian:12-slim sleep infinity`, {
      stdio: 'pipe',
    });
  });
  afterAll(() => {
    execSync(`docker rm -f ${NAME}`, { stdio: 'pipe' });
  });

  it('streams stdout and returns exit code 0', async () => {
    const chunks: string[] = [];
    const { exitCode } = await dockerExec({
      container: NAME,
      cwd: '/',
      command: 'echo hello && echo world',
      onData: (b) => chunks.push(b.toString()),
    });
    expect(exitCode).toBe(0);
    expect(chunks.join('')).toMatch(/hello[\s\S]*world/);
  });

  it('returns nonzero exit on command failure', async () => {
    const { exitCode } = await dockerExec({
      container: NAME,
      cwd: '/',
      command: 'exit 42',
      onData: () => {},
    });
    expect(exitCode).toBe(42);
  });

  it('rejects when AbortSignal fires', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(
      dockerExec({
        container: NAME,
        cwd: '/',
        command: 'sleep 5',
        onData: () => {},
        signal: ac.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it('rejects on timeout', async () => {
    await expect(
      dockerExec({
        container: NAME,
        cwd: '/',
        command: 'sleep 5',
        onData: () => {},
        timeout: 0.1,
      }),
    ).rejects.toThrow(/timeout/i);
  });

  it('honors --workdir', async () => {
    const out: string[] = [];
    await dockerExec({
      container: NAME,
      cwd: '/etc',
      command: 'pwd',
      onData: (b) => out.push(b.toString()),
    });
    expect(out.join('').trim()).toBe('/etc');
  });

  it('forwards env vars via -e flags', async () => {
    const out: string[] = [];
    await dockerExec({
      container: NAME,
      cwd: '/',
      command: 'echo "$FOO"',
      onData: (b) => out.push(b.toString()),
      env: { FOO: 'bar' },
    });
    expect(out.join('').trim()).toBe('bar');
  });
});
