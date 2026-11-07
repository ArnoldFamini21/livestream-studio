/**
 * Talk backstage: the host's mic leaves the program (the live relay and the
 * program recording share one mix) while the mesh keeps carrying it to the
 * guests, so the host can brief a backstage guest without the audience
 * hearing. Held on a key (push-to-talk) or latched with a toggle.
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
