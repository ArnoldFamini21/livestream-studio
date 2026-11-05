/**
 * CSS timing functions and overlay presence for the program canvas, so the
 * broadcast animates overlays with the same curves and durations the stage
 * preview's CSS transitions use.
 */

export type EasingFunction = (t: number) => number;

/** A CSS cubic-bezier(x1, y1, x2, y2) timing function. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFunction {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDerivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveX = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-6) return t;
      const derivative = sampleDerivativeX(t);
      if (Math.abs(derivative) < 1e-6) break;
      t -= error / derivative;
    }
    // Bisection when Newton's method does not converge.
    let low = 0;
    let high = 1;
    t = x;
    while (low < high) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-6) return t;
      if (x > value) low = t;
      else high = t;
      const next = (low + high) / 2;
      if (Math.abs(next - t) < 1e-7) return next;
      t = next;
    }
    return t;
  };

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveX(t));
  };
}

export const EASE_IN = cubicBezier(0.42, 0, 1, 1);
export const EASE_OUT = cubicBezier(0, 0, 0.58, 1);

/** Progress through a transition of `durationMs` that started `elapsedMs` ago, eased. */
export function transitionProgress(elapsedMs: number, durationMs: number, easing: EasingFunction): number {
  if (durationMs <= 0) return 1;
  return easing(Math.min(1, Math.max(0, elapsedMs / durationMs)));
}

export type OverlayPhase = 'entering' | 'exiting';

export interface OverlayPresence<T> {
  id: string;
  data: T;
  phase: OverlayPhase;
  /** When the current phase began (ms, same clock as `now`). */
  since: number;
}

/**
 * Remembers when each overlay appeared and disappeared, and keeps a hidden
 * overlay's last data for its exit animation. `update` takes the overlays
 * that should be on screen now.
 */
export class OverlayPresenceTracker<T> {
  private readonly items = new Map<string, OverlayPresence<T>>();

  constructor(private readonly exitMs: number) {}

  update(visible: ReadonlyArray<{ id: string; data: T }>, now: number): OverlayPresence<T>[] {
    const visibleIds = new Set<string>();
    for (const item of visible) {
      visibleIds.add(item.id);
      const current = this.items.get(item.id);
      if (!current || current.phase === 'exiting') {
        this.items.set(item.id, { id: item.id, data: item.data, phase: 'entering', since: now });
      } else {
        current.data = item.data;
      }
    }
    for (const [id, item] of this.items) {
      if (visibleIds.has(id)) continue;
      if (item.phase === 'entering') {
        this.items.set(id, { ...item, phase: 'exiting', since: now });
      } else if (now - item.since >= this.exitMs) {
        this.items.delete(id);
      }
    }
    return Array.from(this.items.values());
  }
}
