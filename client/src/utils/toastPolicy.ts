export type ToastType = 'success' | 'error' | 'warning' | 'info';

/** Most toasts on screen at once; the oldest dismissible ones go first. */
export const MAX_VISIBLE_TOASTS = 4;

const DEFAULT_DURATIONS_MS: Record<ToastType, number> = {
  // Errors (a recording that did not save, a stream that failed) stay until dismissed.
  error: 0,
  warning: 8_000,
  success: 5_000,
  info: 5_000,
};

/** How long a toast stays; 0 means until the user dismisses it. */
export function getToastDurationMs(type: ToastType, requested?: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 0) return requested;
  return DEFAULT_DURATIONS_MS[type];
}

/** Errors interrupt a screen reader; everything else waits its turn. */
export function getToastRole(type: ToastType): 'alert' | 'status' {
  return type === 'error' ? 'alert' : 'status';
}

export interface ToastTimerState {
  remainingMs: number;
  startedAt: number | null;
}

/** Pause a running auto-dismiss timer (hover or keyboard focus), keeping the time that is left. */
export function pauseToastTimer(state: ToastTimerState, now: number): ToastTimerState {
  if (state.startedAt === null) return state;
  return { remainingMs: Math.max(0, state.remainingMs - (now - state.startedAt)), startedAt: null };
}

export function resumeToastTimer(state: ToastTimerState, now: number): ToastTimerState {
  if (state.startedAt !== null) return state;
  // Give a reader at least a couple of seconds after they move away.
  return { remainingMs: Math.max(2_000, state.remainingMs), startedAt: now };
}

/**
 * Which toasts to keep when a new one would exceed the limit: drop the oldest
 * auto-dismissing ones first, and only then the oldest persistent ones.
 */
export function selectToastsToKeep<T extends { persistent: boolean }>(toasts: T[], limit = MAX_VISIBLE_TOASTS): T[] {
  if (toasts.length <= limit) return toasts;
  const result = [...toasts];
  while (result.length > limit) {
    const index = result.findIndex((toast) => !toast.persistent);
    result.splice(index >= 0 ? index : 0, 1);
  }
  return result;
}
