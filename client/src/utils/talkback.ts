/**
 * Talk backstage: the host's mic leaves the program (the live relay and the
 * program recording share one mix) while the mesh keeps carrying it to the
 * guests, so the host can brief a backstage guest without the audience
 * hearing. Held on a key (push-to-talk) or latched with a toggle.
 *
 * The program mix runs on whichever operator streams or records, so the state
 * travels over signaling (talkback-state) and every operator's client
 * silences everyone talking backstage in the mix it builds (useTalkbackRelay).
 */
import type { ShortcutEventTarget } from './keyboardShortcuts.ts';
import { shouldIgnoreShortcutTarget } from './keyboardShortcuts.ts';

/** Hold this key (no modifiers) to talk backstage; Shift + K latches it. */
export const TALKBACK_HOLD_KEY = 'k';

export const TALKBACK_BADGE_TEXT = 'Off air — talking backstage';

/**
 * The per-person program volumes with the talking host forced to silence.
 * Returns the same object when talkback is off, so memoized consumers do
 * not reconcile for nothing.
 */
export function applyTalkbackVolumes(
  volumes: Record<string, number>,
  participantId: string | null | undefined,
  active: boolean,
): Record<string, number> {
  if (!active || !participantId) return volumes;
  if (volumes[participantId] === 0) return volumes;
  return { ...volumes, [participantId]: 0 };
}

/**
 * applyTalkbackVolumes for everyone talking backstage at once: this
 * operator (when active) and every other operator whose talkback-state says
 * they are, so whoever builds the program (live relay, program recording)
 * keeps all private talk off air. Same object back when nothing changes.
 */
export function applyTalkbackVolumesForIds(
  volumes: Record<string, number>,
  participantIds: Iterable<string>,
): Record<string, number> {
  let result = volumes;
  for (const id of participantIds) result = applyTalkbackVolumes(result, id, true);
  return result;
}

/** Shown while talking backstage but not every operator's program mix is known to honour it. */
export const TALKBACK_UNCONFIRMED_TEXT = 'Talkback not confirmed — you may still be on air';

export interface TalkbackBadgeInput {
  active: boolean;
  /** The server echoed our talkback-state, so other operators were told. */
  confirmed: boolean;
  /** Other admitted operators whose client cannot silence us in its program mix. */
  operatorsWithoutSupport: number;
}

/**
 * What the operator's badge says. "Off air" only once the server confirmed
 * the state and every other operator (any of whom may be the one streaming
 * or recording) runs a client that applies it; otherwise a warning, never a
 * reassurance that may be false.
 */
export function getTalkbackBadge(input: TalkbackBadgeInput): { text: string; confirmed: boolean } | null {
  if (!input.active) return null;
  if (input.confirmed && input.operatorsWithoutSupport === 0) return { text: TALKBACK_BADGE_TEXT, confirmed: true };
  return { text: TALKBACK_UNCONFIRMED_TEXT, confirmed: false };
}

/** Participant fields the talkback relay reads. */
export interface TalkbackParticipant {
  id: string;
  role: string;
  status: string;
}

/**
 * Remote operators currently talking backstage, from their talkback-state,
 * dropping anyone who left, lost operator rights or went to the green room.
 */
export function selectRemoteTalkbackIds(
  reported: ReadonlySet<string>,
  participants: Iterable<TalkbackParticipant>,
  localParticipantId: string | null | undefined,
): string[] {
  if (reported.size === 0) return [];
  const result: string[] = [];
  for (const participant of participants) {
    if (participant.id === localParticipantId || !reported.has(participant.id)) continue;
    if (participant.role !== 'host' && participant.role !== 'co-host') continue;
    if (participant.status === 'green-room') continue;
    result.push(participant.id);
  }
  return result.sort();
}

export interface TalkbackKeyEvent {
  type: string;
  key: string;
  repeat?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: ShortcutEventTarget | null;
}

export type TalkbackKeyAction = 'hold-start' | 'hold-end' | null;

/**
 * What a key event does to push-to-talk. Typing in a field never starts it;
 * releasing the key always ends it (even if focus moved into a field while
 * it was held), so the host is never left off air by accident.
 */
export function getTalkbackKeyAction(event: TalkbackKeyEvent, holding: boolean): TalkbackKeyAction {
  if (typeof event.key !== 'string' || event.key.toLowerCase() !== TALKBACK_HOLD_KEY) return null;
  if (event.type === 'keyup') return holding ? 'hold-end' : null;
  if (event.type !== 'keydown') return null;
  if (holding || event.repeat) return null;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (shouldIgnoreShortcutTarget(event.target ?? null)) return null;
  return 'hold-start';
}
