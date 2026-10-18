export class RelayOperationCancelledError extends Error {
  constructor() {
    super('The live relay operation was canceled.');
    this.name = 'RelayOperationCancelledError';
  }
}

export function isRelayOperationCancelled(error: unknown): boolean {
  return error instanceof RelayOperationCancelledError;
}

/** One startup or live session. Canceling it permanently invalidates its pending work. */
export class RelayOperation {
  private readonly controller = new AbortController();

  get signal(): AbortSignal { return this.controller.signal; }
  get active(): boolean { return !this.signal.aborted; }

  cancel(): void { this.controller.abort(); }

  assertActive(): void {
    if (!this.active) throw new RelayOperationCancelledError();
  }

  async run<T>(task: () => Promise<T>, releaseAbandoned?: (value: T) => void): Promise<T> {
    this.assertActive();
    const pending = task();
    return new Promise<T>((resolve, reject) => {
      const onCancel = () => reject(new RelayOperationCancelledError());
      this.signal.addEventListener('abort', onCancel, { once: true });
      if (!this.active) onCancel();
      pending.then((value) => {
        this.signal.removeEventListener('abort', onCancel);
        if (!this.active) {
          // A mixer can finish building after cancellation. Its resources still
          // belong to this operation and must never be installed in a newer one.
          try { releaseAbandoned?.(value); } catch { /* Best-effort cleanup of abandoned resources. */ }
          reject(new RelayOperationCancelledError());
        } else {
          resolve(value);
        }
      }, (error: unknown) => {
        this.signal.removeEventListener('abort', onCancel);
        reject(this.active ? error : new RelayOperationCancelledError());
      });
    });
  }
}

/** Keeps startup single-flight and prevents an old completion from releasing a newer attempt. */
export class RelayOperationSlot {
  private current: RelayOperation | null = null;

  get active(): boolean { return this.current?.active === true; }

  begin(): RelayOperation | null {
    if (this.active) return null;
    this.current = new RelayOperation();
    return this.current;
  }

  cancel(): void {
    const operation = this.current;
    this.current = null;
    operation?.cancel();
  }

  finish(operation: RelayOperation): void {
    if (this.current === operation) this.cancel();
  }
}

interface RelayStartupWatchdogOptions {
  timeoutMs: number;
  onTimeout: () => void;
  onCancel: () => void;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** A stopped or completed handshake must never leave a watchdog that can affect the next session. */
export function watchRelayStartup(operation: RelayOperation, options: RelayStartupWatchdogOptions): () => void {
  let finished = false;
  let clearTimer = () => {};
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimer();
    operation.signal.removeEventListener('abort', onCancel);
  };
  const onCancel = () => {
    if (finished) return;
    finish();
    options.onCancel();
  };
  operation.signal.addEventListener('abort', onCancel, { once: true });
  if (!operation.active) {
    onCancel();
    return finish;
  }
  const schedule = options.schedule ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  clearTimer = schedule(() => {
    if (finished) return;
    finish();
    if (operation.active) options.onTimeout();
  }, options.timeoutMs);
  return finish;
}

/** Shared by first startup and reconnect authorization; no stale token can start a relay. */
export async function startAuthorizedRelay(
  operation: RelayOperation,
  authorize: () => Promise<string>,
  start: (token: string) => Promise<void>,
  onStarted?: () => void,
): Promise<void> {
  const token = await operation.run(authorize);
  operation.assertActive();
  await operation.run(() => start(token));
  operation.assertActive();
  onStarted?.();
}
