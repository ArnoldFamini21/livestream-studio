import type { Participant } from '@studio/shared';
import type { ExpectedTakeTrack, TakeManifest, TakeManifestTrack } from './recordingTakeManifest.ts';
import { recordingPathSegment, reopenTakeFolder, TAKE_MANIFEST_FILE_NAME, takeTrackSegments, type TakeDirectoryHandle, type TakeFolder } from './recordingTakeFolder.ts';
import { getTrackFileName } from './recordingTrackStore.ts';
import type { ReceivedTrackEntry, ReceivedTrackSink } from './recordingTransferSession.ts';
import type { TransferTrackAnnouncement } from './recordingTransferProtocol.ts';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TAKE_SCAN = 100;
const MAX_TAKE_LIST = 20;
const TAKE_FOLDER_NAME = /^\d{4}-\d{2}-\d{2} \d{4} (?:take|recovered)(?: \d{1,2})?$/;
const TRANSFER_TRACK_ID = /^[A-Za-z0-9_-]{1,160}$/;

export function expectedGuestTracks(participants: Iterable<Participant>): ExpectedTakeTrack[] {
  const planned: ExpectedTakeTrack[] = [];
  for (const participant of participants) {
    if (participant.status !== 'on-stage' || participant.role === 'host' || participant.role === 'co-host') continue;
    const base = { participantId: participant.id, participantName: participant.name, origin: 'guest-transfer' as const };
    if (participant.videoEnabled) planned.push({ ...base, kind: 'iso', label: participant.name + ' ISO' });
    if (participant.audioEnabled) planned.push({ ...base, kind: 'audio', label: participant.name + ' audio' });
    if (participant.screenSharing) planned.push({ ...base, kind: 'screen', label: participant.name + ' screen' });
  }
  return planned;
}

function trackKey(track: ExpectedTakeTrack): string {
  const origin = track.origin === 'browser-fallback' ? 'host' : track.origin;
  return JSON.stringify([origin, track.participantId ?? '', track.kind, Boolean(track.lossless),
    origin === 'program' ? track.label : '']);
}

export type TakeReceiptState = 'recording' | 'transferring' | 'missing' | 'verified';

export interface TakeChecklistRow {
  key: string;
  label: string;
  state: TakeReceiptState;
  participantId?: string;
  participantName?: string;
  bytes?: number;
}

export interface TakeChecklist {
  id: string;
  startedAt: string;
  rows: TakeChecklistRow[];
}

export function buildTakeChecklist(
  manifest: TakeManifest,
  received: Iterable<ReceivedTrackEntry>,
  active: boolean,
  connected: ReadonlySet<string>,
): TakeChecklist {
  const expected = new Map((manifest.expectedTracks ?? []).map(track => [trackKey(track), track]));
  const observed = new Set<string>();
  const finalized = new Set<string>();
  const rows: TakeChecklistRow[] = [];
  for (const [index, track] of manifest.tracks.entries()) {
    if (track.status !== 'complete' || track.bytes <= 0) continue;
    observed.add(trackKey(track));
    if (track.trackId) finalized.add(track.trackId);
    rows.push({ key: track.trackId ?? 'file:' + index, label: track.label, state: 'verified', bytes: track.bytes });
  }
  for (const entry of received) {
    if (entry.announcement.sessionId !== manifest.takeId || finalized.has(entry.id)) continue;
    const label = entry.announcement.label;
    const participant = { id: entry.participantId, name: entry.participantName };
    const track: ExpectedTakeTrack = { participantId: participant.id, participantName: participant.name, label,
      kind: entry.announcement.kind, origin: 'guest-transfer', lossless: entry.announcement.lossless };
    observed.add(trackKey(track));
    if (entry.status === 'complete' && !entry.finishing && entry.received > 0) {
      rows.push({ key: entry.id, label, state: 'verified', bytes: entry.received });
    } else {
      rows.push({
        key: entry.id, label, participantId: participant.id, participantName: participant.name, bytes: entry.received,
        state: entry.finishing || (entry.status === 'receiving' && connected.has(participant.id))
          ? 'transferring' : active && entry.status === 'receiving' ? 'recording' : 'missing',
      });
    }
  }
  for (const [key, track] of expected) {
    if (observed.has(key)) continue;
    rows.push({
      key, label: track.label, state: active ? 'recording' : 'missing',
      ...(track.origin === 'guest-transfer' ? { participantId: track.participantId, participantName: track.participantName } : {}),
    });
  }
  return { id: manifest.takeId, startedAt: manifest.startedAt, rows };
}

