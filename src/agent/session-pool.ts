// src/agent/session-pool.ts
//
// Per-key disposable session pool with idle TTL. Adds an explicit
// lifecycle state machine so that idle eviction never tears down a
// session mid-prompt:
//
//   idle ──markActive──▶ active ──markIdle──▶ idle
//    │                     │                    │
//    │                     │ evict()            │ evict()
//    ▼                     ▼                    ▼
//   disposing  ◀──── (wait whenIdle, max forceDisposeAfterMs)
//
//   getOrCreate during disposing ──▶ awaits dispose, then rebuilds
//
// run.ts brackets each `session.prompt(...)` call with markActive /
// markIdle so the pool can defer eviction until the agent has settled.

export interface DisposableSession {
  dispose: () => Promise<void> | void;
}

export interface SessionPoolOptions<T> {
  factory: (key: string) => Promise<T>;
  idleMs: number;
  /** Cap on how long `evict` will wait for an active session to settle
   *  before forcing dispose anyway. Defaults to 30 s. */
  forceDisposeAfterMs?: number;
}

type EntryState = 'creating' | 'idle' | 'active' | 'disposing';

interface Entry<T> {
  promise: Promise<T>;
  state: EntryState;
  timer: NodeJS.Timeout | null;
  pendingEvict: boolean;
  idleWaiters: Array<() => void>;
  disposing: Promise<void> | null;
}

const DEFAULT_FORCE_DISPOSE_MS = 30000;

export class SessionPool<T extends DisposableSession> {
  private entries = new Map<string, Entry<T>>();

  constructor(private opts: SessionPoolOptions<T>) {}

  async getOrCreate(key: string): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.state === 'disposing') {
        // Wait for the in-flight dispose, then build a fresh entry. We
        // recurse into getOrCreate so concurrent waiters all coalesce on
        // the same new entry.
        await existing.disposing;
        return this.getOrCreate(key);
      }
      this.touch(key, existing);
      return existing.promise;
    }

    const promise = this.opts.factory(key);
    const entry: Entry<T> = {
      promise,
      state: 'creating',
      timer: null,
      pendingEvict: false,
      idleWaiters: [],
      disposing: null,
    };
    this.entries.set(key, entry);

    try {
      await promise;
    } catch (err) {
      this.entries.delete(key);
      throw err;
    }
    // Only transition to idle if no one evicted us mid-creation.
    if (this.entries.get(key) === entry) {
      entry.state = 'idle';
      this.touch(key, entry);
    }
    return promise;
  }

  /** Mark the session as actively servicing a prompt. Cancels the idle
   *  timer; markIdle must be called when the prompt finishes. No-op if
   *  the entry is gone or in a non-idle state. */
  markActive(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.state !== 'idle') return;
    entry.state = 'active';
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /** Inverse of markActive. Restarts the idle timer; if an evict was
   *  deferred while active, it fires now. */
  markIdle(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.state !== 'active') return;
    entry.state = 'idle';
    const waiters = entry.idleWaiters.splice(0);
    for (const w of waiters) w();
    if (entry.pendingEvict) {
      void this.evict(key);
    } else {
      this.touch(key, entry);
    }
  }

  private touch(key: string, entry: Entry<T>): void {
    if (entry.state !== 'idle') return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.evict(key), this.opts.idleMs);
  }

  async evict(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.state === 'disposing') {
      await entry.disposing;
      return;
    }

    if (entry.state === 'active') {
      // Defer until the prompt finishes, but cap the wait so a stuck
      // session can't pin the container forever.
      entry.pendingEvict = true;
      const idleNotice = new Promise<void>((resolve) =>
        entry.idleWaiters.push(resolve),
      );
      const cap =
        this.opts.forceDisposeAfterMs ?? DEFAULT_FORCE_DISPOSE_MS;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timer = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, cap);
      });
      await Promise.race([idleNotice, timer]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      // Re-fetch — the entry may have been replaced by a parallel
      // getOrCreate after a faster evict path completed.
      const refreshed = this.entries.get(key);
      if (!refreshed || refreshed !== entry) return;
      // markIdle ran inside the wait window: pendingEvict already triggered
      // a self-recursive evict() that may be ahead of us — bail.
      if (refreshed.state === 'disposing') {
        await refreshed.disposing;
        return;
      }
    }

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.state = 'disposing';
    const disposed = (async () => {
      try {
        const session = await entry.promise;
        await session.dispose();
      } catch {
        /* swallow disposal errors */
      } finally {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }
    })();
    entry.disposing = disposed;
    await disposed;
  }

  async disposeAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((k) => this.evict(k)));
  }

  size(): number {
    return this.entries.size;
  }

  /** @internal — for tests */
  _stateOf(key: string): EntryState | undefined {
    return this.entries.get(key)?.state;
  }
}
