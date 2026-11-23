import { RECORDING_RECOVERY_IDENTIFIER, type RecordingRecoveryGrant, type RecordingRecoveryTake, type RecordingRecoveryTrack, type RecordingRecoveryUploadStatus } from '@studio/shared';
import { resolveMediaHttpUrl } from './apiClient.ts';
import { PROGRESSIVE_UPLOAD_MAX_CHUNK_BYTES } from './progressiveRecordingUpload.ts';
import { createWavHeader, parseWavHeader, WAV_HEADER_BYTES } from './wavStream.ts';

export interface PrivateRecoveryReference {
  roomId: string;
  takeId: string;
  roomName: string;
  expiresAt: string;
}

interface RecoverySource {
  id: string;
  label: string;
  kind: string;
  blob: Blob;
  capture?: unknown;
}

const GRANTS = 'studio-private-recovery:grant:';
const TAKES = 'studio-private-recovery:take:';
export const RECOVERY_CHANGED_EVENT = 'studio-private-recovery-changed';

function isKey(value: unknown): value is string {
  return typeof value === 'string' && RECORDING_RECOVERY_IDENTIFIER.test(value);
}

function liveReference(value: unknown): value is Pick<PrivateRecoveryReference, 'roomId' | 'takeId' | 'expiresAt'> {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PrivateRecoveryReference>;
  return isKey(row.roomId) && isKey(row.takeId) && typeof row.expiresAt === 'string' && Date.parse(row.expiresAt) > Date.now();
}

function validGrant(value: unknown): value is RecordingRecoveryGrant {
  if (!liveReference(value)) return false;
  const row = value as Partial<RecordingRecoveryGrant>;
  return isKey(row.participantId) && typeof row.token === 'string' && /^[A-Za-z0-9_.-]{20,2200}$/.test(row.token);
}

function remember(key: string, value: RecordingRecoveryGrant | PrivateRecoveryReference) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(RECOVERY_CHANGED_EVENT));
    return true;
  } catch { return false; }
}

export function rememberPrivateRecoveryGrant(grant: RecordingRecoveryGrant): boolean {
  if (!validGrant(grant)) return false;
  return remember(`${GRANTS}${grant.roomId}:${grant.takeId}:${grant.participantId}`, grant);
}

export function rememberPrivateRecoveryTake(take: PrivateRecoveryReference): boolean {
  if (!liveReference(take)) return false;
  return remember(`${TAKES}${take.roomId}:${take.takeId}`, take);
}

function listEntries<T extends { expiresAt: string }>(prefix: string, valid: (value: unknown) => value is T): T[] {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    return keys.flatMap(key => {
      if (!key?.startsWith(prefix)) return [];
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key) || 'null');
        if (valid(value)) return [value];
        localStorage.removeItem(key);
      } catch { /* Ignore invalid browser state. */ }
      return [];
    }).sort((left, right) => Date.parse(right.expiresAt) - Date.parse(left.expiresAt));
  } catch { return []; }
}

export function listPrivateRecoveryGrants(): RecordingRecoveryGrant[] {
  return listEntries(GRANTS, validGrant);
}

export function listPrivateRecoveryTakes(): PrivateRecoveryReference[] {
  return listEntries(TAKES, (value): value is PrivateRecoveryReference => liveReference(value) && 'roomName' in value && typeof value.roomName === 'string');
}

function recoveryPath(take: Pick<PrivateRecoveryReference, 'roomId' | 'takeId'>) {
  return `/recording-recovery/rooms/${encodeURIComponent(take.roomId)}/takes/${encodeURIComponent(take.takeId)}`;
}

export class PrivateRecoveryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