interface StoredTake {
  folder: TakeFolder;
  manifest: TakeManifest;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isText = (value: unknown, max = 400): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const origins = new Set(['host', 'program', 'guest-transfer', 'browser-fallback']);
const isFileMissing = (error: unknown) => isObject(error)
  && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');

function isExpectedTrack(value: unknown): value is ExpectedTakeTrack {
  return isObject(value) && isText(value.participantName, 200) && isText(value.label, 240)
    && isText(value.kind, 40) && isText(value.origin, 40) && origins.has(value.origin)
    && (value.participantId === undefined || isText(value.participantId, 200))
    && (value.lossless === undefined || typeof value.lossless === 'boolean');
}

function isTrack(value: unknown, folder: string): value is TakeManifestTrack {
  if (!isObject(value) || !isExpectedTrack(value)) return false;
  return isText(value.path) && Boolean(takeTrackSegments(folder, value.path))
    && typeof value.mimeType === 'string' && value.mimeType.length <= 200
    && typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0
    && ['recording', 'receiving', 'complete', 'incomplete'].includes(String(value.status));
}

async function readTakeManifest(folder: TakeFolder, roomId: string): Promise<TakeManifest | null> {
  try {
    const file = await (await folder.directory.getFileHandle(TAKE_MANIFEST_FILE_NAME)).getFile();
    if (file.size > MAX_MANIFEST_BYTES) return null;
    const value: unknown = JSON.parse(await file.text());
    if (!isObject(value) || value.format !== 'livestream-studio-take' || value.version !== 1
        || value.folder !== folder.path || value.roomId !== roomId || !isText(value.takeId, 160)
        || !isText(value.startedAt, 50) || !Number.isFinite(Date.parse(value.startedAt))
        || typeof value.startedAtMs !== 'number' || !Number.isFinite(new Date(value.startedAtMs).getTime())
        || !Array.isArray(value.pauses) || !Array.isArray(value.tracks) || !value.tracks.every(track => isTrack(track, folder.path))
        || (value.expectedTracks !== undefined && (!Array.isArray(value.expectedTracks) || !value.expectedTracks.every(isExpectedTrack)))) return null;
    return value as unknown as TakeManifest;
  } catch (error) {
    if (error instanceof SyntaxError || isFileMissing(error)) return null;
    throw error;
  }
}

/** Inspect only Studio-created folders for this room under the chosen recording drive. */
export async function readStudioTakes(
  root: TakeDirectoryHandle,
  studioName: string,
  roomId: string,
  takeId?: string,
): Promise<StoredTake[]> {
  const studioFolder = recordingPathSegment(studioName, 'Studio', 64);
  let studio: TakeDirectoryHandle;
  try { studio = await root.getDirectoryHandle(studioFolder); }
  catch (error) {
    if (isFileMissing(error)) return [];
    throw error;
  }
  const folders: string[] = [];
  for await (const name of studio.keys()) {
    if (TAKE_FOLDER_NAME.test(name)) folders.push(name);
  }
  folders.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const result: StoredTake[] = [];
  for (const name of folders.slice(0, MAX_TAKE_SCAN)) {
    let folder: TakeFolder;
    try { folder = await reopenTakeFolder(root, studioFolder, name); }
    catch (error) {
      if (isFileMissing(error)) continue;
      throw error;
    }
    const manifest = await readTakeManifest(folder, roomId);
    if (!manifest) continue;
    if (takeId) {
      if (manifest.takeId === takeId) return [{ folder, manifest }];
      continue;
    }
    result.push({ folder, manifest });
    if (result.length === MAX_TAKE_LIST) break;
  }
  return result;
}

interface GuestReceipt {
  path: string;
  label: string;
  kind: string;
  mimeType: string;
  expectedBytes?: number;
}

const receiptName = (track: TransferTrackAnnouncement) => TRANSFER_TRACK_ID.test(track.id)
  ? 'transfer-' + track.id + '.json'
  : null;

async function readGuestReceipt(folder: TakeFolder, track: TransferTrackAnnouncement): Promise<GuestReceipt | null> {
  const name = receiptName(track);
  if (!name) return null;
  try {
    const file = await (await folder.directory.getFileHandle(name)).getFile();
    if (file.size > 8192) return null;
    const value: unknown = JSON.parse(await file.text());
    if (!isObject(value) || !isText(value.path) || !takeTrackSegments(folder.path, value.path)
        || value.label !== track.label || value.kind !== track.kind || value.mimeType !== track.mimeType) return null;
    return { path: value.path, label: track.label, kind: track.kind, mimeType: track.mimeType,
      ...(typeof value.expectedBytes === 'number' && Number.isSafeInteger(value.expectedBytes) && value.expectedBytes > 0
        ? { expectedBytes: value.expectedBytes } : {}) };
  } catch (error) {
    if (error instanceof SyntaxError || isFileMissing(error)) return null;
    throw error;
  }
}

async function saveGuestReceipt(folder: TakeFolder, track: TransferTrackAnnouncement, path: string, expectedBytes?: number): Promise<void> {
  const name = receiptName(track);
  if (!name) return;
  const { label, kind, mimeType } = track;
  await folder.writeJson(name, { path, label, kind, mimeType, expectedBytes });
}

async function readFinalGuestFile(folder: TakeFolder, receipt: GuestReceipt): Promise<Blob | null> {
  const segments = takeTrackSegments(folder.path, receipt.path);
  if (!segments || receipt.expectedBytes === undefined) return null;
  try {
    const participant = await folder.directory.getDirectoryHandle(segments[0]);
    const file = await (await participant.getFileHandle(segments[1])).getFile();
    return file.size === receipt.expectedBytes ? file : null;
  } catch (error) {
    if (isFileMissing(error)) return null;
    throw error;
  }
}

export async function openGuestTrackSink(take: TakeFolder, participantId: string, participantName: string, track: TransferTrackAnnouncement): Promise<ReceivedTrackSink> {
  const receipt = await readGuestReceipt(take, track);
  const existing = receipt && track.totalBytes === receipt.expectedBytes ? await readFinalGuestFile(take, receipt) : null;
  if (existing && receipt) {
    const savedFile = { bytes: existing.size, path: receipt.path, file: existing };
    return {
      savedFile, accepted: () => savedFile.bytes,
      async write() { throw new Error('This recording is already on the host drive.'); },
      async finish() { return savedFile; },
    };
  }
  const writer = (receipt ? await take.reopenTrackWriter(receipt.path, track.available) : null)
    ?? await take.createTrackWriter(take.participantFolder(participantId, participantName), getTrackFileName(track.label, track.mimeType));
  // Persist the exact target before the guest sends any bytes.
  await saveGuestReceipt(take, track, writer.path);
  return {
    write: (bytes) => writer.append(new Blob([bytes as Uint8Array<ArrayBuffer>])),
    accepted: () => writer.acceptedBytes(),
    async finish({ header, totalBytes }) {
      await saveGuestReceipt(take, track, writer.path, totalBytes);
      const file = await writer.finish({
        mimeType: track.mimeType,
        ...(header ? { header: new Blob([header as Uint8Array<ArrayBuffer>]) } : {}),
      });
      if (file.size !== totalBytes) throw new Error(`Only ${file.size} of ${totalBytes} bytes were saved.`);
      return { bytes: file.size, path: writer.path, file };
    },
  };
}
