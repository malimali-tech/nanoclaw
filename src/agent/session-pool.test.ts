import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionPool } from './session-pool.js';

interface FakeSession {
  dispose: () => Promise<void>;
  id: string;
}

describe('SessionPool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates session lazily and reuses on second hit', async () => {
    const factory = vi.fn(
      async (key: string): Promise<FakeSession> => ({
        id: key,
        dispose: vi.fn().mockResolvedValue(undefined),
      }),
    );
    const pool = new SessionPool<FakeSession>({ factory, idleMs: 1000 });
    const s1 = await pool.getOrCreate('a');
    const s2 = await pool.getOrCreate('a');
    expect(s1).toBe(s2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('disposes session after idle TTL', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 1000,
    });
    await pool.getOrCreate('a');
    await vi.advanceTimersByTimeAsync(1500);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await pool.getOrCreate('a')).toBeDefined();
  });

  it('disposeAll clears every entry', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 60000,
    });
    await pool.getOrCreate('a');
    await pool.getOrCreate('b');
    await pool.disposeAll();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('getOrCreate resets idle timer (touch)', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 1000,
    });
    await pool.getOrCreate('a');
    await vi.advanceTimersByTimeAsync(800);
    await pool.getOrCreate('a');
    await vi.advanceTimersByTimeAsync(800);
    expect(dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
