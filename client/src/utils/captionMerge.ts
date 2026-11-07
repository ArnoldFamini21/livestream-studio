/**
 * Merges guests' live captions (sent over signaling from their own browsers)
 * with the host's, by speaker and time, for the broadcast caption overlay and
 * the saved transcript, VTT and SRT.
 *
 * Clocks on a guest's computer and the host's can differ by seconds, so a
 * remote segment keeps its duration but is re-anchored to the moment the
 * host received it: the end of the utterance is "now" minus nothing more
 * than network latency, which keeps every speaker on one timeline.
 */
import type { CaptionSegmentPayload } from '@studio/shared';
import { MAX_CAPTION_SEGMENT_DURATION_MS } from '@studio/shared';
import type { LiveCaptionSegment } from '../hooks/useLiveCaptions.ts';

export const MAX_REMOTE_CAPTION_SEGMENTS = 1500;
export const CAPTION_ACTIVE_MS = 7000;

export interface RemoteCaptionState {
  finals: LiveCaptionSegment[];
  /** Latest interim caption per participant, with when it was last updated (host clock). */
  interims: Record<string, { segment: LiveCaptionSegment; updatedAtMs: number }>;
}

export const EMPTY_REMOTE_CAPTIONS: RemoteCaptionState = { finals: [], interims: {} };

export function anchorRemoteCaptionTiming(
  payload: Pick<CaptionSegmentPayload, 'startMs' | 'endMs'>,
  receivedAtMs: number
): { startMs: number; endMs: number } {
  const duration = Math.min(MAX_CAPTION_SEGMENT_DURATION_MS, Math.max(0, payload.endMs - payload.startMs));
  return { startMs: receivedAtMs - duration, endMs: receivedAtMs };
}

export function applyRemoteCaption(
  state: RemoteCaptionState,
  payload: CaptionSegmentPayload,
  receivedAtMs: number,
  maxSegments = MAX_REMOTE_CAPTION_SEGMENTS
): RemoteCaptionState {
  const text = payload.text?.trim();
  if (!payload.participantId || !text) return state;
  const timing = anchorRemoteCaptionTiming(payload, receivedAtMs);
  const segment: LiveCaptionSegment = {
    id: `${payload.participantId}:${payload.segmentId}`,
    participantId: payload.participantId,
    speakerName: payload.speakerName?.trim() || 'Guest',
    text,
    interim: !payload.final,
    // Same meaning as local captions: when the words were recognized (the end of the utterance).
    timestamp: new Date(timing.endMs).toISOString(),
    startedAt: new Date(timing.startMs).toISOString(),
  };
  const interims = { ...state.interims };
  if (payload.final) {
    delete interims[payload.participantId];
    const finals = state.finals.filter((existing) => existing.id !== segment.id);
    finals.push(segment);
    return { finals: finals.slice(-maxSegments), interims };
  }
  interims[payload.participantId] = { segment, updatedAtMs: receivedAtMs };
  return { finals: state.finals, interims };
}

/** Drops interim captions from participants who stopped talking (or left) a while ago. */
export function pruneRemoteInterims(state: RemoteCaptionState, nowMs: number, maxAgeMs = CAPTION_ACTIVE_MS): RemoteCaptionState {
  let changed = false;
  const interims: RemoteCaptionState['interims'] = {};
  for (const [participantId, entry] of Object.entries(state.interims)) {
    if (nowMs - entry.updatedAtMs > maxAgeMs) {
      changed = true;
      continue;
    }
    interims[participantId] = entry;
  }
  return changed ? { finals: state.finals, interims } : state;
}

function timeOf(segment: LiveCaptionSegment): number {
  const value = Date.parse(segment.timestamp);
  return Number.isFinite(value) ? value : 0;
}

/** Local and remote final captions on one timeline, in time order, for the panel and saved files. */
export function mergeCaptionSegments(local: LiveCaptionSegment[], remote: LiveCaptionSegment[]): LiveCaptionSegment[] {
  if (remote.length === 0) return local;
  if (local.length === 0) return remote;
  return [...local, ...remote]
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => timeOf(a.segment) - timeOf(b.segment) || a.index - b.index)
    .map((entry) => entry.segment);
}

/**
 * The caption the broadcast shows now: whoever spoke most recently, preferring
 * someone mid-sentence (interim) over a finished line, and nothing once the
 * last line is older than CAPTION_ACTIVE_MS.
 */
export function selectBroadcastCaption(
  local: LiveCaptionSegment | null,
  remote: RemoteCaptionState,
  nowMs: number
): LiveCaptionSegment | null {
  const candidates: Array<{ segment: LiveCaptionSegment; at: number }> = [];
  if (local) candidates.push({ segment: local, at: local.interim ? nowMs : timeOf(local) });
  for (const entry of Object.values(remote.interims)) {
    if (nowMs - entry.updatedAtMs <= CAPTION_ACTIVE_MS) candidates.push({ segment: entry.segment, at: entry.updatedAtMs });
  }
  const lastFinal = remote.finals[remote.finals.length - 1];
  if (lastFinal && nowMs - timeOf(lastFinal) < CAPTION_ACTIVE_MS) candidates.push({ segment: lastFinal, at: timeOf(lastFinal) });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.at - a.at || Number(b.segment.interim) - Number(a.segment.interim));
  return candidates[0].segment;
}

/**
 * How long until selectBroadcastCaption's remote candidates (or the interim
 * pruning) can next change on their own: when the oldest interim or the
 * newest final runs out of CAPTION_ACTIVE_MS. Null when nothing will expire,
 * so no timer runs (and the studio does not re-render) once captions go
 * quiet, however many finals the session keeps.
 */
export function getNextCaptionExpiryDelayMs(state: RemoteCaptionState, nowMs: number): number | null {
  let next: number | null = null;
  const consider = (deadline: number) => {
    const delay = Math.max(0, deadline - nowMs);
    if (next === null || delay < next) next = delay;
  };
  // An interim counts while nowMs - updatedAtMs <= CAPTION_ACTIVE_MS; it is pruned just after.
  for (const entry of Object.values(state.interims)) consider(entry.updatedAtMs + CAPTION_ACTIVE_MS + 1);
  const lastFinal = state.finals[state.finals.length - 1];
  if (lastFinal) {
    const expiresAt = timeOf(lastFinal) + CAPTION_ACTIVE_MS;
    if (expiresAt > nowMs) consider(expiresAt);
  }
  return next;
}

/**
 * Throttles interim caption updates per utterance so a talkative guest stays
 * well inside the server's caption rate limit; finals always go out.
 */
export function createCaptionSendThrottle(intervalMs = 800) {
  let lastInterimAt = 0;
  let lastSegmentId = '';
  return (segmentId: string, final: boolean, nowMs: number): boolean => {
    if (final) {
      lastSegmentId = '';
      lastInterimAt = 0;
      return true;
    }
    if (segmentId !== lastSegmentId) {
      lastSegmentId = segmentId;
      lastInterimAt = nowMs;
      return true;
    }
    if (nowMs - lastInterimAt < intervalMs) return false;
    lastInterimAt = nowMs;
    return true;
  };
}
