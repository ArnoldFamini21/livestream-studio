import type { StreamDestination } from '@studio/shared';
import { MAX_ENABLED_DESTINATIONS, STREAM_PLATFORM_GUIDES, isValidRtmpUrl } from './streamDestinations.ts';

/**
 * Destinations are remembered on this device so hosts do not re-enter them
 * every show. Stream keys are secrets: a key is kept only when the host opts
 * in for that destination. Broadcasts created through a connected account are
 * single-use, so they are never remembered.
 */

export const STREAM_DESTINATIONS_STORAGE_KEY = 'livestream-studio:stream-destinations:v1';
export const MAX_SAVED_DESTINATIONS = 12;

export type SavedStreamDestination = Pick<StreamDestination, 'platform' | 'name' | 'rtmpUrl' | 'enabled'> & {
  streamKey?: string;
  rememberStreamKey?: boolean;
};

export type RestoredStreamDestination = Omit<StreamDestination, 'id' | 'status' | 'statusMessage'>;

const PLATFORMS = new Set(STREAM_PLATFORM_GUIDES.map((guide) => guide.platform));

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function serializeStreamDestinations(destinations: StreamDestination[]): SavedStreamDestination[] {
  return destinations
    .filter((destination) => !destination.connection)
    .slice(0, MAX_SAVED_DESTINATIONS)
    .map((destination) => ({
      platform: destination.platform,
      name: destination.name.trim().slice(0, 80),
      rtmpUrl: destination.rtmpUrl.trim(),
      enabled: destination.enabled,
      ...(destination.rememberStreamKey && destination.streamKey.trim()
        ? { rememberStreamKey: true, streamKey: destination.streamKey.trim() }
        : {}),
    }));
}

export function restoreStreamDestinations(value: unknown): RestoredStreamDestination[] {
  if (!Array.isArray(value)) return [];
  let enabledCount = 0;
  const restored: RestoredStreamDestination[] = [];
  for (const item of value.slice(0, MAX_SAVED_DESTINATIONS)) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<SavedStreamDestination>;
    if (typeof candidate.platform !== 'string' || !PLATFORMS.has(candidate.platform)) continue;
    if (typeof candidate.name !== 'string' || !candidate.name.trim()) continue;
    if (typeof candidate.rtmpUrl !== 'string' || !isValidRtmpUrl(candidate.rtmpUrl.trim())) continue;
    const rememberStreamKey = candidate.rememberStreamKey === true
      && typeof candidate.streamKey === 'string'
      && candidate.streamKey.trim().length > 0
      && candidate.streamKey.length <= 512;
    const streamKey = rememberStreamKey ? (candidate.streamKey as string).trim() : '';
    // A destination without its key cannot go live, so it comes back switched off.
    const enabled = candidate.enabled === true && Boolean(streamKey) && enabledCount < MAX_ENABLED_DESTINATIONS;
    if (enabled) enabledCount += 1;
    restored.push({
      platform: candidate.platform,
      name: candidate.name.trim().slice(0, 80),
      rtmpUrl: candidate.rtmpUrl.trim(),
      streamKey,
      enabled,
      ...(rememberStreamKey ? { rememberStreamKey: true } : {}),
    });
  }
  return restored;
}

export function loadSavedStreamDestinations(storage: StorageLike | null = getStorage()): RestoredStreamDestination[] {
  if (!storage) return [];
  try {
    return restoreStreamDestinations(JSON.parse(storage.getItem(STREAM_DESTINATIONS_STORAGE_KEY) || '[]'));
  } catch {
    return [];
  }
}

/** Returns the serialized value that was written, or null when storage is unavailable. */
export function saveStreamDestinations(
  destinations: StreamDestination[],
  storage: StorageLike | null = getStorage()
): string | null {
  if (!storage) return null;
  const serialized = JSON.stringify(serializeStreamDestinations(destinations));
  try {
    storage.setItem(STREAM_DESTINATIONS_STORAGE_KEY, serialized);
    return serialized;
  } catch {
    return null;
  }
}
