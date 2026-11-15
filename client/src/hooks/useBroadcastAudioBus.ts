import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeBroadcastAudioRouting,
  type BroadcastAudioRouting,
} from '../utils/broadcastAudioRouting.ts';
import {
  MUSIC_DUCKING_ATTACK_SECONDS,
  MUSIC_DUCKING_GAIN,
  MUSIC_DUCKING_RELEASE_SECONDS,
} from '../utils/audioDucking.ts';
import { releaseProcessingSoundDevices, restoreProcessingSoundDevices } from '../audio/soundDevicePolicy.ts';
import {
  checkProgramAudioClock,
  restoreAudioOutputClock,
  type AudioClockDeps,
  type ClockedAudioContext,
  type ProgramAudioCheck,
} from '../audio/programAudioClock.ts';

/**
 * The studio's media bus: sound effects, background music and clip audio.
 *
 * It owns the studio's single AudioContext. The program mix (live relay and
 * program recording) and the host's outbound mix to guests both live in this
 * context and take the bus through `connectOutput`, so every listener hears
 * the same sounds without a second decode or a MediaStream hop.
 */
export interface BroadcastAudioBus {
  /** True once anything has been routed to the program side of the bus. */
  active: boolean;
  getContext: () => AudioContext;
  connectNode: (node: AudioNode, routing?: Partial<BroadcastAudioRouting>) => () => void;
  /** Feed the bus's program output into another node in the same context. */
  connectOutput: (target: AudioNode) => () => void;
  /** Lower (or restore) music and clip audio routed with `duck: true`. */
  setMusicDucked: (ducked: boolean) => void;
  /**
   * True while the studio's audio context has no sound device (see
   * checkProgramAudio). The host then does not hear effects, music or clips
   * on this computer; the broadcast and the guests still get them.
   */
  soundOutputOff: boolean;
  /**
   * Is the audio clock moving? Resumes the context if needed, looks at the
   * clock for about 1.2 s. If it is stuck, takes the sound device away from
   * the context (Chrome setSinkId none), which runs it on a timer, and looks
   * again. Takes about 3 s at most and never throws.
   */
  checkProgramAudio: () => Promise<ProgramAudioCheck>;
  /** Give the sound device back. True when the sound is on again; false when it stays off. */
  restoreAudioOutput: () => Promise<boolean>;
}

interface BusNodes {
  context: AudioContext;
  /** Everything sent to the program: unducked effects plus the ducked bed. */
  streamMix: GainNode;
  /** Music and clips on their way to the program. */
  duckedStream: GainNode;
  monitorMix: GainNode;
  duckedMonitor: GainNode;
}

function getAudioContextConstructor(): typeof AudioContext {
  const AudioContextConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error('Web Audio is not available in this browser.');
  }
  return AudioContextConstructor;
}

function createAudioContext(): AudioContext {
  const AudioContextConstructor = getAudioContextConstructor();
  try {
    return new AudioContextConstructor({ sampleRate: 48_000 });
  } catch {
    return new AudioContextConstructor();
  }
}

function safeDisconnect(node: AudioNode, target: AudioNode) {
  try {
    node.disconnect(target);
  } catch {
    // Already disconnected.
  }
}

function resumeIfNeeded(context: AudioContext | null | undefined) {
  if (!context) return;
  const state = context.state as AudioContextState | 'interrupted';
  if (state === 'running' || state === 'closed') return;
  void context.resume().catch(() => {
    // Browsers refuse without a user gesture; the next gesture retries.
  });
}

const REAL_CLOCK_DEPS: AudioClockDeps = {
  sleep: (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); }),
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

