/**
 * The health check of a private test stream, in plain words. One pure function
 * turns what the studio measured into a list of checks and one verdict, so the
 * thresholds live in a single tested place.
 */

/** The verdict is given once the test has run this long; before that the panel says it is checking. */
export const TEST_VERDICT_AFTER_MS = 15_000;
/** Video older than this means no picture is arriving. */
export const VIDEO_STALL_MS = 4_000;
/** Below this upload rate the picture is stalled or frozen. */
export const MIN_VIDEO_KBPS = 50;
/** Below this the picture is very poor (a still church scene still encodes above it). */
export const LOW_VIDEO_KBPS = 150;
/** Frame rate below this share of the target is a problem. */
export const LOW_FPS_WARN_RATIO = 0.8;
export const LOW_FPS_FAIL_RATIO = 0.5;
/** Peak level (dBFS) over the last seconds: below this there is no sound. */
export const SILENT_PEAK_DB = -60;
export const QUIET_PEAK_DB = -35;
export const CLIPPING_PEAK_DB = -0.5;
/** Share of frames lost. */
export const DROP_WARN_RATIO = 0.02;
export const DROP_FAIL_RATIO = 0.08;
/** Seconds of video waiting to be sent. */
export const BACKLOG_WARN_SECONDS = 2;
export const BACKLOG_FAIL_SECONDS = 5;
/** The media server encodes slower than real time below this. */
export const SERVER_SPEED_WARN = 0.95;
export const SERVER_SPEED_FAIL = 0.8;
export const LATENCY_WARN_MS = 1_500;

export type TestCheckId = 'video' | 'framerate' | 'sound' | 'drops' | 'connection';
export type TestCheckStatus = 'pending' | 'ok' | 'warn' | 'fail';

export interface TestStreamMeasurements {
  /** Time since the test went on air. */
  elapsedMs: number;
  /** False while the relay is connecting, reconnecting or has failed. */
  connected: boolean;
  reconnectAttempts: number;
  relayLatencyMs: number | null;
  video: {
    width: number | null;
    height: number | null;
    targetFps: number;
    /** What the media server's encoder reports; null before its first report. */
    encoderFps: number | null;
    uploadKbps: number;
    /** Milliseconds since the last chunk of video left the browser; null if none yet. */
    lastChunkAgoMs: number | null;
  };
  audio: {
    /** Loudest level (dBFS) heard in the last seconds; null if the meter has no reading yet. */
    peakDb: number | null;
  };
  drops: {
    droppedFrames: number;
    backlogSeconds: number;
    /** Server encoder: frames dropped, and speed against real time. */
    serverDroppedFrames: number;
    serverSpeed: number | null;
  };
}

export interface TestCheck {
  id: TestCheckId;
  label: string;
  status: TestCheckStatus;
  /** What was measured, in plain words. */
  detail: string;
  /** What to do, when the check is not fine. */
  action?: string;
}

export type TestVerdictKind = 'checking' | 'ready' | 'problem';

