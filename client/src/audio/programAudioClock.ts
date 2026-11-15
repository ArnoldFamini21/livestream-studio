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
export const AUDIO_CLOCK_CALL_TIMEOUT_MS = 400;
/**
 * The sound-device switch is the recovery itself, and tearing down a stuck
 * output can be slow: it is given longer. If it still has not answered, that
 * is not a failure: the switch may land a moment later, so the clock is watched
 * as if it had.
 */
export const AUDIO_CLOCK_SINK_TIMEOUT_MS = 1_000;
/**
 * A second, longer look when the clock still does not move after the switch.
 * Calling the clock stuck ends the broadcast, and a real stuck device could not
 * be tried out, so the switch gets the benefit of the doubt once.
 */
export const AUDIO_CLOCK_SECOND_LOOK_MS = 1_500;

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
  // The small margin keeps floating point (10.2 - 10 is 0.19999...) from deciding exactly at the limit.
  return after - before < required - 1e-9 ? 'stuck' : 'running';
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
  /** How long a resume may take (default AUDIO_CLOCK_CALL_TIMEOUT_MS). */
  callTimeoutMs?: number;
  /** How long a sound-device switch may take (default AUDIO_CLOCK_SINK_TIMEOUT_MS). */
  sinkCallTimeoutMs?: number;
}

export interface AudioClockResult extends ProgramAudioCheck {
  /** The context now has no sound device, because of this call. */
  outputOff: boolean;
}

/** How a call that may never answer ended. */
type CallResult = 'ok' | 'failed' | 'timeout';

function callWithin(call: () => Promise<unknown>, timeoutMs: number): Promise<CallResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    Promise.resolve().then(call).then(
      () => { clearTimeout(timer); resolve('ok'); },
      () => { clearTimeout(timer); resolve('failed'); }
    );
  });
}

/** Ends a call that may never answer: false when it failed or timed out. */
async function settleWithin(call: () => Promise<unknown>, deps: AudioClockDeps): Promise<boolean> {
  return (await callWithin(call, deps.callTimeoutMs ?? AUDIO_CLOCK_CALL_TIMEOUT_MS)) === 'ok';
}

async function resumeIfNeeded(context: ClockedAudioContext, deps: AudioClockDeps): Promise<void> {
  if (context.state === 'running' || context.state === 'closed') return;
  await settleWithin(() => context.resume(), deps);
}

/** Watch the clock for windowMs and judge it. */
async function watchClock(context: ClockedAudioContext, windowMs: number, deps: AudioClockDeps): Promise<'running' | 'stuck'> {
  const startedAt = deps.now();
  const before = context.currentTime;
  await deps.sleep(windowMs);
  const after = context.currentTime;
  return judgeAudioClock({ state: context.state, before, after, elapsedMs: deps.now() - startedAt });
}

function switchSink(context: ClockedAudioContext, sinkId: string | { type: 'none' }, deps: AudioClockDeps): Promise<CallResult> {
  if (typeof context.setSinkId !== 'function') return Promise.resolve('failed');
  return callWithin(() => context.setSinkId!(sinkId), deps.sinkCallTimeoutMs ?? AUDIO_CLOCK_SINK_TIMEOUT_MS);
}

/**
 * Resume if needed, look at the clock for about 1.2 s. If it does not move,
 * take the sound device away from the context and look again for 0.8 s, and
 * once more for 1.5 s if it still does not move. Takes about 5.5 s at most (a
 * resume that does not answer is given 0.4 s, a device switch 1 s) and never
 * throws. A device switch that has not answered in time is not counted as a
 * failure: it may land a moment later, so the clock is watched as if it had and
 * the sound output is reported as off.
 */
export async function checkProgramAudioClock(context: ClockedAudioContext, deps: AudioClockDeps): Promise<AudioClockResult> {
  let outputOff = false;
  try {
    await resumeIfNeeded(context, deps);
    if (await watchClock(context, AUDIO_CLOCK_WINDOW_MS, deps) === 'running') {
      return { state: 'running', outputOff };
    }

    // Stuck. Without a sound device the context runs on a timer.
    const sink = await switchSink(context, { type: 'none' }, deps);
    if (sink === 'failed') return { state: 'stuck', outputOff };
    outputOff = true;
    await resumeIfNeeded(context, deps);
    if (await watchClock(context, AUDIO_CLOCK_AFTER_SWITCH_MS, deps) === 'running') {
      return { state: 'recovered', outputOff };
    }
    // Not yet. The switch may still be landing: one more, longer look before giving up.
    await resumeIfNeeded(context, deps);
    const second = await watchClock(context, AUDIO_CLOCK_SECOND_LOOK_MS, deps);
    return { state: second === 'running' ? 'recovered' : 'stuck', outputOff };
  } catch {
    // The check itself failed; that proves nothing about the clock.
    return { state: 'running', outputOff };
  }
}

/**
 * Give the context its default sound device back and check that the clock
 * still runs. If it does not, go back to no sound device. True when the sound
 * is back on; false when it stays off. Never throws.
 *
 * A device that is slow to open (the switch had not answered within its limit)
 * gets a second, longer look before the studio gives up on it. A device that
 * took the switch and still does not run is given up on after the first look,
 * so a dead device freezes the program sound for as short a time as possible.
 */
export async function restoreAudioOutputClock(context: ClockedAudioContext, deps: AudioClockDeps): Promise<{ restored: boolean; outputOff: boolean }> {
  if (typeof context.setSinkId !== 'function') return { restored: false, outputOff: true };
  try {
    const switched = await switchSink(context, '', deps);
    if (switched !== 'failed') {
      await resumeIfNeeded(context, deps);
      if (await watchClock(context, AUDIO_CLOCK_WINDOW_MS, deps) === 'running') {
        return { restored: true, outputOff: false };
      }
      if (switched === 'timeout' && await watchClock(context, AUDIO_CLOCK_SECOND_LOOK_MS, deps) === 'running') {
        return { restored: true, outputOff: false };
      }
    }
  } catch {
    // Fall through to switching the sound device off again.
  }
  // If even this does not answer, the device state is unknown: keep saying the sound is off.
  await switchSink(context, { type: 'none' }, deps);
  return { restored: false, outputOff: true };
}
