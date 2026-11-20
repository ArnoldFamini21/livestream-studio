import type { LiveStreamTokenClaims, RtmpRelayStartPayload } from '@studio/shared';
import { buildRtmpOutputUrl, getMaxRtmpDestinations, getRelayVideoMode, isEncodeOnceEnabled, normalizeVideoConfig } from './rtmp.js';

type Claims = Pick<LiveStreamTokenClaims, 'roomId' | 'participantId'>;

interface ProgramSession {
  started: boolean;
  stopping: boolean;
  clientGone: boolean;
  claims: Claims | null;
  payload: RtmpRelayStartPayload | null;
}

type Admission<T> = { ok: true; primary: T } | { ok: false; code: string; message: string };

export const SECONDARY_INPUT_TIMEOUT_MS = 15_000;

export function isDualOutputSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEncodeOnceEnabled(env) && getMaxRtmpDestinations(env) >= 2 && env.RTMP_DUAL_OUTPUT !== '0';
}

export function getDualOutputIssue(payload: RtmpRelayStartPayload): string | null {
  const { dualOutput, dualOutputId, orientation } = payload;
  if (dualOutput === undefined && dualOutputId === undefined) return null;
  if (dualOutput !== 'primary' && dualOutput !== 'secondary') return 'Choose a primary or second program.';
  if (typeof dualOutputId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(dualOutputId)) {
    return 'The two programs must belong to one broadcast.';
  }
  if (payload.test) return 'Private tests only use one program.';
  if (orientation !== 'landscape' && orientation !== 'portrait') return 'Choose a program orientation.';
  if (getRelayVideoMode(payload.encoding) !== 'copy') return 'Simultaneous output requires H.264 from the browser.';
  const video = normalizeVideoConfig(payload.video);
  const actual = video.height > video.width ? 'portrait' : 'landscape';
  if (orientation !== actual || video.height === video.width) return 'The upload size does not match the chosen orientation.';
  if (dualOutput === 'secondary' && (video.width * video.height > 1280 * 720 || video.frameRate > 30)) {
    return 'The second program can use up to 720p at 30 frames per second.';
  }
  if (payload.destinations.some((destination) => destination.orientation !== orientation)) {
    return 'A destination must use the orientation of the program sending to it.';
  }
  return null;
}

/** A secondary must belong to the same host and current primary transport group. */
export function admitSecondaryProgram<T extends ProgramSession>(
  sessions: Iterable<T>,
  current: T,
  claims: Claims,
  payload: RtmpRelayStartPayload,
  maximum = getMaxRtmpDestinations(),
): Admission<T> {
  const running = [...new Set(sessions)].filter((session) =>
    session !== current && session.started && !session.stopping && session.claims?.roomId === claims.roomId);
  const primary = running.find((session) => !session.clientGone
    && session.claims?.participantId === claims.participantId
    && session.payload?.dualOutput === 'primary'
    && session.payload.dualOutputId === payload.dualOutputId);
  if (!primary?.payload) {
    return { ok: false, code: 'PRIMARY_PROGRAM_NOT_LIVE', message: 'The main program must be connected before starting the second.' };
  }
  if (running.some((session) => session.payload?.dualOutput === 'secondary')) {
    return { ok: false, code: 'SECONDARY_PROGRAM_ALREADY_LIVE', message: 'This studio already has two running programs.' };
  }
  if (primary.payload.orientation === payload.orientation) {
    return { ok: false, code: 'DUPLICATE_PROGRAM_ORIENTATION', message: 'The two programs must use different orientations.' };
  }
  const primaryTargets = new Set(primary.payload.destinations.map(({ rtmpUrl, streamKey }) => buildRtmpOutputUrl(rtmpUrl, streamKey)));
  if (payload.destinations.some(({ rtmpUrl, streamKey }) => primaryTargets.has(buildRtmpOutputUrl(rtmpUrl, streamKey)))) {
    return { ok: false, code: 'DUPLICATE_PROGRAM_DESTINATION', message: 'Use a different stream key or server URL for each output.' };
  }
  if (primary.payload.destinations.length + payload.destinations.length > maximum) {
    return { ok: false, code: 'INVALID_DESTINATIONS', message: `Use up to ${maximum} destinations across both programs.` };
  }
  return { ok: true, primary };
}
