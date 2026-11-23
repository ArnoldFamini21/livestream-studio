import { createHash } from 'node:crypto';
import {
  RECORDING_RECOVERY_IDENTIFIER, RECORDING_RECOVERY_SHA256, RECORDING_RECOVERY_TTL_MS,
  type RecordingRecoveryCreateClaims, type RecordingRecoveryParticipant, type RecordingRecoveryTrack,
  type RecordingRecoveryTrackInput, type RecordingRecoveryUploadStatus,
} from '@studio/shared';
import { type RecordingRecoveryStorage, type RecoveryChunkReceipt } from './recordingRecoveryStorage.js';

const MAX_PARTICIPANTS = 12;
const MAX_TRACKS = 24;
const MAX_CHUNKS = 8192;
const MAX_PARTICIPANT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 8 * 1024;
const ALLOWED_KINDS = new Set(['iso', 'audio', 'video', 'screen']);
const ALLOWED_MIME = /^(?:(?:audio|video)\/(?:mp4|webm)|audio\/(?:wav|x-wav|ogg))(?:;[A-Za-z0-9=._", -]+)?$/i;

export class RecordingRecoveryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface RecoveryTakeDocument {
  v: 1;
  roomId: string;
  takeId: string;
  createdAtMs: number;
  expiresAtMs: number;
  participants: RecordingRecoveryParticipant[];
}

interface ParticipantTrackDocument {
  v: 1;
  tracks: RecordingRecoveryTrack[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : '';
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function conflict(message: string): never {
  throw new RecordingRecoveryError(409, message);
}

function parseTrackInput(input: unknown): RecordingRecoveryTrackInput {
  const record = asRecord(input);
  const trackId = typeof record?.trackId === 'string' ? record.trackId : '';
  const label = text(record?.label, 120);
  const kind = text(record?.kind, 20);
  const mimeType = typeof record?.mimeType === 'string' && record.mimeType.length <= 128 ? record.mimeType.trim() : '';
  if (!RECORDING_RECOVERY_IDENTIFIER.test(trackId) || !label || !ALLOWED_KINDS.has(kind) || !ALLOWED_MIME.test(mimeType)) {
    throw new RecordingRecoveryError(400, 'This recording track is not supported');
  }
  return { trackId, label, kind, mimeType };
}

function parseRoster(value: unknown): RecordingRecoveryParticipant[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PARTICIPANTS) {
    throw new RecordingRecoveryError(400, 'Invalid recording take participant list');
  }
  const result = value.map(item => {
    const input = asRecord(item);
    const participantId = typeof input?.participantId === 'string' ? input.participantId : '';
    const participantName = text(input?.participantName, 120);
    if (!RECORDING_RECOVERY_IDENTIFIER.test(participantId) || !participantName) {
      throw new RecordingRecoveryError(400, 'Invalid recording take participant');
    }
    return { participantId, participantName };
  });
  if (new Set(result.map(item => item.participantId)).size !== result.length) {
    throw new RecordingRecoveryError(400, 'Duplicate participant in recording take');
  }
  return result;
}

export class RecoveryTake {
  private readonly prefix: string[];

  constructor(private readonly store: RecordingRecoveryStorage, storageId: string) {
    this.prefix = [storageId];
  }

  private key(...segments: string[]) {
    return this.store.key(...this.prefix, ...segments);
  }

  private tracksKey(participantId: string) {
    return this.key('participants', participantId, 'tracks.json');
  }

  private chunkKey(participantId: string, trackId: string, sequence: number) {
    return this.key('participants', participantId, 'tracks', trackId, String(sequence));
  }

  async read(roomId: string, takeId: string, now: number): Promise<RecoveryTakeDocument> {
    const manifest = (await this.store.readJson<RecoveryTakeDocument>(this.key('take.json')))?.value;
    if (!manifest || manifest.v !== 1 || manifest.roomId !== roomId || manifest.takeId !== takeId) {
      throw new RecordingRecoveryError(404, 'Recording backup was not found');
    }
    if (!Number.isSafeInteger(manifest.expiresAtMs) || manifest.expiresAtMs <= now) {
      throw new RecordingRecoveryError(410, 'This recording backup has expired');
    }
    return manifest;
  }

  async create(claims: RecordingRecoveryCreateClaims, input: unknown, now: number) {
    const record = asRecord(input);
    const createdAtMs = record?.createdAtMs;
    const expiresAtMs = record?.expiresAtMs;
    if (!integer(createdAtMs, now - 120_000, now + 120_000) || expiresAtMs !== createdAtMs + RECORDING_RECOVERY_TTL_MS) {
      throw new RecordingRecoveryError(400, 'Invalid recording backup expiry');
    }
    const participants = parseRoster(record?.participants);
    const manifest: RecoveryTakeDocument = { v: 1, roomId: claims.roomId, takeId: claims.takeId, createdAtMs, expiresAtMs, participants };
    if (await this.store.writeJson(this.key('take.json'), manifest, null)) return manifest;
    // A retry after the first response was lost returns the original durable roster and expiry.
    return this.read(claims.roomId, claims.takeId, now);
  }

  async tracks(participantId: string): Promise<RecordingRecoveryTrack[]> {
    const index = await this.store.readJson<ParticipantTrackDocument>(this.tracksKey(participantId));
    if (!index) return [];
    if (index.value.v !== 1 || !Array.isArray(index.value.tracks)) throw new Error('Recording backup track index is invalid');
    return index.value.tracks;
  }

  async hostStatus(manifest: RecoveryTakeDocument) {
    const tracks = (await Promise.all(manifest.participants.map(participant => this.tracks(participant.participantId)))).flat();
    return {
      roomId: manifest.roomId, takeId: manifest.takeId,
      expiresAt: new Date(manifest.expiresAtMs).toISOString(), participants: manifest.participants, tracks,
    };
  }

  async uploadStatus(manifest: RecoveryTakeDocument, participantId: string): Promise<RecordingRecoveryUploadStatus> {
    return { expiresAt: new Date(manifest.expiresAtMs).toISOString(), tracks: await this.tracks(participantId) };
  }

  async register(participant: RecordingRecoveryParticipant, input: unknown): Promise<RecordingRecoveryTrack> {
    const definition = parseTrackInput(input);
    return this.updateTracks(participant.participantId, async tracks => {
      const existing = tracks.find(track => track.trackId === definition.trackId);
      if (existing) {
        if (existing.kind !== definition.kind || existing.mimeType !== definition.mimeType) {
          conflict('This track already has a different recording format');
        }
        return { track: existing };
      }
      if (tracks.length >= MAX_TRACKS) throw new RecordingRecoveryError(413, 'This guest has reached the recording backup track limit');
      const track: RecordingRecoveryTrack = { ...participant, ...definition, receivedBytes: 0, nextSequence: 0, status: 'uploading' };
      return { track, updated: [...tracks, track] };
    });
  }

  async append(participantId: string, trackId: string, receipt: RecoveryChunkReceipt, sequence: number, bytes: Uint8Array<ArrayBuffer>) {
    if (!integer(sequence, 0, MAX_CHUNKS - 1) || !integer(receipt.offset, 0, MAX_PARTICIPANT_BYTES) ||
        !bytes.byteLength || !RECORDING_RECOVERY_SHA256.test(receipt.sha256)) {
      throw new RecordingRecoveryError(400, 'Invalid recording chunk');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) {
      throw new RecordingRecoveryError(422, 'Recording chunk checksum did not match');
    }
    const chunkKey = this.chunkKey(participantId, trackId, sequence);
    let committed = false;
    async function requireMatchingReceipt(store: RecordingRecoveryStorage) {
      const actual = await store.headChunk(chunkKey);
      if (actual.offset !== receipt.offset || actual.bytes !== receipt.bytes || actual.sha256 !== receipt.sha256) {
        conflict('Different bytes were already committed at this recording offset');
      }
    }
    return this.updateTracks(participantId, async tracks => {
      const track = this.getTrack(tracks, trackId);
      if (sequence < track.nextSequence) {
        if (!committed) await requireMatchingReceipt(this.store);
        return { track };
      }
      if (track.status === 'verified' || sequence !== track.nextSequence || receipt.offset !== track.receivedBytes) {
        conflict('Recording chunk is out of order. Check the saved upload offset.');
      }
      if (tracks.reduce((total, item) => total + item.receivedBytes, 0) + bytes.byteLength > MAX_PARTICIPANT_BYTES) {
        throw new RecordingRecoveryError(413, 'This guest has reached the recording backup size limit');
      }
      // Bytes are immutable. If the process stops between PUT and the track index
      // update, the next request checks the committed object's receipt and adopts it.
      if (!committed) {
        if (!await this.store.createChunk(chunkKey, bytes, receipt)) await requireMatchingReceipt(this.store);
        committed = true;
      }
      const next = { ...track, receivedBytes: track.receivedBytes + bytes.byteLength, nextSequence: sequence + 1 };
      return { track: next, updated: tracks.map(item => item === track ? next : item) };
    });
  }

  async complete(participantId: string, trackId: string, input: unknown) {
    const record = asRecord(input);
    const totalBytes = record?.totalBytes;
    const chunkCount = record?.chunkCount;
    const capture = asRecord(record?.capture);
    if (!integer(totalBytes, 1, MAX_PARTICIPANT_BYTES) || !integer(chunkCount, 1, MAX_CHUNKS) ||
        (capture && Buffer.byteLength(JSON.stringify(capture)) > MAX_CAPTURE_BYTES)) {
      throw new RecordingRecoveryError(400, 'Invalid recording completion');
    }
    return this.updateTracks(participantId, async tracks => {
      const track = this.getTrack(tracks, trackId);
      if (track.receivedBytes !== totalBytes || track.nextSequence !== chunkCount) {
        conflict('Some recording chunks have not arrived');
      }
      if (track.status === 'verified') return { track };
      const next: RecordingRecoveryTrack = { ...track, status: 'verified', totalBytes, ...(capture ? { capture } : {}) };
      return { track: next, updated: tracks.map(item => item === track ? next : item) };
    });
  }

  async verifiedTrack(participantId: string, trackId: string) {
    const track = this.getTrack(await this.tracks(participantId), trackId);
    if (track.status !== 'verified' || !track.totalBytes) conflict('This recording track is still uploading');
    return track;
  }

  async *download(track: RecordingRecoveryTrack, signal: AbortSignal) {
    let offset = 0;
    for (let sequence = 0; sequence < track.nextSequence; sequence++) {
      if (signal.aborted) return;
      const bytes = await this.store.readChunk(this.chunkKey(track.participantId, track.trackId, sequence), offset, signal);
      offset += bytes.byteLength;
      if (offset > track.receivedBytes || (sequence === track.nextSequence - 1 && offset !== track.receivedBytes)) {
        throw new Error('Verified recording size did not match');
      }
      yield bytes;
    }
  }

  private getTrack(tracks: RecordingRecoveryTrack[], trackId: string) {
    const track = tracks.find(item => item.trackId === trackId);
    if (!track) throw new RecordingRecoveryError(404, 'Recording track was not found');
    return track;
  }

  private async updateTracks(
    participantId: string,
    change: (tracks: RecordingRecoveryTrack[]) => Promise<{ track: RecordingRecoveryTrack; updated?: RecordingRecoveryTrack[] }>,
  ): Promise<RecordingRecoveryTrack> {
    const key = this.tracksKey(participantId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const index = await this.store.readJson<ParticipantTrackDocument>(key);
      if (index && (index.value.v !== 1 || !Array.isArray(index.value.tracks))) throw new Error('Invalid recording track index');
      const result = await change(index?.value.tracks ?? []);
      if (!result.updated ||
          await this.store.writeJson(key, { v: 1, tracks: result.updated }, index?.version ?? null)) return result.track;
    }
    conflict('This upload changed in another browser tab. Check the saved upload offset.');
  }
}