export function useBroadcastAudioBus(clockDeps: AudioClockDeps = REAL_CLOCK_DEPS): BroadcastAudioBus {
  const nodesRef = useRef<BusNodes | null>(null);
  const duckedRef = useRef(false);
  const [active, setActive] = useState(false);
  const outputOffRef = useRef(false);
  const [soundOutputOff, setSoundOutputOffState] = useState(false);
  // One check or restore at a time: each one moves the audio clock and the sound device.
  const clockQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const clockDepsRef = useRef(clockDeps);
  clockDepsRef.current = clockDeps;

  const setSoundOutputOff = useCallback((off: boolean) => {
    const changed = outputOffRef.current !== off;
    outputOffRef.current = off;
    setSoundOutputOffState(off);
    if (!changed) return;
    // The voice contexts sit on the same sound device: they follow the studio's own context,
    // or the host's voice would be missing from a broadcast that otherwise came back.
    if (off) releaseProcessingSoundDevices();
    else restoreProcessingSoundDevices();
  }, []);

  // Leaving the studio with the sound off: the voice contexts go back to normal use.
  useEffect(() => () => {
    if (outputOffRef.current) restoreProcessingSoundDevices();
  }, []);

  const getNodes = useCallback((): BusNodes => {
    const existing = nodesRef.current;
    if (existing && existing.context.state !== 'closed') return existing;

    const context = createAudioContext();
    // A new context starts on the default sound device.
    if (outputOffRef.current) setSoundOutputOff(false);
    const streamMix = context.createGain();
    const duckedStream = context.createGain();
    const monitorMix = context.createGain();
    const duckedMonitor = context.createGain();
    const duckLevel = duckedRef.current ? MUSIC_DUCKING_GAIN : 1;
    duckedStream.gain.value = duckLevel;
    duckedMonitor.gain.value = duckLevel;
    duckedStream.connect(streamMix);
    duckedMonitor.connect(monitorMix);
    monitorMix.connect(context.destination);
    // Safari can interrupt audio (calls, other tabs); pick it back up when allowed.
    context.onstatechange = () => {
      if (document.visibilityState === 'visible') resumeIfNeeded(context);
    };
    const nodes = { context, streamMix, duckedStream, monitorMix, duckedMonitor };
    nodesRef.current = nodes;
    return nodes;
  }, [setSoundOutputOff]);

  const getContext = useCallback(() => {
    const { context } = getNodes();
    resumeIfNeeded(context);
    return context;
  }, [getNodes]);

  const connectNode = useCallback((node: AudioNode, routing: Partial<BroadcastAudioRouting> = {}) => {
    const nodes = getNodes();
    if (node.context !== nodes.context) {
      throw new Error('Broadcast audio nodes must use the broadcast audio context.');
    }

    const normalized = normalizeBroadcastAudioRouting(routing);
    const streamTarget = normalized.duck ? nodes.duckedStream : nodes.streamMix;
    const monitorTarget = normalized.duck ? nodes.duckedMonitor : nodes.monitorMix;
    if (normalized.stream) {
      node.connect(streamTarget);
      setActive(true);
    }
    if (normalized.monitor) node.connect(monitorTarget);

    return () => {
      if (normalized.stream) safeDisconnect(node, streamTarget);
      if (normalized.monitor) safeDisconnect(node, monitorTarget);
    };
  }, [getNodes]);

  const connectOutput = useCallback((target: AudioNode) => {
    const nodes = getNodes();
    if (target.context !== nodes.context) {
      throw new Error('Broadcast audio outputs must use the broadcast audio context.');
    }
    nodes.streamMix.connect(target);
    return () => safeDisconnect(nodes.streamMix, target);
  }, [getNodes]);

  const setMusicDucked = useCallback((ducked: boolean) => {
    if (duckedRef.current === ducked) return;
    duckedRef.current = ducked;
    const nodes = nodesRef.current;
    if (!nodes || nodes.context.state === 'closed') return;
    const target = ducked ? MUSIC_DUCKING_GAIN : 1;
    const timeConstant = ducked ? MUSIC_DUCKING_ATTACK_SECONDS : MUSIC_DUCKING_RELEASE_SECONDS;
    const now = nodes.context.currentTime;
    for (const gain of [nodes.duckedStream.gain, nodes.duckedMonitor.gain]) {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.setTargetAtTime(target, now, timeConstant);
    }
  }, []);

  const runClockJob = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = clockQueueRef.current.then(job, job);
    clockQueueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const checkProgramAudio = useCallback((): Promise<ProgramAudioCheck> => runClockJob(async () => {
    try {
      const { context } = getNodes();
      const result = await checkProgramAudioClock(context as unknown as ClockedAudioContext, clockDepsRef.current);
      if (result.outputOff && nodesRef.current?.context === context) setSoundOutputOff(true);
      return { state: result.state };
    } catch {
      return { state: 'running' as const };
    }
  }), [getNodes, runClockJob, setSoundOutputOff]);

  const restoreAudioOutput = useCallback((): Promise<boolean> => runClockJob(async () => {
    try {
      if (!outputOffRef.current) return true;
      const nodes = nodesRef.current;
      if (!nodes || nodes.context.state === 'closed') {
        setSoundOutputOff(false);
        return true;
      }
      const result = await restoreAudioOutputClock(nodes.context as unknown as ClockedAudioContext, clockDepsRef.current);
      if (nodesRef.current === nodes) setSoundOutputOff(result.outputOff);
      return result.restored;
    } catch {
      return false;
    }
  }), [runClockJob, setSoundOutputOff]);

  // Autoplay rules can leave the context suspended (it may be created after an
  // await, outside the click). Resume on the next gesture and when the tab
  // becomes visible again; a running context keeps going while hidden.
  useEffect(() => {
    const resume = () => resumeIfNeeded(nodesRef.current?.context);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resume();
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', resume, options);
    window.addEventListener('keydown', resume, options);
    window.addEventListener('touchend', resume, options);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pointerdown', resume, options);
      window.removeEventListener('keydown', resume, options);
      window.removeEventListener('touchend', resume, options);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  useEffect(() => () => {
    const nodes = nodesRef.current;
    nodesRef.current = null;
    if (nodes && nodes.context.state !== 'closed') {
      nodes.context.onstatechange = null;
      void nodes.context.close();
    }
  }, []);

  return useMemo(
    () => ({ active, getContext, connectNode, connectOutput, setMusicDucked, soundOutputOff, checkProgramAudio, restoreAudioOutput }),
    [active, checkProgramAudio, connectNode, connectOutput, getContext, restoreAudioOutput, setMusicDucked, soundOutputOff]
  );
}
