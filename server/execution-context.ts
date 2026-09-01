export class WaitUntilTracker {
  private readonly pending = new Set<Promise<void>>();
  private rejected = 0;

  waitUntil(promise: Promise<unknown>): void {
    const tracked = Promise.resolve(promise).then(
      () => undefined,
      () => {
        this.rejected += 1;
      }
    );
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked)).catch(() => {
      // The rejection handler above makes tracked settle successfully. Keep
      // the finally cleanup defensive so shutdown never creates a rejection.
    });
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get rejectedCount(): number {
    return this.rejected;
  }

  async drain(timeoutMs: number): Promise<void> {
    const all = Promise.all([...this.pending]).then(() => undefined);
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }
}

export interface NodeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): never;
}

export function createNodeExecutionContext(
  tracker: WaitUntilTracker
): NodeExecutionContext {
  return {
    waitUntil(promise: Promise<unknown>) {
      tracker.waitUntil(promise);
    },
    passThroughOnException() {
      throw new Error("passThroughOnException is not supported on Node");
    },
  };
}
