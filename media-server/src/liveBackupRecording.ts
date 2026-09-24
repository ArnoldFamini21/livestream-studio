import { randomUUID } from 'node:crypto';
import { mkdir, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  RtmpRelayAudioConfig,
  RtmpRelayVideoConfig,
} from '@studio/shared';
import { normalizeAudioConfig, normalizeVideoConfig } from './rtmp.js';

const DEFAULT_LIVE_BACKUP_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MIN_LIVE_BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const MAX_LIVE_BACKUP_MAX_BYTES = 64 * 1024 * 1024 * 1024;

export type LiveBackupRecordingStatus = 'recording' | 'finalizing' | 'ready' | 'error';
export type LiveBackupStorageStatus = 'uploading' | 'stored' | 'failed';
export type LiveBackupRecordingPublicStatusValue = LiveBackupRecordingStatus | 'disabled';

export interface LiveBackupRecordingOptions {
  roomId: string;
  video: RtmpRelayVideoConfig;
  audio: RtmpRelayAudioConfig;
  now?: Date;
  rootDir?: string;
  maxBytes?: number;
}

export interface LiveBackupRecording {
  backupId: string;
  roomId: string;
  fileName: string;
  filePath: string;
  startedAt: string;
  stoppedAt?: string;
  status: LiveBackupRecordingStatus;
  sizeBytes?: number;
  error?: string;
  storageStatus?: LiveBackupStorageStatus;
  /** Object key of the MP4 once it is in storage. */
  storageKey?: string;
  storageError?: string;
}

export interface LiveBackupRecordingPublicStatus {
  backupId: string;
  roomId: string;
  fileName: string;
  startedAt: string;
  stoppedAt?: string;
  status: LiveBackupRecordingPublicStatusValue;
  sizeBytes?: number;
  downloadPath?: string;
  error?: string;
  storageStatus?: LiveBackupStorageStatus;
}

export interface FfmpegLiveBackupOptions {
  video: RtmpRelayVideoConfig;
  audio: RtmpRelayAudioConfig;
  maxBytes?: number;
}

export function isLiveBackupRecordingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.RTMP_BACKUP_RECORDING_ENABLED || env.LIVE_BACKUP_RECORDING_ENABLED;
  if (!value) return true;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

export function getLiveBackupRootDir(env: Record<string, string | undefined> = process.env): string {
  return env.RTMP_BACKUP_RECORDING_DIR?.trim() || path.join(os.tmpdir(), 'livestream-studio-live-backups');
}

export function getLiveBackupMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.RTMP_BACKUP_RECORDING_MAX_BYTES || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIVE_BACKUP_MAX_BYTES;
  return Math.min(MAX_LIVE_BACKUP_MAX_BYTES, Math.max(MIN_LIVE_BACKUP_MAX_BYTES, parsed));
}

