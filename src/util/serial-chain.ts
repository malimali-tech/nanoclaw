/**
 * Serialize async work onto a single FIFO chain. Failure isolation: a
 * rejected step does not block subsequent steps, and the rejection still
 * propagates to the caller of `run`.
 */
export class SerialChain {
  private chain: Promise<void> = Promise.resolve();

  /** Schedule fn to run after all prior runs settle. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Resolves once all currently-scheduled work has settled (success or fail). */
  drain(): Promise<void> {
    return this.chain;
  }
}

/** Per-key FIFO chains. Each key gets its own SerialChain. */
export class KeyedSerialChain<K = string> {
  private readonly chains = new Map<K, SerialChain>();

  run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    let c = this.chains.get(key);
    if (!c) {
      c = new SerialChain();
      this.chains.set(key, c);
    }
    return c.run(fn);
  }

  drainAll(): Promise<void> {
    return Promise.all(
      [...this.chains.values()].map((c) => c.drain()),
    ) as unknown as Promise<void>;
  }

  clear(): void {
    this.chains.clear();
  }
}
