import { parseSavedGain, percentToGain } from './mixControls.ts';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function screenVolumeStorageKey(roomId: string): string {
  return `livestream-studio:screen-volume:${roomId}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The screen-share volume saved for this room in this browser session (default 1). */
export function readScreenVolume(roomId: string | undefined, storage: StorageLike | null = defaultStorage()): number {
  if (!roomId || !storage) return 1;
  try {
    return parseSavedGain(storage.getItem(screenVolumeStorageKey(roomId)));
  } catch {
    return 1;
  }
}

/** Remember the volume for reloads. Storage can be missing or blocked; then it simply is not kept. */
export function writeScreenVolume(roomId: string | undefined, gain: number, storage: StorageLike | null = defaultStorage()): void {
  if (!roomId || !storage) return;
  try {
    storage.setItem(screenVolumeStorageKey(roomId), String(percentToGain(gain * 100)));
  } catch {
    // Private window or full storage: the volume just is not restored after a reload.
  }
}
