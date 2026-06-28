import type { CSSProperties } from 'react';

export type StagePresencePhase = 'entering' | 'present' | 'leaving';

export interface StagePresenceTrackedItem<T extends { id: string }> {
  item: T;
  phase: StagePresencePhase;
  startedAtMs: number;
}

interface StagePresenceTransitionOptions {
  enterMs?: number;
  exitMs?: number;
}

export const STAGE_PRESENCE_ENTER_MS = 320;
export const STAGE_PRESENCE_EXIT_MS = 260;

const MIN_TRANSITION_MS = 120;
const MAX_TRANSITION_MS = 1500;
const TIMER_PADDING_MS = 16;
const TIMER_MIN_DELAY_MS = 16;
const STAGE_PRESENCE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

function normalizeDurationMs(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_TRANSITION_MS, Math.max(MIN_TRANSITION_MS, Math.round(value || fallback)));
}

function getEnterMs(options?: StagePresenceTransitionOptions): number {
  return normalizeDurationMs(options?.enterMs, STAGE_PRESENCE_ENTER_MS);
}

function getExitMs(options?: StagePresenceTransitionOptions): number {
  return normalizeDurationMs(options?.exitMs, STAGE_PRESENCE_EXIT_MS);
}

function isTransitionElapsed(startedAtMs: number, nowMs: number, durationMs: number): boolean {
  return nowMs - startedAtMs >= durationMs;
}

export function reconcileStagePresenceItems<T extends { id: string }>(
  currentItems: T[],
  previousItems: StagePresenceTrackedItem<T>[],
  nowMs = Date.now(),
  options?: StagePresenceTransitionOptions
): StagePresenceTrackedItem<T>[] {
  const enterMs = getEnterMs(options);
  const exitMs = getExitMs(options);
  const previousById = new Map(previousItems.map((tracked) => [tracked.item.id, tracked]));
  const currentIds = new Set<string>();
  const next: StagePresenceTrackedItem<T>[] = [];

  for (const item of currentItems) {
    if (currentIds.has(item.id)) continue;
    currentIds.add(item.id);

    const previous = previousById.get(item.id);
    if (!previous || previous.phase === 'leaving') {
      next.push({ item, phase: 'entering', startedAtMs: nowMs });
      continue;
    }

    const phase = previous.phase === 'entering' && !isTransitionElapsed(previous.startedAtMs, nowMs, enterMs)
      ? 'entering'
      : 'present';
    next.push({ item, phase, startedAtMs: previous.startedAtMs });
  }

  for (const previous of previousItems) {
    if (currentIds.has(previous.item.id)) continue;

    if (previous.phase === 'leaving') {
      if (!isTransitionElapsed(previous.startedAtMs, nowMs, exitMs)) {
        next.push(previous);
      }
      continue;
    }

    next.push({ item: previous.item, phase: 'leaving', startedAtMs: nowMs });
  }

  return next;
}

export function getStagePresenceTransitionDelayMs(
  items: StagePresenceTrackedItem<{ id: string }>[],
  nowMs = Date.now(),
  options?: StagePresenceTransitionOptions
): number {
  const enterMs = getEnterMs(options);
  const exitMs = getExitMs(options);
  let nextDelayMs = Number.POSITIVE_INFINITY;

  for (const item of items) {
    const durationMs = item.phase === 'entering' ? enterMs : item.phase === 'leaving' ? exitMs : 0;
    if (!durationMs) continue;
    const remainingMs = durationMs - (nowMs - item.startedAtMs);
    if (remainingMs > 0) nextDelayMs = Math.min(nextDelayMs, remainingMs);
  }

  if (!Number.isFinite(nextDelayMs)) return 0;
  return Math.max(TIMER_MIN_DELAY_MS, Math.ceil(nextDelayMs) + TIMER_PADDING_MS);
}

export function getStagePresenceWrapperStyle(
  phase: StagePresencePhase,
  options?: StagePresenceTransitionOptions
): CSSProperties {
  if (phase === 'present') return {};

  const durationMs = phase === 'entering' ? getEnterMs(options) : getExitMs(options);
  return {
    animation: `stage-presence-${phase === 'entering' ? 'enter' : 'leave'} ${durationMs}ms ${STAGE_PRESENCE_EASING} both`,
    pointerEvents: phase === 'leaving' ? 'none' : undefined,
    willChange: 'opacity, transform, filter',
  };
}
