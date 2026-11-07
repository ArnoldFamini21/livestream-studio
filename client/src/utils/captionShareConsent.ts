import type { CaptionsStatePayload } from '@studio/shared';

/**
 * A guest's "Caption my voice" consent. Saying yes starts browser speech
 * recognition (in Chrome, Google's speech service) and sends the words to
 * that show's hosts, so the answer belongs to one show: it is kept per studio
 * in this tab's sessionStorage and starts off in every other studio.
 */
export const CAPTION_SHARE_STORAGE_PREFIX = 'studio.captions.shareOwnVoice.v2:';
/** The old global key, which carried one yes into every later show. Cleared on sight. */
export const LEGACY_CAPTION_SHARE_STORAGE_KEY = 'studio.captions.shareOwnVoice.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function safeSession(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function safeLocal(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function clearLegacyChoice(local: StorageLike | null) {
  try {
    local?.removeItem(LEGACY_CAPTION_SHARE_STORAGE_KEY);
  } catch {
    // Blocked storage has nothing to clear.
  }
}

export function readCaptionShareChoice(
  roomId: string | null | undefined,
  session: StorageLike | null = safeSession(),
  local: StorageLike | null = safeLocal(),
): boolean {
  clearLegacyChoice(local);
  if (!roomId || !session) return false;
  try {
    return session.getItem(CAPTION_SHARE_STORAGE_PREFIX + roomId) === '1';
  } catch {
    return false;
  }
}

export function writeCaptionShareChoice(
  roomId: string | null | undefined,
  value: boolean,
  session: StorageLike | null = safeSession(),
): void {
  if (!roomId || !session) return;
  try {
    if (value) session.setItem(CAPTION_SHARE_STORAGE_PREFIX + roomId, '1');
    else session.removeItem(CAPTION_SHARE_STORAGE_PREFIX + roomId);
  } catch {
    // Blocked storage just forgets the choice.
  }
}

/**
 * The captions state guests follow: the stage owner's only (the same owner
 * rule as the stage mirror). A co-host whose own captions switch is off must
 * not turn guests' caption sharing off, and two operators re-announcing on
 * an admission must not make it flicker.
 */
export function pickAuthoritativeCaptionsState(
  states: Readonly<Record<string, CaptionsStatePayload>>,
  stageOwnerId: string | null | undefined,
): CaptionsStatePayload | null {
  if (!stageOwnerId) return null;
  return states[stageOwnerId] ?? null;
}
