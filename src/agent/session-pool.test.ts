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

  it('markActive cancels the idle timer; markIdle restarts it', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 1000,
    });
    await pool.getOrCreate('a');
    pool.markActive('a');
    await vi.advanceTimersByTimeAsync(5000);
    expect(dispose).not.toHaveBeenCalled(); // active blocks idle eviction
    pool.markIdle('a');
    await vi.advanceTimersByTimeAsync(500);
    expect(dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('evict during active waits for markIdle, then disposes', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 60000,
    });
    await pool.getOrCreate('a');
    pool.markActive('a');
    const evictPromise = pool.evict('a');
    // Even after a long pause, dispose hasn't fired — we're waiting on markIdle.
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispose).not.toHaveBeenCalled();
    pool.markIdle('a');
    await evictPromise;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('evict during active forces dispose after forceDisposeAfterMs', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => ({ id: k, dispose }),
      idleMs: 60000,
      forceDisposeAfterMs: 5000,
    });
    await pool.getOrCreate('a');
    pool.markActive('a');
    const evictPromise = pool.evict('a');
    await vi.advanceTimersByTimeAsync(6000);
    await evictPromise;
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('getOrCreate during disposing waits then rebuilds', async () => {
    let disposeResolver!: () => void;
    const disposePromise = new Promise<void>((r) => {
      disposeResolver = r;
    });
    const dispose = vi.fn().mockReturnValue(disposePromise);
    let factoryCalls = 0;
    const pool = new SessionPool<FakeSession>({
      factory: async (k) => {
        factoryCalls += 1;
        return { id: `${k}-${factoryCalls}`, dispose };
      },
      idleMs: 60000,
    });
    const first = await pool.getOrCreate('a');
    expect(first.id).toBe('a-1');
    const evictPromise = pool.evict('a'); // enters disposing
    const secondPromise = pool.getOrCreate('a'); // should wait
    // Resolve the in-flight dispose
    disposeResolver();
    await evictPromise;
    const second = await secondPromise;
    expect(second.id).toBe('a-2');
    expect(factoryCalls).toBe(2);
  });
});
