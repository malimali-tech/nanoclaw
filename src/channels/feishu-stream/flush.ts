/**
 * Throttled flush controller for streaming card updates.
 *
 * Pure scheduling primitive — no Feishu/CardKit knowledge. The actual update
 * call is supplied via the `doFlush` callback. Adapted from openclaw-lark's
 * `card/flush-controller.ts` (MIT, ByteDance).
 *
 * Three behaviours combine:
 *   1. **Mutex** — only one `doFlush` runs at a time; concurrent callers wait.
 *   2. **Throttle** — successive `throttledUpdate` calls coalesce within a
 *      `throttleMs` window into a single deferred flush.
 *   3. **Reflush on conflict** — events arriving while a flush is in flight
 *      schedule an immediate follow-up so we don't lose the tail.
 */

const LONG_GAP_THRESHOLD_MS = 2000;
const BATCH_AFTER_GAP_MS = 80;

export class FlushController {
  private flushInProgress = false;
  private flushResolvers: Array<() => void> = [];
  private needsReflush = false;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateTime = 0;
  private isCompleted = false;
  private ready = false;

  constructor(private readonly doFlush: () => Promise<void>) {}

  /** Marks the underlying card as ready to receive updates. */
  setReady(ready: boolean): void {
    this.ready = ready;
    if (ready) this.lastUpdateTime = Date.now();
  }

  /** No more flushes will be scheduled or executed after the current one. */
  complete(): void {
    this.isCompleted = true;
  }

  cancelPending(): void {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }

  /** Resolves once any in-flight flush settles. */
  waitForFlush(): Promise<void> {
    if (!this.flushInProgress) return Promise.resolve();
    return new Promise<void>((resolve) => this.flushResolvers.push(resolve));
  }

  async flush(): Promise<void> {
    if (!this.ready || this.flushInProgress || this.isCompleted) {
      if (this.flushInProgress && !this.isCompleted) this.needsReflush = true;
      return;
    }
    this.flushInProgress = true;
    this.needsReflush = false;
    // Stamp lastUpdateTime *before* the API call so a concurrent caller
    // entering throttledUpdate sees us as "just flushed".
    this.lastUpdateTime = Date.now();
    try {
      await this.doFlush();
      this.lastUpdateTime = Date.now();
    } finally {
      this.flushInProgress = false;
      const resolvers = this.flushResolvers;
      this.flushResolvers = [];
      for (const resolve of resolvers) resolve();
      if (this.needsReflush && !this.isCompleted && !this.pendingFlushTimer) {
        this.needsReflush = false;
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null;
          void this.flush();
        }, 0);
      }
    }
  }

  async throttledUpdate(throttleMs: number): Promise<void> {
    if (!this.ready || this.isCompleted) return;
    const now = Date.now();
    const elapsed = now - this.lastUpdateTime;
    if (elapsed >= throttleMs) {
      this.cancelPending();
      if (elapsed > LONG_GAP_THRESHOLD_MS) {
        // After a long quiet period batch briefly so the first visible
        // update isn't a single character.
        this.lastUpdateTime = now;
        this.pendingFlushTimer = setTimeout(() => {
          this.pendingFlushTimer = null;
          void this.flush();
        }, BATCH_AFTER_GAP_MS);
      } else {
        await this.flush();
      }
    } else if (!this.pendingFlushTimer) {
      const delay = throttleMs - elapsed;
      this.pendingFlushTimer = setTimeout(() => {
        this.pendingFlushTimer = null;
        void this.flush();
      }, delay);
    }
  }
}