export interface TestStreamVerdict {
  kind: TestVerdictKind;
  /** The one-line answer. */
  headline: string;
  /** Plain-words advice when there is a problem, or a note when ready. */
  detail: string;
  checks: TestCheck[];
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function checkConnection(m: TestStreamMeasurements): TestCheck {
  const label = 'Connection to the media server';
  if (!m.connected || m.reconnectAttempts > 0) {
    return {
      id: 'connection',
      label,
      status: 'fail',
      detail: m.connected
        ? `The connection dropped and came back ${m.reconnectAttempts} time${m.reconnectAttempts === 1 ? '' : 's'}.`
        : 'The connection to the media server is not steady.',
      action: 'Check your internet connection, move closer to the router or use a cable, then run the test again.',
    };
  }
  if (m.relayLatencyMs !== null && m.relayLatencyMs >= LATENCY_WARN_MS) {
    return {
      id: 'connection',
      label,
      status: 'warn',
      detail: `Connected, but slow to answer (${Math.round(m.relayLatencyMs)} ms).`,
      action: 'Close other apps that use the internet, or use a cable.',
    };
  }
  return {
    id: 'connection',
    label,
    status: 'ok',
    detail: m.relayLatencyMs === null ? 'Connected and steady.' : `Connected and steady (${Math.round(m.relayLatencyMs)} ms).`,
  };
}

function checkVideo(m: TestStreamMeasurements): TestCheck {
  const label = 'Picture arriving';
  const { video } = m;
  const size = video.width && video.height ? `${video.width}x${video.height}` : null;
  if (video.lastChunkAgoMs === null) {
    return { id: 'video', label, status: m.elapsedMs >= TEST_VERDICT_AFTER_MS ? 'fail' : 'pending', detail: 'No picture has reached the media server yet.', action: 'Check that the studio stage shows your picture, then run the test again.' };
  }
  if (video.lastChunkAgoMs > VIDEO_STALL_MS || video.uploadKbps < MIN_VIDEO_KBPS) {
    return {
      id: 'video',
      label,
      status: 'fail',
      detail: video.lastChunkAgoMs > VIDEO_STALL_MS
        ? 'The picture stopped arriving.'
        : `Almost no picture data is arriving (${round(video.uploadKbps)} kbps).`,
      action: 'Check that the camera is on and the studio stage is visible, and keep this tab open in front.',
    };
  }
  const bitrate = `${round(video.uploadKbps)} kbps`;
  if (video.uploadKbps < LOW_VIDEO_KBPS) {
    return { id: 'video', label, status: 'warn', detail: `${size ? `${size}, ` : ''}${bitrate}: very low, the picture may be frozen or blurry.`, action: 'Look at the test output to see if the picture moves.' };
  }
  return { id: 'video', label, status: 'ok', detail: `${size ? `${size}, ` : ''}${bitrate}.` };
}

function checkFramerate(m: TestStreamMeasurements): TestCheck {
  const label = 'Smooth motion';
  const target = m.video.targetFps;
  const fps = m.video.encoderFps;
  if (fps === null || target <= 0) {
    return { id: 'framerate', label, status: 'pending', detail: 'Measuring the frame rate...' };
  }
  const ratio = fps / target;
  const detail = `${round(fps, 1)} frames per second (target ${target}).`;
  if (ratio < LOW_FPS_FAIL_RATIO) {
    return { id: 'framerate', label, status: 'fail', detail, action: 'Close other tabs and apps, or choose a lower output quality in Go Live.' };
  }
  if (ratio < LOW_FPS_WARN_RATIO) {
    return { id: 'framerate', label, status: 'warn', detail, action: 'Close other tabs and apps, or choose a lower output quality in Go Live.' };
  }
  return { id: 'framerate', label, status: 'ok', detail };
}

function checkSound(m: TestStreamMeasurements): TestCheck {
  const label = 'Sound present';
  const peak = m.audio.peakDb;
  if (peak === null) {
    return { id: 'sound', label, status: m.elapsedMs >= TEST_VERDICT_AFTER_MS ? 'fail' : 'pending', detail: 'The sound meter has no reading yet.', action: 'Check that a microphone is on and unmuted.' };
  }
  if (peak < SILENT_PEAK_DB) {
    return {
      id: 'sound',
      label,
      status: 'fail',
      detail: 'No sound is reaching the stream (silent).',
      action: 'Unmute your microphone, put speakers or music on stage, and say a few words during the test.',
    };
  }
  if (peak < QUIET_PEAK_DB) {
    return { id: 'sound', label, status: 'warn', detail: `Sound is present but very quiet (peak ${round(peak)} dB).`, action: 'Raise the microphone volume or speak closer to it.' };
  }
  if (peak >= CLIPPING_PEAK_DB) {
    return { id: 'sound', label, status: 'warn', detail: 'Sound is present but too loud and may distort.', action: 'Lower the microphone or music volume.' };
  }
  return { id: 'sound', label, status: 'ok', detail: `Sound is present (peak ${round(peak)} dB).` };
}

function checkDrops(m: TestStreamMeasurements): TestCheck {
  const label = 'No lost frames, no backlog';
  const { drops, video } = m;
  const expectedFrames = Math.max(1, (m.elapsedMs / 1000) * Math.max(1, video.targetFps));
  const lost = Math.max(0, drops.droppedFrames) + Math.max(0, drops.serverDroppedFrames);
  const lossRatio = lost / expectedFrames;
  const slow = drops.serverSpeed !== null && drops.serverSpeed < SERVER_SPEED_WARN;
  const action = 'Your internet upload may be too slow. Use a cable, close other apps, or choose a lower output quality in Go Live.';
  if (drops.backlogSeconds >= BACKLOG_FAIL_SECONDS || lossRatio >= DROP_FAIL_RATIO || (drops.serverSpeed !== null && drops.serverSpeed < SERVER_SPEED_FAIL)) {
    return {
      id: 'drops',
      label,
      status: 'fail',
      detail: drops.backlogSeconds >= BACKLOG_FAIL_SECONDS
        ? `${round(drops.backlogSeconds, 1)} seconds of video are waiting to be sent: viewers would see the past.`
        : slow
          ? 'The media server cannot keep up with the picture.'
          : `${lost} frames were lost (${round(lossRatio * 100, 1)}%).`,
      action,
    };
  }
  if (drops.backlogSeconds >= BACKLOG_WARN_SECONDS || lossRatio >= DROP_WARN_RATIO || slow) {
    return {
      id: 'drops',
      label,
      status: 'warn',
      detail: drops.backlogSeconds >= BACKLOG_WARN_SECONDS
        ? `${round(drops.backlogSeconds, 1)} seconds of video are waiting to be sent.`
        : slow
          ? 'The media server is running slightly behind.'
          : `${lost} frames were lost (${round(lossRatio * 100, 1)}%).`,
      action,
    };
  }
  return { id: 'drops', label, status: 'ok', detail: lost === 0 ? 'No frames lost and nothing waiting.' : `${lost} frame${lost === 1 ? '' : 's'} lost (${round(lossRatio * 100, 1)}%), nothing waiting.` };
}

export function evaluateTestStream(m: TestStreamMeasurements): TestStreamVerdict {
  const checks = [checkConnection(m), checkVideo(m), checkFramerate(m), checkSound(m), checkDrops(m)];
  const failures = checks.filter((check) => check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');

  // A broken connection or no picture is clear at once; everything else needs the settle time.
  const settled = m.elapsedMs >= TEST_VERDICT_AFTER_MS;
  const urgent = failures.find((check) => check.id === 'connection' && !m.connected);
  if (!settled && !urgent) {
    return {
      kind: 'checking',
      headline: 'Checking your stream...',
      detail: 'Keep talking or playing sound for a few seconds. The verdict comes after about 15 seconds.',
      checks,
    };
  }

  if (failures.length > 0) {
    const first = failures[0];
    return {
      kind: 'problem',
      headline: `Not ready: ${first.label.toLowerCase()}`,
      detail: [first.detail, first.action].filter(Boolean).join(' '),
      checks,
    };
  }
  if (checks.some((check) => check.status === 'pending')) {
    return {
      kind: 'checking',
      headline: 'Still measuring...',
      detail: 'Some readings have not arrived yet. This should take a few more seconds.',
      checks,
    };
  }
  return {
    kind: 'ready',
    headline: 'Ready to go live',
    detail: warnings.length > 0
      ? `Everything works. One thing to look at: ${[warnings[0].detail, warnings[0].action].filter(Boolean).join(' ')}`
      : 'Picture, sound and connection all look good.',
    checks,
  };
}
