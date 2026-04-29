import { describe, it, expect, vi } from 'vitest';
import { checkContainerHealth } from './container-health.js';

describe('checkContainerHealth', () => {
  it('returns running when docker reports running', async () => {
    const fakeExec = vi
      .fn()
      .mockResolvedValue({ stdout: 'running\n', code: 0 });
    expect(await checkContainerHealth('foo', fakeExec)).toEqual({
      status: 'running',
    });
    expect(fakeExec).toHaveBeenCalledWith([
      'docker',
      'inspect',
      '-f',
      '{{.State.Status}}',
      'foo',
    ]);
  });
  it('returns missing when inspect exits nonzero', async () => {
    const fakeExec = vi.fn().mockResolvedValue({ stdout: '', code: 1 });
    expect(await checkContainerHealth('foo', fakeExec)).toEqual({
      status: 'missing',
    });
  });
  it('returns stopped when status is exited', async () => {
    const fakeExec = vi.fn().mockResolvedValue({ stdout: 'exited\n', code: 0 });
    expect(await checkContainerHealth('foo', fakeExec)).toEqual({
      status: 'stopped',
    });
  });
  it('returns stopped on any non-running, non-missing status (e.g. created)', async () => {
    const fakeExec = vi
      .fn()
      .mockResolvedValue({ stdout: 'created\n', code: 0 });
    expect(await checkContainerHealth('foo', fakeExec)).toEqual({
      status: 'stopped',
    });
  });
});