async function recoveryResponse(path: string, init: RequestInit, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${resolveMediaHttpUrl().replace(/\/+$/, '')}${path}`, { cache: 'no-store', ...init });
  if (response.ok) return response;
  let message = 'Private recording storage is temporarily unavailable. Your local copy is still on this device.';
  if (response.status === 401 || response.status === 403 || response.status === 410) message = 'This private recovery link has expired or access was removed.';
  if (response.status === 409) message = 'The saved bytes no longer match this upload. Keep the original track on this device.';
  if (response.status === 422) message = 'The uploaded bytes failed verification. Retry from this device.';
  if (response.status === 404) message = 'This private take is no longer available.';
  throw new PrivateRecoveryError(response.status, message);
}

export async function privateRecoveryAvailable(signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const response = await recoveryResponse('/recording-recovery/capability', { signal }, fetchImpl);
  return (await response.json()).ready === true;
}

export async function readPrivateRecoveryTake(take: PrivateRecoveryReference, hostToken: string, signal?: AbortSignal): Promise<RecordingRecoveryTake> {
  const response = await recoveryResponse(recoveryPath(take), { signal, headers: { 'x-host-token': hostToken } }, fetch);
  return response.json();
}

export async function downloadPrivateRecoveryTrack(take: PrivateRecoveryReference, track: RecordingRecoveryTrack, hostToken: string, signal?: AbortSignal): Promise<Response> {
  return recoveryResponse(`${recoveryPath(take)}/participants/${encodeURIComponent(track.participantId)}/tracks/${encodeURIComponent(track.trackId)}`,
    { signal, headers: { 'x-host-token': hostToken } }, fetch);
}

export async function finalizeRecoverySource(blob: Blob): Promise<Blob> {
  if (blob.type !== 'audio/wav') return blob;
  const format = parseWavHeader(new Uint8Array(await blob.slice(0, WAV_HEADER_BYTES).arrayBuffer()));
  if (!format) throw new Error('The saved WAV is missing its audio header. Keep the original on this device.');
  const data = blob.slice(WAV_HEADER_BYTES);
  return new Blob([createWavHeader(format, data.size), data], { type: blob.type });
}

export async function uploadRecoveredTake(grant: RecordingRecoveryGrant, sources: RecoverySource[], options: {
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
  fetchImpl?: typeof fetch;
} = {}): Promise<void> {
  const { signal, onProgress, fetchImpl = fetch } = options;
  const route = `${recoveryPath(grant)}/upload`;
  const headers = { Authorization: `Bearer ${grant.token}` };
  const json = async <T>(path: string, body?: unknown): Promise<T> => (
    await recoveryResponse(`${route}${path}`, {
      signal, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    }, fetchImpl)
  ).json();
  const { tracks } = await json<RecordingRecoveryUploadStatus>('');
  const total = sources.reduce((sum, source) => sum + source.blob.size, 0);
  let finishedBytes = 0;
  for (const { id, label, kind, blob, capture } of sources) {
    signal?.throwIfAborted();
    const path = `/tracks/${encodeURIComponent(id)}`;
    let track = tracks.find(row => row.trackId === id) ?? await json<RecordingRecoveryTrack>('/tracks', { trackId: id, label, kind, mimeType: blob.type });
    if (track.participantId !== grant.participantId || track.receivedBytes > blob.size || !Number.isSafeInteger(track.receivedBytes) || track.receivedBytes < 0) {
      throw new Error('The private copy does not match the recording on this device.');
    }
    onProgress?.(finishedBytes + track.receivedBytes, total);
    while (track.status !== 'verified' && track.receivedBytes < blob.size) {
      signal?.throwIfAborted();
      const offset = track.receivedBytes;
      const sequence = track.nextSequence;
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('The private copy has an invalid upload offset.');
      const end = Math.min(offset + PROGRESSIVE_UPLOAD_MAX_CHUNK_BYTES, blob.size);
      const slice = blob.slice(offset, end);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await slice.arrayBuffer()));
      const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      const query = new URLSearchParams({ offset: String(offset), sequence: String(sequence), sha256 });
      const append = async (): Promise<RecordingRecoveryTrack> => {
        const response = await recoveryResponse(`${route}${path}/chunks?${query}`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: slice, signal,
        }, fetchImpl);
        return response.json();
      };
      try {
        track = await append();
      } catch (error) {
        if (signal?.aborted || error instanceof PrivateRecoveryError && error.status < 500) throw error;
        // Sending the same bytes and digest is safe even if the first receipt committed.
        track = await append();
      }
      if (track.receivedBytes !== end || track.nextSequence !== sequence + 1) throw new Error('The upload could not confirm the next part. Retry from this device.');
      onProgress?.(finishedBytes + track.receivedBytes, total);
    }
    if (track.status !== 'verified') {
      track = await json<RecordingRecoveryTrack>(`${path}/complete`, { totalBytes: blob.size, chunkCount: track.nextSequence, ...(capture ? { capture } : {}) });
    }
    if (track.status !== 'verified' || track.receivedBytes !== blob.size) throw new Error('Storage could not verify the complete track.');
    finishedBytes += blob.size;
    onProgress?.(finishedBytes, total);
  }
}
