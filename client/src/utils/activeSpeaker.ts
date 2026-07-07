export interface ActiveSpeakerOptions {
  // Audio level (0..1) a participant must exceed to count as speaking.
  threshold?: number;
  // A participant must stay above the threshold this long before they can take the spotlight.
  activationMs?: number;
  // Minimum time the current active speaker is held before switching to someone else.
  holdMs?: number;
  // A candidate must be this much louder than the current speaker to interrupt them mid-hold window.
  interruptMargin?: number;
}

export interface ActiveSpeakerTracker {
  // Feed the latest per-participant audio levels; returns the participant id to spotlight now,
  // or null when the active speaker should not change.
  update(levels: Record<string, number>, nowMs: number): string | null;
  getActiveId(): string | null;
  reset(): void;
}

export const DEFAULT_ACTIVE_SPEAKER_OPTIONS: Required<ActiveSpeakerOptions> = {
  threshold: 0.16,
  activationMs: 400,
  holdMs: 2000,
  interruptMargin: 0.12,
};

interface SpeakingState {
  speakingSinceMs: number | null;
  lastLevel: number;
}

export function selectLoudestAboveThreshold(
  levels: Record<string, number>,
  threshold: number
): { id: string; level: number } | null {
  let best: { id: string; level: number } | null = null;
  for (const [id, rawLevel] of Object.entries(levels)) {
    const level = Number.isFinite(rawLevel) ? rawLevel : 0;
    if (level < threshold) continue;
    if (!best || level > best.level) {
      best = { id, level };
    }
  }
  return best;
}

export function createActiveSpeakerTracker(options: ActiveSpeakerOptions = {}): ActiveSpeakerTracker {
  const config = { ...DEFAULT_ACTIVE_SPEAKER_OPTIONS, ...options };
  const speaking = new Map<string, SpeakingState>();
  let activeId: string | null = null;
  let lastSwitchMs = Number.NEGATIVE_INFINITY;

  function reset() {
    speaking.clear();
    activeId = null;
    lastSwitchMs = Number.NEGATIVE_INFINITY;
  }

  function update(levels: Record<string, number>, nowMs: number): string | null {
    // Update per-participant continuous-speaking timers.
    const present = new Set(Object.keys(levels));
    for (const id of present) {
      const level = Number.isFinite(levels[id]) ? levels[id] : 0;
      const state = speaking.get(id) || { speakingSinceMs: null, lastLevel: 0 };
      if (level >= config.threshold) {
        if (state.speakingSinceMs === null) state.speakingSinceMs = nowMs;
      } else {
        state.speakingSinceMs = null;
      }
      state.lastLevel = level;
      speaking.set(id, state);
    }
    // Drop participants no longer reported.
    for (const id of [...speaking.keys()]) {
      if (!present.has(id)) speaking.delete(id);
    }

    // If the active speaker has left, clear so a new one can be chosen immediately.
    if (activeId !== null && !present.has(activeId)) {
      activeId = null;
      lastSwitchMs = Number.NEGATIVE_INFINITY;
    }

    const loudest = selectLoudestAboveThreshold(levels, config.threshold);
    if (!loudest) return null;

    const candidateState = speaking.get(loudest.id);
    const activatedLongEnough = candidateState?.speakingSinceMs !== null
      && candidateState !== undefined
      && nowMs - (candidateState.speakingSinceMs as number) >= config.activationMs;
    if (!activatedLongEnough) return null;

    if (loudest.id === activeId) return null;

    const withinHold = nowMs - lastSwitchMs < config.holdMs;
    if (activeId !== null && withinHold) {
      // Only interrupt an established speaker if the candidate is clearly louder.
      const activeLevel = speaking.get(activeId)?.lastLevel ?? 0;
      if (loudest.level < activeLevel + config.interruptMargin) return null;
    }

    activeId = loudest.id;
    lastSwitchMs = nowMs;
    return activeId;
  }

  return {
    update,
    getActiveId: () => activeId,
    reset,
  };
}
