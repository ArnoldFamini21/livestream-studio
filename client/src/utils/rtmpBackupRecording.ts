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
  /** Keep polling a ready backup until its cloud copy finishes. */
  waitForStorage?: boolean;
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
    const uploading = input.waitForStorage && latest?.status === 'ready' && latest.storageStatus === 'uploading';
    if (!latest || (!uploading && (latest.status === 'ready' || latest.status === 'error' || latest.status === 'disabled'))) {
      return latest;
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  return latest;
}

export interface RtmpBackupDownloadLink {
  url: string;
  fileName: string;
}

/**
 * A short-lived link to the backup in cloud storage (R2/S3). Returns null when
 * the backup is not in storage (yet), so the caller downloads it from the
 * media server instead.
 */
export async function requestRtmpBackupDownloadLink(
  input: DownloadRtmpBackupRecordingInput
): Promise<RtmpBackupDownloadLink | null> {
  const token = input.token.trim();
  const mediaHttpUrl = (input.mediaHttpUrl || resolveMediaHttpUrl()).trim();
  const backupId = input.backup.backupId?.trim();
  if (!token || !mediaHttpUrl || !backupId || input.backup.status !== 'ready') return null;

  const response = await fetch(
    buildMediaUrl(mediaHttpUrl, `/rtmp/backups/${encodeURIComponent(backupId)}/download-link`),
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } }
  );
  // 404: an older media server or an unknown backup. 409: not in storage yet.
  if (response.status === 404 || response.status === 409) return null;
  const body = await response.text();
  let json: unknown = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // Reported below.
  }
  const link = json as Partial<RtmpBackupDownloadLink> & { error?: unknown } | null;
  if (!response.ok || !link || typeof link.url !== 'string' || !/^https?:\/\//i.test(link.url)) {
    throw new Error(typeof link?.error === 'string' ? link.error : `Media server returned HTTP ${response.status}`);
  }
  return {
    url: link.url,
    fileName: safeFileName(typeof link.fileName === 'string' ? link.fileName : input.backup.fileName || `${backupId}.mp4`, 'live-backup.mp4'),
  };
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
