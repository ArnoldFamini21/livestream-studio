/**
 * Is the studio's audio clock running?
 *
 * The program mix (what the relay records) lives in the studio's Web Audio
 * context. Chrome drives that context from the computer's sound output device.
 * When the device misbehaves (a Bluetooth headset that went away, a virtual
 * device whose driver is not running) the context can say "running" while its
 * clock does not move. Nothing in it renders, so the recorder gets no sound
 * and produces no chunks at all.
 *
 * judgeAudioClock is the pure judgement. checkProgramAudioClock and
 * restoreAudioOutputClock run the check against a context; the sleep and the
 * clock are injected so a fake context can test them without real waiting.
 * useBroadcastAudioBus wraps them as checkProgramAudio / restoreAudioOutput.
 */

/** "recovered": the clock was stuck and moves again now the context has no sound device. */
export type ProgramAudioState = 'running' | 'recovered' | 'stuck';

export interface ProgramAudioCheck {
  state: ProgramAudioState;
}

/** Less audio time than this in a second of wall time means the clock is stuck. */
export const AUDIO_CLOCK_MIN_ADVANCE_SECONDS = 0.2;
/** Wall time that must pass before a full judgement; less is judged in proportion. */
export const AUDIO_CLOCK_MIN_ELAPSED_MS = 1_000;
/** How long the first look at the clock lasts. */
export const AUDIO_CLOCK_WINDOW_MS = 1_200;
/** How long the clock is watched after the sound device is switched. */
export const AUDIO_CLOCK_AFTER_SWITCH_MS = 800;
/** The longest a resume or a sound-device switch may take before it counts as no answer. */
export const AUDIO_CLOCK_CALL_TIMEOUT_MS = 500;

export function judgeAudioClock(input: {
  /** The context state, read after any resume. */
  state: string;
  /** currentTime (seconds) at the start of the window. */
  before: number;
  /** currentTime (seconds) at the end of the window. */
  after: number;
  /** Wall time between the two reads, in ms. */
  elapsedMs: number;
}): 'running' | 'stuck' {
  const { state, before, after, elapsedMs } = input;
  if (state !== 'running') return 'stuck';
  // A clock nobody can read is not a clock that runs.
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 'stuck';
  // Without a usable stretch of wall time nothing can be proved; do not call it stuck.
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 'running';
  // At a full second or more, 0.2 s must have passed. A shorter look is judged in proportion.
  const required = AUDIO_CLOCK_MIN_ADVANCE_SECONDS * Math.min(1, elapsedMs / AUDIO_CLOCK_MIN_ELAPSED_MS);
  return after - before < required ? 'stuck' : 'running';
}

/** The part of an AudioContext the check uses. */
export interface ClockedAudioContext {
  readonly state: string;
  readonly currentTime: number;
  resume(): Promise<void>;
  /** Chrome: "none" gives the context no sound device; it then runs on a timer. */
  setSinkId?: (sinkId: string | { type: 'none' }) => Promise<void>;
}

export interface AudioClockDeps {
  sleep: (ms: number) => Promise<void>;
  /** A millisecond clock (performance.now or Date.now). */
  now: () => number;
}

export interface AudioClockResult extends ProgramAudioCheck {
  /** The context now has no sound device, because of this call. */
  outputOff: boolean;
}

/** Ends a call that may never answer: false when it failed or timed out. */
async function settleWithin(call: () => Promise<unknown>, ms: number, deps: AudioClockDeps): Promise<boolean> {
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(call).then(() => 'done' as const, () => 'failed' as const),
      deps.sleep(ms).then(() => 'timeout' as const),
    ]);
    return outcome === 'done';
  } catch {
    return false;
  }
}

async function resumeIfNeeded(context: ClockedAudioContext, deps: AudioClockDeps): Promise<void> {
  if (context.state === 'running' || context.state === 'closed') return;
  await settleWithin(() => context.resume(), AUDIO_CLOCK_CALL_TIMEOUT_MS, deps);
}

/** Watch the clock for windowMs and judge it. */
async function watchClock(context: ClockedAudioContext, windowMs: number, deps: AudioClockDeps): Promise<'running' | 'stuck'> {
  const startedAt = deps.now();
  const before = context.currentTime;
  await deps.sleep(windowMs);
  const after = context.currentTime;
  return judgeAudioClock({ state: context.state, before, after, elapsedMs: deps.now() - startedAt });
}

function setSinkNone(context: ClockedAudioContext, deps: AudioClockDeps): Promise<boolean> {
  if (typeof context.setSinkId !== 'function') return Promise.resolve(false);
  return settleWithin(() => context.setSinkId!({ type: 'none' }), AUDIO_CLOCK_CALL_TIMEOUT_MS, deps);
}

/**
 * Resume if needed, look at the clock for about 1.2 s. If it does not move,
 * take the sound device away from the context and look again for 0.8 s.
 * Takes about 3 s at most and never throws.
 */
export async function checkProgramAudioClock(context: ClockedAudioContext, deps: AudioClockDeps): Promise<AudioClockResult> {
  let outputOff = false;
  try {
    await resumeIfNeeded(context, deps);
    if (await watchClock(context, AUDIO_CLOCK_WINDOW_MS, deps) === 'running') {
      return { state: 'running', outputOff };
    }

    // Stuck. Without a sound device the context runs on a timer.
    if (!(await setSinkNone(context, deps))) return { state: 'stuck', outputOff };
    outputOff = true;
    await resumeIfNeeded(context, deps);
    const after = await watchClock(context, AUDIO_CLOCK_AFTER_SWITCH_MS, deps);
    return { state: after === 'running' ? 'recovered' : 'stuck', outputOff };
  } catch {
    // The check itself failed; that proves nothing about the clock.
    return { state: 'running', outputOff };
  }
}

/**
 * Give the context its default sound device back and check that the clock
 * still runs. If it does not, go back to no sound device. True when the sound
 * is back on; false when it stays off. Never throws.
 */
export async function restoreAudioOutputClock(context: ClockedAudioContext, deps: AudioClockDeps): Promise<{ restored: boolean; outputOff: boolean }> {
  if (typeof context.setSinkId !== 'function') return { restored: false, outputOff: true };
  try {
    const switched = await settleWithin(() => context.setSinkId!(''), AUDIO_CLOCK_CALL_TIMEOUT_MS, deps);
    if (switched) {
      await resumeIfNeeded(context, deps);
      if (await watchClock(context, AUDIO_CLOCK_WINDOW_MS, deps) === 'running') {
        return { restored: true, outputOff: false };
      }
    }
  } catch {
    // Fall through to switching the sound device off again.
  }
  // If even this does not answer, the device state is unknown: keep saying the sound is off.
  await setSinkNone(context, deps);
  return { restored: false, outputOff: true };
}
