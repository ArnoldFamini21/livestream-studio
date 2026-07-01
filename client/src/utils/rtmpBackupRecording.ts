import type { RtmpRelayBackupRecordingPayload } from '@studio/shared';
import { resolveMediaHttpUrl } from './apiClient.ts';

const BACKUP_POLL_INTERVAL_MS = 1_500;
const BACKUP_POLL_TIMEOUT_MS = 30_000;

export interface PollRtmpBackupRecordingInput {
  token: string;
  roomId: string;
  mediaHttpUrl?: string;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface DownloadRtmpBackupRecordingInput {
  token: string;
  backup: RtmpRelayBackupRecordingPayload;
  mediaHttpUrl?: string;
}

export interface RtmpBackupRecordingDownload {
  blob: Blob;
  fileName: string;
  contentType: string;
}

function buildMediaUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function parseContentDispositionFileName(value: string | null): string {
  if (!value) return '';
  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1].trim());
    } catch {
      return encodedMatch[1].trim();
    }
  }
  const quotedMatch = value.match(/filename="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1].trim();
  const plainMatch = value.match(/filename=([^;]+)/i);
  return plainMatch?.[1]?.trim() || '';
}

function safeFileName(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

async function parseBackupResponse(response: Response): Promise<RtmpRelayBackupRecordingPayload> {
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text.slice(0, 160) || `Media server returned HTTP ${response.status}`);
  }

  if (!response.ok) {
    const message = json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
      ? json.error
      : `Media server returned HTTP ${response.status}`;
    throw new Error(message);
  }

  return json as RtmpRelayBackupRecordingPayload;
}

async function getLatestBackupStatus(
  token: string,
  roomId: string,
  mediaHttpUrl: string
): Promise<RtmpRelayBackupRecordingPayload | null> {
  const response = await fetch(
    buildMediaUrl(mediaHttpUrl, `/rtmp/backups/latest?roomId=${encodeURIComponent(roomId)}`),
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (response.status === 404) return null;
  return parseBackupResponse(response);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export async function pollRtmpBackupRecording(
  input: PollRtmpBackupRecordingInput
): Promise<RtmpRelayBackupRecordingPayload | null> {
  const token = input.token.trim();
  const roomId = input.roomId.trim();
  const mediaHttpUrl = (input.mediaHttpUrl || resolveMediaHttpUrl()).trim();
  if (!token) throw new Error('A host token is required for backup recording status.');
  if (!roomId) throw new Error('Room id is required for backup recording status.');
  if (!mediaHttpUrl) throw new Error('Media server URL is required for backup recording status.');

  const intervalMs = Math.max(250, Math.floor(input.intervalMs || BACKUP_POLL_INTERVAL_MS));
  const timeoutMs = Math.max(intervalMs, Math.floor(input.timeoutMs || BACKUP_POLL_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  let latest: RtmpRelayBackupRecordingPayload | null = null;

  while (Date.now() <= deadline) {
    latest = await getLatestBackupStatus(token, roomId, mediaHttpUrl);
    if (!latest || latest.status === 'ready' || latest.status === 'error' || latest.status === 'disabled') {
      return latest;
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  return latest;
}

export async function downloadRtmpBackupRecording(
  input: DownloadRtmpBackupRecordingInput
): Promise<RtmpBackupRecordingDownload> {
  const token = input.token.trim();
  const mediaHttpUrl = (input.mediaHttpUrl || resolveMediaHttpUrl()).trim();
  const downloadPath = input.backup.downloadPath?.trim();
  if (!token) throw new Error('A host token is required for backup recording download.');
  if (!mediaHttpUrl) throw new Error('Media server URL is required for backup recording download.');
  if (!downloadPath || input.backup.status !== 'ready') {
    throw new Error('Backup recording is not ready for download.');
  }

  const response = await fetch(buildMediaUrl(mediaHttpUrl, downloadPath), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    await parseBackupResponse(response);
  }

  const contentType = response.headers.get('content-type') || 'video/mp4';
  const headerFileName = parseContentDispositionFileName(response.headers.get('content-disposition'));
  return {
    blob: await response.blob(),
    fileName: safeFileName(headerFileName || input.backup.fileName || `${input.backup.backupId}.mp4`, 'live-backup.mp4'),
    contentType,
  };
}
