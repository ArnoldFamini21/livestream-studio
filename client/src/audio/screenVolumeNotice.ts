import { streamHasLiveAudio, type ScreenVolumeView } from './mixControls.ts';

/**
 * Tells the person who runs the program mix when viewers hear the screen share
 * below full volume. The volume is kept per browser session, so a level chosen
 * for a silent slide deck can still be in force when a video is shared later.
 * The slider lives in the People panel, so this adds a notice and a marker
 * that do not depend on any panel being open.
 *
 * Everything the studio shows, to whom and with which words, is decided in
 * decideScreenVolumeAdvice. It is pure: the caller passes the time.
 */

/** A share that returns within this long is the same share (a reconnect), not a new start. */
export const SHARE_RECONNECT_GRACE_MS = 10_000;

export interface ScreenVolumeNoticeEntry {
  /** The share is on the program with sound right now. */
  present: boolean;
  /** When it left the program (for telling a reconnect from a new share). */
  goneAt: number;
  /** Nothing more to say about this share: answered, back at full volume, or over. */
  handled: boolean;
}

export type ScreenVolumeNoticeState = Readonly<Record<string, ScreenVolumeNoticeEntry>>;

export const EMPTY_SCREEN_VOLUME_NOTICE_STATE: ScreenVolumeNoticeState = Object.freeze({});

export interface ScreenVolumeNoticeCopy {
  /** What the host reads, in plain words. */
  message: string;
  /** Button that puts the volume back to 100 percent. */
  restoreLabel: string;
  /** Button that leaves the volume as it is. */
  keepLabel: string;
}

export interface ScreenVolumeMarkerCopy {
  percent: number;
  label: string;
  title: string;
}

export interface ScreenVolumeAdvice {
  notice: ScreenVolumeNoticeCopy | null;
  marker: ScreenVolumeMarkerCopy | null;
}

export interface ScreenVolumeDecision {
  state: ScreenVolumeNoticeState;
  advice: ScreenVolumeAdvice;
}

type StreamWithAudio = { id?: string; getAudioTracks(): Array<{ readyState: string }> };

/**
 * Identities of the screen shares with sound that are on the program: the
 * host's own (by its stream, so a new share is always a new identity) and each
 * on-stage person's (by person, since a reconnect brings a new stream).
 */
export function listSoundShareKeys(input: {
  localScreenOnProgram: boolean;
  localScreenStream: StreamWithAudio | null | undefined;
  myParticipantId: string | undefined;
  participants: Iterable<[string, { status: string }]>;
  remoteScreenStreams: ReadonlyMap<string, StreamWithAudio>;
}): string[] {
  const keys: string[] = [];
  if (input.localScreenOnProgram && streamHasLiveAudio(input.localScreenStream)) {
    keys.push(`local:${input.localScreenStream?.id ?? ''}`);
  }
  for (const [id, participant] of input.participants) {
    if (id === input.myParticipantId || participant.status !== 'on-stage') continue;
    const stream = input.remoteScreenStreams.get(id);
    if (stream && streamHasLiveAudio(stream)) keys.push(`remote:${id}`);
  }
  return keys;
}

export function formatViewerHearing(percent: number): string {
  return percent <= 0
    ? 'Viewers cannot hear this screen share.'
    : `Viewers hear this screen share at ${percent}%.`;
}

const NO_ADVICE: ScreenVolumeAdvice = Object.freeze({ notice: null, marker: null });

/**
 * One step of the rule. `view` is what getScreenVolumeView says for this
 * browser: only 'slider' (an operator whose browser runs the program, with a
 * share that has sound on it) can hear its own setting apply, so everyone else
 * gets nothing. `percent` is this browser's own stored level (whole percent).
 *
 * - The notice shows once per share start while the level is below 100. It is
 *   gone for good once answered, once the level reaches 100, and when the
 *   share leaves the program (the same share coming back within the grace
 *   period is a reconnect, not a start).
 * - The marker shows for as long as a share with sound is on the program and
 *   the level is below 100.
 */
export function decideScreenVolumeAdvice(input: {
  view: ScreenVolumeView;
  percent: number;
  soundShareKeys: readonly string[];
  now: number;
  state: ScreenVolumeNoticeState;
}): ScreenVolumeDecision {
  const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(input.percent) ? input.percent : 100)));
  const active = input.view.kind === 'slider' ? new Set(input.soundShareKeys) : new Set<string>();
  const next: Record<string, ScreenVolumeNoticeEntry> = {};

  for (const [key, entry] of Object.entries(input.state)) {
    if (active.has(key)) continue;
    if (entry.present) {
      // The share left the program: its notice window is over.
      next[key] = { present: false, goneAt: input.now, handled: true };
    } else if (input.now - entry.goneAt <= SHARE_RECONNECT_GRACE_MS) {
      next[key] = entry;
    }
  }

  for (const key of active) {
    const entry = input.state[key];
    if (entry?.present) {
      next[key] = percent >= 100 && !entry.handled ? { ...entry, handled: true } : entry;
    } else if (entry && input.now - entry.goneAt <= SHARE_RECONNECT_GRACE_MS) {
      // The same share is back after a short drop: not a new start.
      next[key] = { present: true, goneAt: entry.goneAt, handled: entry.handled || percent >= 100 };
    } else {
      next[key] = { present: true, goneAt: input.now, handled: percent >= 100 };
    }
  }

  const advice = active.size === 0 || percent >= 100
    ? NO_ADVICE
    : {
      marker: {
        percent,
        label: `Share ${percent}%`,
        title: `${formatViewerHearing(percent)} Open People to change it.`,
      },
      notice: Object.entries(next).some(([key, entry]) => entry.present && !entry.handled && active.has(key))
        ? {
          message: formatViewerHearing(percent),
          restoreLabel: 'Set to 100%',
          keepLabel: percent <= 0 ? 'Keep it silent' : `Keep ${percent}%`,
        }
        : null,
    };
  return { state: next, advice };
}

/** The host answered the notice (either button): it does not come back for the shares now on the program. */
export function markScreenVolumeNoticeAnswered(state: ScreenVolumeNoticeState): ScreenVolumeNoticeState {
  const next: Record<string, ScreenVolumeNoticeEntry> = {};
  for (const [key, entry] of Object.entries(state)) next[key] = entry.handled ? entry : { ...entry, handled: true };
  return next;
}
