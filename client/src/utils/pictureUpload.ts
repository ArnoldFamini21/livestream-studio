/**
 * Shared plumbing for sending a picture to the studio's image store (studio
 * logo, canvas background): a time limit per attempt, a few attempts with a
 * growing pause, and one upload per picture however often it is asked for.
 */

export const PICTURE_UPLOAD_ATTEMPT_TIMEOUT_MS = 15_000;
export const PICTURE_UPLOAD_MAX_ATTEMPTS = 3;
export const PICTURE_UPLOAD_FIRST_PAUSE_MS = 1_000;

/** An upload that will not succeed however often it is repeated (picture too large, not allowed). */
export class PermanentUploadError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'PermanentUploadError';
  }
}

export class UploadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The upload did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = 'UploadTimeoutError';
  }
}

export interface RetryOptions {
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  /** Pause before attempt n+1 is firstPauseMs * 2^(n-1): 1 s, 2 s, ... */
  firstPauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onAttemptFailed?: (error: unknown, attempt: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` with a time limit and a few retries. The signal handed to the
 * attempt aborts when its time is up. A PermanentUploadError stops at once.
 */
export async function runWithRetry<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const timeoutMs = options.attemptTimeoutMs ?? PICTURE_UPLOAD_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? PICTURE_UPLOAD_MAX_ATTEMPTS);
  const firstPause = options.firstPauseMs ?? PICTURE_UPLOAD_FIRST_PAUSE_MS;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let number = 1; number <= maxAttempts; number += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new UploadTimeoutError(timeoutMs));
        }, timeoutMs);
      });
      return await Promise.race([attempt(controller.signal), timedOut]);
    } catch (error) {
      lastError = error;
      options.onAttemptFailed?.(error, number);
      if (error instanceof PermanentUploadError) throw error;
      if (number < maxAttempts) await sleep(firstPause * 2 ** (number - 1));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The picture could not be uploaded');
}

/** Remembers each picture's image id, and the upload still in flight, by key; failures are not remembered. */
export interface PictureUploadCache {
  /** The id of an already uploaded picture, if any. */
  get(key: string): string | undefined;
  /** Upload once per key: later calls share the id, or the upload still running. */
  upload(key: string, start: () => Promise<string>): Promise<string>;
  /** Forget everything (the server restarted, or the participant rejoined: ids are no longer valid). */
  clear(): void;
}

export function createPictureUploadCache(): PictureUploadCache {
  const done = new Map<string, string>();
  const running = new Map<string, Promise<string>>();
  let generation = 0;
  return {
    get: (key) => done.get(key),
    upload(key, start) {
      const known = done.get(key);
      if (known) return Promise.resolve(known);
      const inFlight = running.get(key);
      if (inFlight) return inFlight;
      const startedIn = generation;
      const promise = start().then((id) => {
        // An upload that started before a rejoin names a picture the studio may no longer hold.
        if (startedIn === generation) done.set(key, id);
        return id;
      }).finally(() => {
        if (running.get(key) === promise) running.delete(key);
      });
      running.set(key, promise);
      return promise;
    },
    clear() {
      generation += 1;
      done.clear();
      running.clear();
    },
  };
}
