export interface DisposableSession {
  dispose: () => Promise<void> | void;
}

export interface SessionPoolOptions<T> {
  factory: (key: string) => Promise<T>;
  idleMs: number;
}

interface Entry<T> {
  promise: Promise<T>;
  timer: NodeJS.Timeout;
}

export class SessionPool<T extends DisposableSession> {
  private entries = new Map<string, Entry<T>>();
  constructor(private opts: SessionPoolOptions<T>) {}

  async getOrCreate(key: string): Promise<T> {
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing.promise;
    }
    const promise = this.opts.factory(key);
    const timer = setTimeout(() => void this.evict(key), this.opts.idleMs);
    const entry: Entry<T> = { promise, timer };
    this.entries.set(key, entry);
    try {
      await promise;
    } catch (err) {
      clearTimeout(timer);
      this.entries.delete(key);
      throw err;
    }
    return promise;
  }

  private touch(key: string, entry: Entry<T>): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.evict(key), this.opts.idleMs);
  }

  async evict(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    clearTimeout(entry.timer);
    try {
      const session = await entry.promise;
      await session.dispose();
    } catch {
      /* swallow disposal errors */
    }
  }

  async disposeAll(): Promise<void> {
    const keys = [...this.entries.keys()];
    await Promise.all(keys.map((k) => this.evict(k)));
  }

  size(): number {
    return this.entries.size;
  }
}
