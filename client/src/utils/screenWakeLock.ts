/**
 * Keeps the screen (and with it camera, mic and the local recorders) awake
 * while recording, live or on stage. Browsers release a wake lock whenever
 * the page is hidden, so it is re-acquired when the page becomes visible.
 */

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

interface VisibilityDocument {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export type ScreenWakeLockStatus = 'unsupported' | 'idle' | 'held' | 'released' | 'error';

export interface ScreenWakeLockController {
  setActive(active: boolean): void;
  status(): ScreenWakeLockStatus;
  dispose(): void;
}

export function createScreenWakeLockController(input: {
  wakeLock?: WakeLockLike | null;
  document?: VisibilityDocument | null;
  onStatus?: (status: ScreenWakeLockStatus) => void;
} = {}): ScreenWakeLockController {
  const wakeLock = input.wakeLock === undefined
    ? (typeof navigator !== 'undefined' ? (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock : undefined)
    : input.wakeLock;
  const doc = input.document === undefined ? (typeof document !== 'undefined' ? document : null) : input.document;
  let active = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let requesting: Promise<void> | null = null;
  let current: ScreenWakeLockStatus = wakeLock ? 'idle' : 'unsupported';
  const setStatus = (status: ScreenWakeLockStatus) => {
    if (status === current) return;
    current = status;
    try { input.onStatus?.(status); } catch { /* Observers must not break the lock. */ }
  };

  const acquire = () => {
    if (!wakeLock || !active || requesting || (sentinel && !sentinel.released)) return;
    if (doc && doc.visibilityState !== 'visible') return;
    requesting = wakeLock.request('screen').then((lock) => {
      if (!active) { void lock.release().catch(() => {}); setStatus('idle'); return; }
      sentinel = lock;
      setStatus('held');
      lock.addEventListener?.('release', () => {
        if (sentinel === lock) sentinel = null;
        setStatus(active ? 'released' : 'idle');
      });
    }, () => {
      // Denied (battery saver, iframe policy) or the page was hidden.
      setStatus('error');
    }).finally(() => { requesting = null; });
  };

  const onVisibility = () => {
    if (doc?.visibilityState === 'visible') acquire();
  };
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    setActive(next) {
      active = next;
      if (next) { acquire(); return; }
      const lock = sentinel;
      sentinel = null;
      if (lock && !lock.released) void lock.release().catch(() => {});
      if (wakeLock) setStatus('idle');
    },
    status: () => current,
    dispose() {
      this.setActive(false);
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