export function sanitizeLiveBackupFilePart(value: string, fallback: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

export async function createLiveBackupRecording(options: LiveBackupRecordingOptions): Promise<LiveBackupRecording> {
  const started = options.now || new Date();
  const backupId = `backup-${randomUUID()}`;
  const safeRoom = sanitizeLiveBackupFilePart(options.roomId, 'room');
  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const fileName = `${safeRoom}-${stamp}-live-backup.mp4`;
  const rootDir = options.rootDir || getLiveBackupRootDir();
  const roomDir = path.join(rootDir, safeRoom);
  await mkdir(roomDir, { recursive: true });

  return {
    backupId,
    roomId: options.roomId,
    fileName,
    filePath: path.join(roomDir, fileName),
    startedAt: started.toISOString(),
    status: 'recording',
  };
}

export function createFfmpegLiveBackupArgs(outputPath: string, options: FfmpegLiveBackupOptions): string[] {
  const video = normalizeVideoConfig(options.video);
  const audio = normalizeAudioConfig(options.audio);
  const videoBitrateKbps = Math.round(video.videoBitsPerSecond / 1000);
  const audioBitrateKbps = Math.round(audio.audioBitsPerSecond / 1000);
  const gop = video.frameRate * 2;
  const maxBytes = Math.max(MIN_LIVE_BACKUP_MAX_BYTES, Math.round(options.maxBytes || DEFAULT_LIVE_BACKUP_MAX_BYTES));

  return [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
    '-f', 'webm',
    '-i', 'pipe:0',
    '-vf', `scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease,pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-r', String(video.frameRate),
    '-g', String(gop),
    '-b:v', `${videoBitrateKbps}k`,
    '-maxrate', `${Math.round(videoBitrateKbps * 1.15)}k`,
    '-bufsize', `${videoBitrateKbps * 2}k`,
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channelCount),
    '-movflags', '+faststart',
    '-fs', String(maxBytes),
    '-f', 'mp4',
    outputPath,
  ];
}

export async function refreshLiveBackupSize(recording: LiveBackupRecording): Promise<LiveBackupRecording> {
  try {
    const file = await stat(recording.filePath);
    recording.sizeBytes = file.size;
  } catch {
    // A failed FFmpeg run may not create a file.
  }
  return recording;
}

export function toLiveBackupPublicStatus(recording: LiveBackupRecording): LiveBackupRecordingPublicStatus {
  return {
    backupId: recording.backupId,
    roomId: recording.roomId,
    fileName: recording.fileName,
    startedAt: recording.startedAt,
    ...(recording.stoppedAt ? { stoppedAt: recording.stoppedAt } : {}),
    status: recording.status,
    ...(recording.sizeBytes !== undefined ? { sizeBytes: recording.sizeBytes } : {}),
    ...(recording.status === 'ready' ? { downloadPath: `/rtmp/backups/${encodeURIComponent(recording.backupId)}/download` } : {}),
    ...(recording.error ? { error: recording.error } : {}),
    ...(recording.storageStatus ? { storageStatus: recording.storageStatus } : {}),
  };
}

/** What is kept in object storage so a backup can be found after a restart. */
export interface StoredLiveBackupRecord {
  backupId: string;
  roomId: string;
  fileName: string;
  startedAt: string;
  stoppedAt?: string;
  sizeBytes?: number;
  storageKey: string;
}

export function toStoredLiveBackupRecord(recording: LiveBackupRecording, storageKey: string): StoredLiveBackupRecord {
  return {
    backupId: recording.backupId,
    roomId: recording.roomId,
    fileName: recording.fileName,
    startedAt: recording.startedAt,
    ...(recording.stoppedAt ? { stoppedAt: recording.stoppedAt } : {}),
    ...(recording.sizeBytes !== undefined ? { sizeBytes: recording.sizeBytes } : {}),
    storageKey,
  };
}

export function parseStoredLiveBackupRecord(text: string | null): StoredLiveBackupRecord | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<StoredLiveBackupRecord>;
    const strings = [value.backupId, value.roomId, value.fileName, value.startedAt, value.storageKey];
    if (!strings.every((item) => typeof item === 'string' && item.length > 0)) return null;
    return {
      backupId: value.backupId!,
      roomId: value.roomId!,
      fileName: value.fileName!,
      startedAt: value.startedAt!,
      ...(typeof value.stoppedAt === 'string' ? { stoppedAt: value.stoppedAt } : {}),
      ...(typeof value.sizeBytes === 'number' ? { sizeBytes: value.sizeBytes } : {}),
      storageKey: value.storageKey!,
    };
  } catch {
    return null;
  }
}

/** Rebuild a finished backup from its stored record (the local file is gone). */
export function fromStoredLiveBackupRecord(record: StoredLiveBackupRecord, filePath: string): LiveBackupRecording {
  return {
    backupId: record.backupId,
    roomId: record.roomId,
    fileName: record.fileName,
    filePath,
    startedAt: record.startedAt,
    ...(record.stoppedAt ? { stoppedAt: record.stoppedAt } : {}),
    ...(record.sizeBytes !== undefined ? { sizeBytes: record.sizeBytes } : {}),
    status: 'ready',
    storageStatus: 'stored',
    storageKey: record.storageKey,
  };
}

export interface LiveBackupStorageTarget {
  /** Object keys for the MP4, the record by backup id, and the room's latest record. */
  keys: { video: string; record: string; latest: string };
  uploadFile: (input: { filePath: string; key: string; contentType: string }) => Promise<unknown>;
  putText: (key: string, body: string) => Promise<void>;
  removeFile?: (filePath: string) => Promise<void>;
}

/**
 * Copy a finished backup to object storage, so it survives a restart or the
 * free instance going to sleep. The local copy is then removed to free disk;
 * downloads come from storage.
 */
export async function storeLiveBackupRecording(
  recording: LiveBackupRecording,
  target: LiveBackupStorageTarget
): Promise<void> {
  recording.storageStatus = 'uploading';
  try {
    await target.uploadFile({ filePath: recording.filePath, key: target.keys.video, contentType: 'video/mp4' });
  } catch (err) {
    recording.storageStatus = 'failed';
    recording.storageError = err instanceof Error ? err.message : 'Backup upload failed';
    return;
  }
  recording.storageKey = target.keys.video;

  // The records only help find the backup after a restart; the MP4 is safe.
  const record = JSON.stringify(toStoredLiveBackupRecord(recording, target.keys.video));
  try {
    await target.putText(target.keys.record, record);
    await target.putText(target.keys.latest, record);
  } catch (err) {
    console.warn(`Live backup ${recording.backupId} record was not saved:`, err instanceof Error ? err.message : err);
  }
  await (target.removeFile || unlink)(recording.filePath).catch(() => undefined);
  // Last, so "stored" means downloads come from storage from now on.
  recording.storageStatus = 'stored';
}
