import { useSyncExternalStore } from 'react';

/**
 * Your own camera preview is mirrored by default, like a mirror, which is how
 * most people expect to see themselves. Some hosts prefer the true view, for
 * example to check that a book or sign reads correctly. Only your own preview
 * changes: the broadcast and recordings are never mirrored.
 */

const STORAGE_KEY = 'livestream-studio:mirror-self-view';
const listeners = new Set<() => void>();

export function readMirrorSelfView(storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setMirrorSelfView(mirror: boolean, storage: Pick<Storage, 'setItem'> | undefined = safeLocalStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, String(mirror));
  } catch {
    // Storage can be unavailable; the choice still applies until reload.
  }
  current = mirror;
  listeners.forEach((listener) => listener());
}

let current: boolean | null = null;

function snapshot(): boolean {
  if (current === null) current = readMirrorSelfView();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether your own preview is shown mirrored; updates every preview at once. */
export function useMirrorSelfView(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

export function selfViewTransform(mirror: boolean): string {
  return mirror ? 'scaleX(-1)' : 'none';
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
