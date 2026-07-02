import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import type { RecordingExportArtifactStatus, RecordingExportJobResponse, RecordingExportVideoCodec } from '@studio/shared';
import type { LiveCaptionSegment } from '../hooks/useLiveCaptions';
import type { LocalRecordingFileResult, RecordingResult } from '../hooks/useLocalRecording';
import { useGoogleDriveUpload } from '../hooks/useGoogleDriveUpload';
import {
  DEFAULT_RECORDING_CLOUD_RETENTION_POLICY_ID,
  RECORDING_CLOUD_RETENTION_POLICIES,
  getRecordingCloudRetentionExpiresAt,
  getRecordingCloudRetentionPolicy,
  useRecordingLibrary,
  type RecordingCloudHandoff,
  type RecordingCloudRetentionPolicyId,
  type LocalRecordingFileRecord,
  type LocalRecordingSession,
  type RecordingMediaExportHandoff,
} from '../hooks/useRecordingLibrary';
import type { RecordingReadinessStatus, RecordingReadinessSummary } from '../utils/recordingReadiness';
import {
  requestRecordingTranscription,
  selectRecordingTranscriptionCandidate,
  type RecordingTranscriptionResult,
} from '../utils/recordingTranscription.ts';
import type { RecordingUploadSummary } from '../utils/recordingUpload.ts';
import type { RecordingCaptureMetadata } from '../utils/recordingCaptureMetadata.ts';
import { buildRecordingSessionSummary } from '../utils/recordingSessionSummary.ts';
import { getRecordingFileExtension } from '../utils/recordingMimeTypes.ts';

interface RecordingPanelProps {
  isRecording: boolean;
  formattedTime: string;
  recordingTrackLabels?: string[];
  recordingReadiness?: RecordingReadinessSummary;
  recordingMarkers?: RecordingMarker[];
  onStartRecording: () => void;
  onStopRecording: () => Promise<RecordingResult>;
  onUploadRecording?: (input: RecordingServerUploadInput) => Promise<RecordingUploadSummary>;
  onDownloadRecordingExportArtifact?: (input: RecordingServerExportArtifactInput) => Promise<BlobExportDownload>;
  onAddRecordingMarker?: (seconds: number, label: string) => void;
  onRemoveRecordingMarker?: (markerId: string) => void;
  onClearRecordingMarkers?: () => void;
  onReplaceRecordingMarkers?: (markers: RecordingMarker[]) => void;
  roomName: string;
  captionSegments?: LiveCaptionSegment[];
  captionLanguage?: string;
  onClose: () => void;
}

export interface RecordingMarker {
  id: string;
  label: string;
  seconds: number;
  createdAt: string;
}

export interface RecordedFile {
  label: string;
  blob: Blob;
  fileName: string;
  kind?: LocalRecordingFileResult['kind'];
  capture?: RecordingCaptureMetadata;
}

export interface RecordingServerUploadInput {
  sessionId: string;
  files: RecordedFile[];
  exportVideoCodec?: RecordingExportVideoCodec;
}

export interface RecordingServerExportArtifactInput {
  uploadId: string;
  exportId: string;
  artifact: RecordingExportArtifactStatus;
}

export interface BlobExportDownload {
  blob: Blob;
  fileName: string;
}

interface RecordingBundleFile {
  label: string;
  fileName: string;
  zipPath: string;
  size: number;
  type: string;
  kind?: LocalRecordingFileResult['kind'];
  capture?: RecordingCaptureMetadata;
}

export interface RecordingBundleSource {
  roomName: string;
  sessionId: string | null;
  createdAt: string;
  durationSeconds: number | null;
  files: RecordedFile[];
  captionSegments?: LiveCaptionSegment[];
  captionLanguage?: string;
  markers?: RecordingMarker[];
  generatedTranscript?: RecordingTranscriptionResult | null;
}

export interface RecordingDriveRetentionManifest {
  policyId: RecordingCloudRetentionPolicyId;
  label: string;
  uploadedAt: string;
  expiresAt: string | null;
  permanent: boolean;
}

interface RecordingCaptionFile {
  label: string;
  format: 'txt' | 'vtt';
  zipPath: string;
  size: number;
  type: string;
}

interface RecordingMarkerFile {
  label: string;
  format: 'json' | 'csv';
  zipPath: string;
  size: number;
  type: string;
}

interface RecordingEditorFile {
  label: string;
  format: 'json' | 'csv' | 'txt' | 'fcpxml' | 'premiere-xml' | 'davinci-resolve-xml';
  zipPath: string;
  size: number;
  type: string;
}

interface RecordingAudioStemFile {
  label: string;
  format: 'wav';
  zipPath: string;
  size: number;
  type: string;
  sourceTrackIndex: number;
  sourceZipPath: string;
  sampleRate: number;
  channels: number;
  bitDepth: 16;
  encoding: 'pcm_s16le';
}

interface RecordingQualityFile {
  label: string;
  format: 'json' | 'txt';
  zipPath: string;
  size: number;
  type: string;
}

interface RecordingQualityTrackReport {
  trackIndex: number;
  label: string;
  kind: string;
  zipPath: string;
  size: number;
  type: string;
  captureDurationSeconds: number | null;
  durationDeltaSeconds: number | null;
  hasCaptureMetadata: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  issues: string[];
}

interface RecordingQualityReport {
  app: 'livestream-studio';
  exportType: 'recording-quality-report';
  version: 1;
  exportedAt: string;
  status: 'ready' | 'review';
  session: {
    id: string | null;
    roomName: string;
    createdAt: string;
    durationSeconds: number | null;
    trackCount: number;
    totalBytes: number;
  };
  checks: {
    hasAudioTrack: boolean;
    hasVideoTrack: boolean;
    hasProgramMix: boolean;
    hasIsoTracks: boolean;
    audioStemCandidateCount: number;
    audioStemGeneratedCount: number;
    audioStemSkippedCount: number;
  };
  tracks: RecordingQualityTrackReport[];
  issues: string[];
}

interface ZipEntry {
  path: string;
  blob: Blob;
  modifiedAt?: Date;
}

interface AudioStemBuildResult {
  entries: ZipEntry[];
  files: RecordingAudioStemFile[];
  skippedCount: number;
  candidateCount: number;
}

export type RecordingLibraryFilter = 'all' | 'audio' | 'video' | 'screen' | 'program' | 'iso' | 'markers' | 'cloud' | 'mp4';

const RECORDING_LIBRARY_FILTERS: Array<{ value: RecordingLibraryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'screen', label: 'Screen' },
  { value: 'program', label: 'Program' },
  { value: 'iso', label: 'ISO' },
  { value: 'markers', label: 'Marked' },
  { value: 'cloud', label: 'Cloud' },
  { value: 'mp4', label: 'MP4' },
];

export interface RecordingLibraryDashboardSummary {
  totalSessions: number;
  visibleSessions: number;
  totalTracks: number;
  totalBytes: number;
  totalDurationSeconds: number;
  markerCount: number;
  cloudSessionCount: number;
  mediaExportSessionCount: number;
  readyMp4ExportSessionCount: number;
  expiringCloudSessionCount: number;
  permanentCloudSessionCount: number;
  latestSession: Pick<LocalRecordingSession, 'id' | 'roomName' | 'createdAt'> | null;
}

const ZIP_UINT32_MAX = 0xffffffff;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_ENCODER = new TextEncoder();
const MAX_MARKER_IMPORT_ROWS = 200;

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // Delay revocation to allow download to initiate
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadTextFile(text: string, fileName: string, type: string) {
  downloadBlob(new Blob([text], { type }), fileName);
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function parseDurationSeconds(value: string): number | null {
  const parts = value.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getRecordingReadinessColor(status: RecordingReadinessStatus): string {
  switch (status) {
    case 'good': return '#86efac';
    case 'warning': return '#fcd34d';
    case 'bad': return '#fca5a5';
  }
}

function getRecordingReadinessBackground(status: RecordingReadinessStatus): string {
  switch (status) {
    case 'good': return 'rgba(34, 197, 94, 0.1)';
    case 'warning': return 'rgba(245, 158, 11, 0.1)';
    case 'bad': return 'rgba(239, 68, 68, 0.1)';
  }
}

function getRecordingReadinessBorder(status: RecordingReadinessStatus): string {
  switch (status) {
    case 'good': return 'rgba(34, 197, 94, 0.24)';
    case 'warning': return 'rgba(245, 158, 11, 0.25)';
    case 'bad': return 'rgba(239, 68, 68, 0.26)';
  }
}

function getRecordingReadinessLabel(status: RecordingReadinessStatus): string {
  switch (status) {
    case 'good': return 'Ready';
    case 'warning': return 'Review';
    case 'bad': return 'Blocked';
  }
}

interface PreviewableRecordingFile {
  fileName: string;
  type?: string;
  blob?: Blob;
}

export function isRawWebCodecsBitstreamFile(file: PreviewableRecordingFile): boolean {
  const type = (file.type || file.blob?.type || '').toLowerCase();
  return (
    type === 'video/x-vp8' ||
    type === 'video/x-vp9' ||
    type === 'video/avc' ||
    /\.(vp8|vp9|h264)$/i.test(file.fileName)
  );
}

export function isPreviewableRecordingFile(file: PreviewableRecordingFile): boolean {
  const type = file.type || file.blob?.type || '';
  if (isRawWebCodecsBitstreamFile(file)) return false;
  return type.startsWith('video/') || type.startsWith('audio/') || /\.(webm|mp4|mov|ogg|mp3|wav)$/i.test(file.fileName);
}

function isPreviewable(file: RecordedFile): boolean {
  return isPreviewableRecordingFile({
    fileName: file.fileName,
    type: getRecordingFileType(file),
  });
}

function getMimeTypeFromFileName(fileName: string, kind?: RecordedFile['kind']): string {
  if (/\.m4a$/i.test(fileName)) return 'audio/mp4';
  if (/\.mp4$/i.test(fileName)) return kind === 'audio' ? 'audio/mp4' : 'video/mp4';
  if (/\.webm$/i.test(fileName)) return kind === 'audio' ? 'audio/webm' : 'video/webm';
  if (/\.ogg$/i.test(fileName)) return 'audio/ogg';
  if (/\.mp3$/i.test(fileName)) return 'audio/mpeg';
  if (/\.wav$/i.test(fileName)) return 'audio/wav';
  return '';
}

function getRecordedFileMimeType(file: Pick<RecordedFile, 'blob' | 'fileName' | 'kind' | 'capture'>): string {
  if (file.blob.type) return file.blob.type;
  if (file.capture?.mimeType) return file.capture.mimeType;
  const fileNameMimeType = getMimeTypeFromFileName(file.fileName, file.kind);
  if (fileNameMimeType) return fileNameMimeType;
  if (file.kind === 'audio') return 'audio/mp4';
  if (file.kind === 'video' || file.kind === 'screen' || file.kind === 'program' || file.kind === 'iso') return 'video/mp4';
  return 'application/octet-stream';
}

function getRecordingResultExtension(file: Pick<LocalRecordingFileResult, 'blob' | 'kind' | 'capture'>): string {
  const mimeType = file.blob.type || file.capture?.mimeType || (file.kind === 'audio' ? 'audio/mp4' : 'video/mp4');
  return getRecordingFileExtension(mimeType);
}

function makeRecordingFileName(
  roomName: string,
  label: string,
  timestamp: string,
  index: number,
  file: Pick<LocalRecordingFileResult, 'blob' | 'kind' | 'capture'>
): string {
  const roomPrefix = sanitizeFileName(roomName, 'studio');
  const labelPart = sanitizeFileName(label, `track_${index + 1}`);
  return `${roomPrefix}_${String(index + 1).padStart(2, '0')}_${labelPart}_${timestamp}.${getRecordingResultExtension(file)}`;
}

function getRecordingFileType(file: RecordedFile): string {
  return getRecordedFileMimeType(file);
}

function getMediaExportDownloadLabel(artifact: RecordingExportArtifactStatus): string {
  if (artifact.format === 'json') return 'Download Manifest';
  return `Download ${artifact.format.toUpperCase()}`;
}

export function getReadyFinalMp4Artifact(
  exportJob: { artifacts: RecordingExportArtifactStatus[] } | null | undefined
): RecordingExportArtifactStatus | null {
  return exportJob?.artifacts.find((artifact) => artifact.status === 'ready' && artifact.id === 'final-mp4') ||
    exportJob?.artifacts.find((artifact) => artifact.status === 'ready' && artifact.format === 'mp4') ||
    null;
}

export function hasReadyFinalMp4Export(session: Pick<LocalRecordingSession, 'mediaExport'>): boolean {
  return Boolean(getReadyFinalMp4Artifact(session.mediaExport));
}

function getRecordingMediaExportLabel(exportJob: RecordingMediaExportHandoff | undefined): string {
  if (!exportJob) return '';
  const readyMp4 = getReadyFinalMp4Artifact(exportJob);
  const readyCount = exportJob.artifacts.filter((artifact) => artifact.status === 'ready').length;
  if (readyMp4) return `Media export | MP4 ready | ${readyCount} artifact${readyCount === 1 ? '' : 's'}`;
  return `Media export | ${exportJob.status} | ${readyCount} artifact${readyCount === 1 ? '' : 's'} ready`;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let crc = i;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1 ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getZipTimestamp(date: Date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function assertZipLimit(value: number, label: string, limit = ZIP_UINT32_MAX) {
  if (value > limit) {
    throw new Error(`${label} is too large for this browser ZIP export`);
  }
}

function sanitizeFileName(value: string, fallback: string): string {
  const baseName = value.split(/[\\/]/).pop() || fallback;
  const cleaned = baseName
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function sanitizeMarkerLabel(value: string, fallback: string): string {
  const cleaned = value.trim().replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
  return cleaned || fallback;
}

function makeUniqueZipPath(fileName: string, index: number, seenPaths: Set<string>): string {
  const fallback = `track_${index + 1}.webm`;
  const cleaned = sanitizeFileName(fileName, fallback);
  const match = cleaned.match(/^(.*?)(\.[^.]+)?$/);
  const stem = match?.[1] || fallback;
  const extension = match?.[2] || '';
  let candidate = `tracks/${String(index + 1).padStart(2, '0')}_${cleaned}`;
  let suffix = 2;

  while (seenPaths.has(candidate)) {
    candidate = `tracks/${String(index + 1).padStart(2, '0')}_${stem}_${suffix}${extension}`;
    suffix += 1;
  }

  seenPaths.add(candidate);
  return candidate;
}

function makeUniqueAudioStemZipPath(fileName: string, index: number, seenPaths: Set<string>): string {
  const cleaned = sanitizeFileName(fileName.replace(/\.[^.]+$/, ''), `track_${index + 1}_audio`);
  let candidate = `audio-stems/${String(index + 1).padStart(2, '0')}_${cleaned}.wav`;
  let suffix = 2;

  while (seenPaths.has(candidate)) {
    candidate = `audio-stems/${String(index + 1).padStart(2, '0')}_${cleaned}_${suffix}.wav`;
    suffix += 1;
  }

  seenPaths.add(candidate);
  return candidate;
}

function makeUniquePodcastAudioZipPath(fileName: string, index: number, seenPaths: Set<string>): string {
  const fallback = `audio_track_${index + 1}.webm`;
  const cleaned = sanitizeFileName(fileName, fallback);
  const match = cleaned.match(/^(.*?)(\.[^.]+)?$/);
  const stem = match?.[1] || fallback;
  const extension = match?.[2] || '';
  let candidate = `audio-tracks/${String(index + 1).padStart(2, '0')}_${cleaned}`;
  let suffix = 2;

  while (seenPaths.has(candidate)) {
    candidate = `audio-tracks/${String(index + 1).padStart(2, '0')}_${stem}_${suffix}${extension}`;
    suffix += 1;
  }

  seenPaths.add(candidate);
  return candidate;
}

function makeBundleFileName(roomName: string, createdAt: string): string {
  const roomPrefix = sanitizeFileName(roomName, 'studio');
  const timestamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
  return `${roomPrefix}_recording_bundle_${timestamp}.zip`;
}

function makePodcastBundleFileName(roomName: string, createdAt: string): string {
  const roomPrefix = sanitizeFileName(roomName, 'studio');
  const timestamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
  return `${roomPrefix}_podcast_audio_${timestamp}.zip`;
}

function makeDriveRetentionManifestFileName(roomName: string, createdAt: string): string {
  const roomPrefix = sanitizeFileName(roomName, 'studio');
  const timestamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
  return `${roomPrefix}_drive_retention_${timestamp}.json`;
}

export function getRecordingCloudRetentionLabel(cloud: RecordingCloudHandoff | undefined): string {
  if (!cloud) return 'Local only';
  const policy = getRecordingCloudRetentionPolicy(cloud.retentionPolicyId);
  if (cloud.permanent) return policy.label;
  if (cloud.expiresAt) return `Expires ${formatDateTime(cloud.expiresAt)}`;
  return policy.label;
}

export function buildRecordingDriveRetentionManifest(
  source: RecordingBundleSource,
  retention: RecordingDriveRetentionManifest
): string {
  return JSON.stringify({
    app: 'livestream-studio',
    exportType: 'google-drive-retention-policy',
    version: 1,
    roomName: source.roomName,
    sessionId: source.sessionId,
    recordingCreatedAt: source.createdAt,
    uploadedAt: retention.uploadedAt,
    policy: {
      id: retention.policyId,
      label: retention.label,
      permanent: retention.permanent,
      expiresAt: retention.expiresAt,
    },
    review: retention.expiresAt
      ? `Review or remove this Drive handoff after ${retention.expiresAt}.`
      : 'Permanent cloud archive. Keep this Drive handoff until manually removed.',
  }, null, 2);
}

function getRecordingSessionSearchText(session: LocalRecordingSession): string {
  return [
    session.roomName,
    session.createdAt,
    new Date(session.createdAt).toLocaleString(),
    formatDuration(session.durationSeconds),
    session.cloud?.provider || '',
    session.cloud?.folderId || '',
    session.cloud?.webViewLink || '',
    session.cloud?.uploadedAt || '',
    session.cloud?.expiresAt || '',
    session.cloud ? getRecordingCloudRetentionPolicy(session.cloud.retentionPolicyId).label : '',
    session.cloud ? getRecordingCloudRetentionLabel(session.cloud) : '',
    session.mediaExport?.uploadId || '',
    session.mediaExport?.exportId || '',
    session.mediaExport?.status || '',
    session.mediaExport ? getRecordingMediaExportLabel(session.mediaExport) : '',
    ...(session.mediaExport?.artifacts || []).flatMap((artifact) => [
      artifact.id,
      artifact.label,
      artifact.format,
      artifact.status,
      artifact.storage?.provider || '',
      artifact.storage?.bucket || '',
      artifact.storage?.key || '',
      artifact.storage?.url || '',
    ]),
    ...session.files.flatMap((file) => [
      file.label,
      file.fileName,
      file.kind || '',
      file.type,
    ]),
    ...(session.markers || []).flatMap((marker) => [
      marker.label,
      formatDuration(marker.seconds),
    ]),
  ].join(' ').toLowerCase();
}

function sessionMatchesRecordingFilter(session: LocalRecordingSession, filter: RecordingLibraryFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'markers') return Boolean(session.markers?.length);
  if (filter === 'cloud') return Boolean(session.cloud);
  if (filter === 'mp4') return hasReadyFinalMp4Export(session);
  if (filter === 'video') return session.files.some((file) => file.kind === 'video' || file.kind === 'program' || file.kind === 'iso');
  return session.files.some((file) => file.kind === filter);
}

function sessionHasPodcastAudio(session: LocalRecordingSession): boolean {
  return session.files.some((file) => file.kind === 'audio' || file.type.startsWith('audio/'));
}

function mapRecordingLibraryFiles(files: LocalRecordingFileRecord[]): RecordedFile[] {
  return files.map((file) => ({
    label: file.label,
    blob: file.blob,
    fileName: file.fileName,
    kind: file.kind,
    capture: file.capture,
  }));
}

export function filterRecordingLibrarySessions(
  sessions: LocalRecordingSession[],
  query: string,
  filter: RecordingLibraryFilter
): LocalRecordingSession[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((session) => {
    if (!sessionMatchesRecordingFilter(session, filter)) return false;
    if (terms.length === 0) return true;
    const searchText = getRecordingSessionSearchText(session);
    return terms.every((term) => searchText.includes(term));
  });
}

export function buildRecordingLibraryDashboardSummary(
  sessions: LocalRecordingSession[],
  visibleSessions: LocalRecordingSession[] = sessions
): RecordingLibraryDashboardSummary {
  const latestSession = sessions.reduce<LocalRecordingSession | null>((latest, session) => {
    if (!latest) return session;
    return Date.parse(session.createdAt) > Date.parse(latest.createdAt) ? session : latest;
  }, null);

  return {
    totalSessions: sessions.length,
    visibleSessions: visibleSessions.length,
    totalTracks: sessions.reduce((total, session) => total + session.trackCount, 0),
    totalBytes: sessions.reduce((total, session) => total + session.totalBytes, 0),
    totalDurationSeconds: Math.round(sessions.reduce((total, session) => {
      if (!Number.isFinite(session.durationSeconds)) return total;
      return total + Math.max(0, Number(session.durationSeconds));
    }, 0)),
    markerCount: sessions.reduce((total, session) => total + (session.markers?.length || 0), 0),
    cloudSessionCount: sessions.reduce((total, session) => total + (session.cloud ? 1 : 0), 0),
    mediaExportSessionCount: sessions.reduce((total, session) => total + (session.mediaExport ? 1 : 0), 0),
    readyMp4ExportSessionCount: sessions.reduce((total, session) => total + (hasReadyFinalMp4Export(session) ? 1 : 0), 0),
    expiringCloudSessionCount: sessions.reduce((total, session) => total + (session.cloud && !session.cloud.permanent ? 1 : 0), 0),
    permanentCloudSessionCount: sessions.reduce((total, session) => total + (session.cloud?.permanent ? 1 : 0), 0),
    latestSession: latestSession
      ? {
          id: latestSession.id,
          roomName: latestSession.roomName,
          createdAt: latestSession.createdAt,
        }
      : null,
  };
}

export function encodePcm16Wav(channels: Float32Array[], sampleRate: number): Blob {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('A valid sample rate is required for WAV export');
  }

  const channelCount = Math.max(1, channels.length);
  const frameCount = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel]?.[frame] || 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

type BrowserAudioContextConstructor = new (contextOptions?: AudioContextOptions) => AudioContext;

function getAudioContextConstructor(): BrowserAudioContextConstructor | null {
  const globalWithWebkit = globalThis as typeof globalThis & {
    webkitAudioContext?: BrowserAudioContextConstructor;
  };
  return globalWithWebkit.AudioContext || globalWithWebkit.webkitAudioContext || null;
}

function isAudioStemCandidate(file: RecordingBundleFile): boolean {
  return file.kind === 'audio' || file.type.startsWith('audio/');
}

function isPodcastAudioFile(file: RecordedFile): boolean {
  return file.kind === 'audio' || getRecordingFileType(file).startsWith('audio/');
}

async function createWavAudioStem(
  file: RecordedFile,
  manifestFile: RecordingBundleFile,
  trackIndex: number,
  seenPaths: Set<string>
): Promise<{ entry: ZipEntry; file: RecordingAudioStemFile } | null> {
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) return null;

  let audioContext: AudioContext | null = null;
  try {
    audioContext = new AudioContextConstructor();
    const sourceBuffer = await file.blob.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(sourceBuffer.slice(0));
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
    const stemBlob = encodePcm16Wav(channels, decoded.sampleRate);
    const zipPath = makeUniqueAudioStemZipPath(file.fileName, trackIndex, seenPaths);
    return {
      entry: {
        path: zipPath,
        blob: stemBlob,
      },
      file: {
        label: `${file.label} WAV stem`,
        format: 'wav',
        zipPath,
        size: stemBlob.size,
        type: stemBlob.type,
        sourceTrackIndex: trackIndex + 1,
        sourceZipPath: manifestFile.zipPath,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        bitDepth: 16,
        encoding: 'pcm_s16le',
      },
    };
  } catch (err) {
    console.warn(`Could not create WAV stem for ${file.label}`, err);
    return null;
  } finally {
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close().catch(() => {});
    }
  }
}

async function buildWavAudioStems(
  trackEntries: Array<{ path: string; blob: Blob; file: RecordedFile }>,
  manifestFiles: RecordingBundleFile[],
  seenPaths: Set<string>
): Promise<AudioStemBuildResult> {
  const entries: ZipEntry[] = [];
  const files: RecordingAudioStemFile[] = [];
  let skippedCount = 0;
  let candidateCount = 0;

  for (let index = 0; index < manifestFiles.length; index++) {
    const manifestFile = manifestFiles[index];
    if (!isAudioStemCandidate(manifestFile)) continue;
    candidateCount += 1;
    const stem = await createWavAudioStem(trackEntries[index].file, manifestFile, index, seenPaths);
    if (!stem) {
      skippedCount += 1;
      continue;
    }
    entries.push(stem.entry);
    files.push(stem.file);
  }

  return { entries, files, skippedCount, candidateCount };
}

function getFinalCaptionSegments(segments: LiveCaptionSegment[] | undefined): LiveCaptionSegment[] {
  return (segments || [])
    .filter((segment) => !segment.interim && segment.text.trim())
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function getCaptionLanguageLabel(language: string | undefined): string {
  const labels: Record<string, string> = {
    'en-US': 'English US',
    'en-GB': 'English UK',
    'es-ES': 'Spanish',
    'fr-FR': 'French',
    'de-DE': 'German',
    'ja-JP': 'Japanese',
    'ko-KR': 'Korean',
    'fil-PH': 'Filipino',
  };
  return language ? labels[language] || language : 'Unknown';
}

function buildPlainCaptionTranscript(source: RecordingBundleSource, segments: LiveCaptionSegment[]): string {
  const lines = [
    'LiveStream Studio Captions',
    `Room: ${source.roomName}`,
    `Language: ${getCaptionLanguageLabel(source.captionLanguage)}`,
    `Exported with recording bundle: ${new Date().toISOString()}`,
    '',
  ];

  for (const segment of segments) {
    const timestamp = new Date(segment.timestamp);
    const time = Number.isNaN(timestamp.getTime()) ? '' : timestamp.toLocaleString();
    lines.push(`[${time}] ${segment.speakerName}`);
    lines.push(segment.text.trim());
    lines.push('');
  }

  return lines.join('\n');
}

function formatVttTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function sanitizeVttText(value: string): string {
  return value.replace(/-->/g, '->').replace(/[<>]/g, '');
}

function buildCaptionWebVtt(source: RecordingBundleSource, segments: LiveCaptionSegment[]): string {
  const firstTime = Date.parse(segments[0]?.timestamp || '');
  const origin = Number.isFinite(firstTime) ? firstTime : Date.now();
  const lines = [
    'WEBVTT',
    `NOTE Room: ${source.roomName}`,
    `NOTE Language: ${getCaptionLanguageLabel(source.captionLanguage)}`,
    '',
  ];

  segments.forEach((segment, index) => {
    const startTime = Date.parse(segment.timestamp);
    const nextTime = Date.parse(segments[index + 1]?.timestamp || '');
    const start = Number.isFinite(startTime) ? startTime - origin : index * 3500;
    const end = Number.isFinite(nextTime)
      ? Math.max(start + 1200, nextTime - origin)
      : start + Math.max(2500, Math.min(6000, segment.text.length * 65));

    lines.push(String(index + 1));
    lines.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`);
    lines.push(`<v ${sanitizeVttText(segment.speakerName)}>${sanitizeVttText(segment.text.trim())}`);
    lines.push('');
  });

  return lines.join('\n');
}

export function buildGeneratedRecordingTranscriptText(
  source: RecordingBundleSource,
  transcript: RecordingTranscriptionResult
): string {
  return [
    'LiveStream Studio Generated Transcript',
    `Room: ${source.roomName}`,
    `Source: ${transcript.sourceLabel} (${transcript.sourceFileName})`,
    `Model: ${transcript.model}`,
    `Language: ${transcript.language || getCaptionLanguageLabel(source.captionLanguage)}`,
    `Generated: ${transcript.createdAt}`,
    '',
    transcript.text.trim(),
    '',
  ].join('\n');
}

function getSortedRecordingMarkers(markers: RecordingMarker[] | undefined): RecordingMarker[] {
  return (markers || [])
    .filter((marker) => Number.isFinite(marker.seconds) && marker.seconds >= 0 && marker.label.trim())
    .slice()
    .sort((a, b) => a.seconds - b.seconds || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function buildRecordingMarkersJson(source: RecordingBundleSource, markers: RecordingMarker[]): string {
  return JSON.stringify({
    app: 'livestream-studio',
    exportType: 'recording-markers',
    version: 1,
    roomName: source.roomName,
    sessionId: source.sessionId,
    exportedAt: new Date().toISOString(),
    markers: markers.map((marker, index) => ({
      index: index + 1,
      label: marker.label,
      seconds: marker.seconds,
      timecode: formatDuration(marker.seconds),
      createdAt: marker.createdAt,
    })),
  }, null, 2);
}

function csvEscape(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatIsoTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString();
}

function getRecordingLibraryMarkerSummary(session: LocalRecordingSession): string {
  return getSortedRecordingMarkers(session.markers || [])
    .map((marker) => `${formatDuration(marker.seconds)} ${marker.label}`)
    .join('; ');
}

export function buildRecordingLibraryCatalogCsv(sessions: LocalRecordingSession[]): string {
  const header = [
    'sessionId',
    'roomName',
    'createdAt',
    'durationTimecode',
    'durationSeconds',
    'trackCount',
    'totalBytes',
    'markerCount',
    'markers',
    'cloudProvider',
    'cloudFolderId',
    'cloudShareLink',
    'cloudUploadedAt',
    'cloudRetentionPolicy',
    'cloudExpiresAt',
    'cloudPermanent',
    'mediaExportStatus',
    'mediaUploadId',
    'mediaExportId',
    'mediaMp4Ready',
    'mediaArtifactCount',
    'trackIndex',
    'trackLabel',
    'trackKind',
    'fileName',
    'mimeType',
    'sizeBytes',
  ];
  const rows = sessions.flatMap((session) => {
    const markers = session.markers || [];
    const base = [
      session.id,
      session.roomName,
      formatIsoTimestamp(session.createdAt),
      formatDuration(session.durationSeconds),
      session.durationSeconds ?? '',
      session.trackCount,
      session.totalBytes,
      markers.length,
      getRecordingLibraryMarkerSummary(session),
      session.cloud?.provider || '',
      session.cloud?.folderId || '',
      session.cloud?.webViewLink || '',
      session.cloud?.uploadedAt ? formatIsoTimestamp(session.cloud.uploadedAt) : '',
      session.cloud ? getRecordingCloudRetentionPolicy(session.cloud.retentionPolicyId).label : '',
      session.cloud?.expiresAt ? formatIsoTimestamp(session.cloud.expiresAt) : '',
      session.cloud ? String(session.cloud.permanent) : '',
      session.mediaExport?.status || '',
      session.mediaExport?.uploadId || '',
      session.mediaExport?.exportId || '',
      String(hasReadyFinalMp4Export(session)),
      session.mediaExport?.artifacts.length || '',
    ];
    if (session.files.length === 0) return [[...base, '', '', '', '', '', '']];
    return session.files.map((file, index) => [
      ...base,
      index + 1,
      file.label,
      file.kind || '',
      file.fileName,
      file.type,
      file.size,
    ]);
  });

  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

export function buildRecordingLibraryCatalogFilename(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  return `studio_recording_library_${stamp}.csv`;
}

function xmlEscape(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatFcpxDuration(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds) || Number(seconds) <= 0) return '1/30s';
  const frames = Math.max(1, Math.round(Number(seconds) * 30));
  return `${frames}/30s`;
}

function getTimelineFrameCount(seconds: number | null | undefined): number {
  if (!Number.isFinite(seconds) || Number(seconds) <= 0) return 1;
  return Math.max(1, Math.round(Number(seconds) * 30));
}

export function buildRecordingMarkersCsv(markers: RecordingMarker[]): string {
  const rows = [
    ['index', 'timecode', 'seconds', 'label', 'createdAt'],
    ...markers.map((marker, index) => [
      index + 1,
      formatDuration(marker.seconds),
      marker.seconds,
      marker.label,
      marker.createdAt,
    ]),
  ];
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (char === '\r' && next === '\n') index += 1;
    } else {
      cell += char;
    }
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((candidate) => candidate.some((value) => value.trim()));
}

function normalizeCsvHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseMarkerSeconds(secondsValue: string | undefined, timecodeValue: string | undefined): number | null {
  const trimmedSeconds = secondsValue?.trim();
  if (trimmedSeconds) {
    const parsedSeconds = Number(trimmedSeconds);
    if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) return Math.floor(parsedSeconds);
  }
  if (!timecodeValue) return null;
  return parseDurationSeconds(timecodeValue.trim());
}

export function parseRecordingMarkersCsv(text: string, importedAt = new Date().toISOString()): {
  markers: RecordingMarker[];
  skippedRows: number;
} {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { markers: [], skippedRows: 0 };

  const headers = rows[0].map(normalizeCsvHeader);
  const hasHeader = headers.some((header) => ['timecode', 'seconds', 'label', 'createdat'].includes(header));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const columnIndex = (name: string, fallback: number) => {
    const index = headers.indexOf(name);
    return index >= 0 ? index : fallback;
  };
  const timecodeIndex = hasHeader ? columnIndex('timecode', 1) : 1;
  const secondsIndex = hasHeader ? columnIndex('seconds', 2) : 2;
  const labelIndex = hasHeader ? columnIndex('label', 3) : 3;
  const createdAtIndex = hasHeader ? columnIndex('createdat', 4) : 4;
  const markers: RecordingMarker[] = [];
  let skippedRows = 0;

  for (const row of dataRows) {
    if (markers.length >= MAX_MARKER_IMPORT_ROWS) {
      skippedRows += 1;
      continue;
    }
    const seconds = parseMarkerSeconds(row[secondsIndex], row[timecodeIndex]);
    if (seconds === null || seconds < 0) {
      skippedRows += 1;
      continue;
    }
    const createdAt = Number.isFinite(Date.parse(row[createdAtIndex] || '')) ? row[createdAtIndex] : importedAt;
    markers.push({
      id: `marker-import-${importedAt.replace(/[^a-zA-Z0-9]/g, '')}-${markers.length + 1}`,
      label: sanitizeMarkerLabel(row[labelIndex] || '', `Marker ${markers.length + 1}`),
      seconds,
      createdAt,
    });
  }

  return { markers: getSortedRecordingMarkers(markers), skippedRows };
}

function inferEditorTrackKind(file: RecordingBundleFile): 'audio' | 'video' | 'screen' {
  if (file.kind === 'program' || file.kind === 'iso') return 'video';
  const label = file.label.toLowerCase();
  const fileName = file.fileName.toLowerCase();
  if (label.includes('screen') || fileName.includes('screen')) return 'screen';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'video';
}

function createEditorTimeline(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  audioStemFiles: RecordingAudioStemFile[],
  markers: RecordingMarker[],
  exportedAt: string
) {
  const audioStemBySourcePath = new Map(audioStemFiles.map((file) => [file.sourceZipPath, file]));
  return {
    app: 'livestream-studio',
    exportType: 'editor-timeline',
    version: 1,
    exportedAt,
    session: {
      id: source.sessionId,
      roomName: source.roomName,
      createdAt: source.createdAt,
      durationSeconds: source.durationSeconds,
      timebase: {
        frameRate: 30,
        dropFrame: false,
      },
    },
    tracks: files.map((file, index) => {
      const kind = inferEditorTrackKind(file);
      const audioStem = audioStemBySourcePath.get(file.zipPath);
      return {
        trackIndex: index + 1,
        lane: index + 1,
        role: kind,
        kind,
        label: file.label,
        source: {
          zipPath: file.zipPath,
          fileName: file.fileName,
          type: file.type,
          size: file.size,
          capture: file.capture || null,
        },
        audioStem: audioStem ? {
          zipPath: audioStem.zipPath,
          type: audioStem.type,
          sampleRate: audioStem.sampleRate,
          channels: audioStem.channels,
          bitDepth: audioStem.bitDepth,
          encoding: audioStem.encoding,
        } : null,
        timeline: {
          startSeconds: 0,
          durationSeconds: source.durationSeconds,
          startTimecode: '0:00',
          durationTimecode: formatDuration(source.durationSeconds),
        },
      };
    }),
    markers: markers.map((marker, index) => ({
      index: index + 1,
      label: marker.label,
      seconds: marker.seconds,
      timecode: formatDuration(marker.seconds),
      createdAt: marker.createdAt,
    })),
  };
}

function buildEditorTimelineCsv(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  audioStemFiles: RecordingAudioStemFile[]
): string {
  const audioStemBySourcePath = new Map(audioStemFiles.map((file) => [file.sourceZipPath, file]));
  const rows = [
    [
      'trackIndex',
      'lane',
      'role',
      'kind',
      'label',
      'startTimecode',
      'startSeconds',
      'durationTimecode',
      'durationSeconds',
      'sourcePath',
      'wavStemPath',
      'fileName',
      'mimeType',
      'sizeBytes',
    ],
    ...files.map((file, index) => {
      const kind = inferEditorTrackKind(file);
      return [
        index + 1,
        index + 1,
        kind,
        kind,
        file.label,
        '0:00',
        0,
        formatDuration(source.durationSeconds),
        source.durationSeconds,
        file.zipPath,
        audioStemBySourcePath.get(file.zipPath)?.zipPath || '',
        file.fileName,
        file.type,
        file.size,
      ];
    }),
  ];
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

export function buildFinalCutProXml(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  audioStemFiles: RecordingAudioStemFile[],
  markers: RecordingMarker[]
): string {
  const duration = formatFcpxDuration(source.durationSeconds);
  const projectName = source.roomName || 'LiveStream Studio Recording';
  const audioStemBySourcePath = new Map(audioStemFiles.map((file) => [file.sourceZipPath, file]));
  const fileAssets = files.map((file, index) => ({
    id: `asset${index + 1}`,
    name: file.label || file.fileName,
    src: `../${file.zipPath}`,
    kind: inferEditorTrackKind(file),
  }));
  const stemAssets = files
    .map((file, index) => {
      const stem = audioStemBySourcePath.get(file.zipPath);
      if (!stem) return null;
      return {
        id: `stem${index + 1}`,
        name: stem.label,
        src: `../${stem.zipPath}`,
        kind: 'audio' as const,
      };
    })
    .filter((asset): asset is { id: string; name: string; src: string; kind: 'audio' } => Boolean(asset));
  const assets = [...fileAssets, ...stemAssets];
  const markerLines = getSortedRecordingMarkers(markers).map((marker) => (
    `            <marker start="${formatFcpxDuration(marker.seconds)}" duration="1/30s" value="${xmlEscape(marker.label)}"/>`
  ));
  const assetResourceLines = assets.map((asset) => (
    `    <asset id="${asset.id}" name="${xmlEscape(asset.name)}" src="${xmlEscape(asset.src)}" start="0s" duration="${duration}" hasVideo="${asset.kind === 'audio' ? '0' : '1'}" hasAudio="1"/>`
  ));
  const clipLines = assets.map((asset, index) => {
    const lane = index === 0 ? '' : ` lane="${index}"`;
    const audioRole = asset.kind === 'audio' ? ' audioRole="dialogue"' : '';
    return `          <asset-clip name="${xmlEscape(asset.name)}" ref="${asset.id}" offset="0s" start="0s" duration="${duration}"${lane}${audioRole}/>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    '    <format id="fmt30" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080"/>',
    ...assetResourceLines,
    '  </resources>',
    '  <library>',
    `    <event name="${xmlEscape(projectName)}">`,
    `      <project name="${xmlEscape(projectName)}">`,
    `        <sequence duration="${duration}" format="fmt30" tcStart="0s" tcFormat="NDF">`,
    '          <spine>',
    ...clipLines,
    ...markerLines,
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

export function buildPremiereProXml(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  audioStemFiles: RecordingAudioStemFile[],
  markers: RecordingMarker[]
): string {
  const durationFrames = getTimelineFrameCount(source.durationSeconds);
  const projectName = source.roomName || 'LiveStream Studio Recording';
  const audioStemBySourcePath = new Map(audioStemFiles.map((file) => [file.sourceZipPath, file]));
  const sequenceTracks = files.map((file, index) => {
    const kind = inferEditorTrackKind(file);
    const audioStem = audioStemBySourcePath.get(file.zipPath);
    return {
      id: `clip-${index + 1}`,
      fileId: `file-${index + 1}`,
      kind,
      label: file.label || file.fileName,
      zipPath: file.zipPath,
      fileName: file.fileName,
      type: file.type,
      durationFrames,
      audioStem,
    };
  });
  const markerLines = getSortedRecordingMarkers(markers).map((marker) => (
    [
      '        <marker>',
      `          <name>${xmlEscape(marker.label)}</name>`,
      `          <comment>${xmlEscape(formatDuration(marker.seconds))}</comment>`,
      `          <in>${getTimelineFrameCount(marker.seconds)}</in>`,
      `          <out>${getTimelineFrameCount(marker.seconds) + 1}</out>`,
      '        </marker>',
    ].join('\n')
  ));
  const fileLines = sequenceTracks.map((track) => (
    [
      `              <file id="${track.fileId}">`,
      `                <name>${xmlEscape(track.fileName)}</name>`,
      `                <pathurl>${xmlEscape(`../${track.zipPath}`)}</pathurl>`,
      `                <duration>${track.durationFrames}</duration>`,
      '                <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>',
      '                <media>',
      track.kind === 'audio'
        ? '                  <audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>1</channelcount></audio>'
        : '                  <video><samplecharacteristics><width>1920</width><height>1080</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>',
      '                </media>',
      '              </file>',
    ].join('\n')
  ));
  const videoClipLines = sequenceTracks
    .filter((track) => track.kind !== 'audio')
    .map((track, index) => (
      [
        `            <clipitem id="${track.id}">`,
        `              <name>${xmlEscape(track.label)}</name>`,
        `              <start>0</start><end>${track.durationFrames}</end><in>0</in><out>${track.durationFrames}</out>`,
        `              <enabled>TRUE</enabled>`,
        `              <file id="${track.fileId}"/>`,
        '            </clipitem>',
      ].join('\n')
    ));
  const audioClipLines = [
    ...sequenceTracks
      .filter((track) => track.kind === 'audio')
      .map((track) => ({
        id: track.id,
        fileId: track.fileId,
        label: track.label,
        durationFrames: track.durationFrames,
      })),
    ...sequenceTracks
      .filter((track) => track.audioStem)
      .map((track, index) => ({
        id: `stem-clip-${index + 1}`,
        fileId: `stem-file-${index + 1}`,
        label: track.audioStem?.label || `${track.label} WAV stem`,
        durationFrames: track.durationFrames,
        zipPath: track.audioStem?.zipPath || '',
        fileName: track.audioStem?.zipPath.split('/').pop() || '',
      })),
  ].map((track) => (
    [
      `            <clipitem id="${track.id}">`,
      `              <name>${xmlEscape(track.label)}</name>`,
      `              <start>0</start><end>${track.durationFrames}</end><in>0</in><out>${track.durationFrames}</out>`,
      '              <enabled>TRUE</enabled>',
      `              <file id="${track.fileId}"/>`,
      '            </clipitem>',
    ].join('\n')
  ));
  const stemFileLines = sequenceTracks
    .filter((track) => track.audioStem)
    .map((track, index) => {
      const stem = track.audioStem as RecordingAudioStemFile;
      return [
        `              <file id="stem-file-${index + 1}">`,
        `                <name>${xmlEscape(stem.zipPath.split('/').pop() || stem.label)}</name>`,
        `                <pathurl>${xmlEscape(`../${stem.zipPath}`)}</pathurl>`,
        `                <duration>${track.durationFrames}</duration>`,
        '                <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>',
        '                <media>',
        `                  <audio><samplecharacteristics><depth>${stem.bitDepth}</depth><samplerate>${stem.sampleRate}</samplerate></samplecharacteristics><channelcount>${stem.channels}</channelcount></audio>`,
        '                </media>',
        '              </file>',
      ].join('\n');
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="5">',
    `  <sequence id="sequence-1">`,
    `    <name>${xmlEscape(projectName)}</name>`,
    `    <duration>${durationFrames}</duration>`,
    '    <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>',
    '    <media>',
    '      <video>',
    '        <format><samplecharacteristics><width>1920</width><height>1080</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>',
    '        <track>',
    ...videoClipLines,
    '        </track>',
    '      </video>',
    '      <audio>',
    '        <track>',
    ...audioClipLines,
    '        </track>',
    '      </audio>',
    '    </media>',
    ...markerLines,
    '    <files>',
    ...fileLines,
    ...stemFileLines,
    '    </files>',
    '  </sequence>',
    '</xmeml>',
    '',
  ].join('\n');
}

export function buildDaVinciResolveXml(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  audioStemFiles: RecordingAudioStemFile[],
  markers: RecordingMarker[]
): string {
  const projectName = source.roomName || 'LiveStream Studio Recording';
  return buildPremiereProXml(source, files, audioStemFiles, markers)
    .replace(
      '<!DOCTYPE xmeml>',
      '<!DOCTYPE xmeml>\n<!-- DaVinci Resolve timeline XML generated by LiveStream Studio. Import with File > Import > Timeline. -->'
    )
    .replace(
      `<name>${xmlEscape(projectName)}</name>`,
      `<name>${xmlEscape(`${projectName} - DaVinci Resolve`)}</name>`
    );
}

function buildEditorReadme(source: RecordingBundleSource): string {
  return [
    'LiveStream Studio Editor Export',
    '',
    `Room: ${source.roomName}`,
    `Created: ${source.createdAt}`,
    `Duration: ${formatDuration(source.durationSeconds)}`,
    '',
    'Files:',
    '- tracks/: isolated local recording tracks',
    '- audio-stems/: PCM WAV audio stems generated from audio-only tracks when supported',
    '- editor/local_recording_timeline.json: structured timeline metadata',
    '- editor/local_recording_timeline.csv: spreadsheet/editor-friendly track layout',
    '- editor/local_recording_timeline.fcpxml: Final Cut Pro XML project starter',
    '- editor/premiere_pro_sequence.xml: Adobe Premiere Pro XML sequence starter',
    '- editor/davinci_resolve_timeline.xml: DaVinci Resolve XML timeline starter',
    '- markers/: recording markers when present',
    '- captions/: live caption and generated transcript sidecars when present',
    '',
    'Import the FCPXML into Final Cut Pro, the Premiere XML into Adobe Premiere Pro, the Resolve XML with File > Import > Timeline in DaVinci Resolve, or place each track at 0:00 in another editor and use the timeline CSV/JSON plus marker files as the sync map.',
  ].join('\n');
}

function buildPodcastReadme(source: RecordingBundleSource): string {
  return [
    'LiveStream Studio Podcast Audio Export',
    '',
    `Room: ${source.roomName}`,
    `Created: ${source.createdAt}`,
    `Duration: ${formatDuration(source.durationSeconds)}`,
    '',
    'Files:',
    '- audio-tracks/: original isolated audio-only recording tracks',
    '- audio-stems/: PCM WAV stems generated from audio tracks when supported',
    '- markers/: recording markers when present',
    '- captions/: live caption and generated transcript sidecars when present',
    '',
    'Use this ZIP for podcast editing workflows where video and screen tracks are not needed. Import the audio tracks or WAV stems into your editor at 0:00, then use markers and caption sidecars for show notes and clip points.',
  ].join('\n');
}

function getFileHasAudio(file: RecordingBundleFile): boolean {
  return file.type.startsWith('audio/') || Boolean(file.capture?.tracks.some((track) => track.kind === 'audio'));
}

function getFileHasVideo(file: RecordingBundleFile): boolean {
  return file.type.startsWith('video/') || file.kind === 'video' || file.kind === 'screen' || file.kind === 'program' || file.kind === 'iso' || Boolean(file.capture?.tracks.some((track) => track.kind === 'video'));
}

function getCaptureDurationSeconds(file: RecordingBundleFile): number | null {
  if (!Number.isFinite(file.capture?.durationMs)) return null;
  return Number(((file.capture?.durationMs || 0) / 1000).toFixed(3));
}

function getDurationDeltaSeconds(sourceDuration: number | null, captureDuration: number | null): number | null {
  if (!Number.isFinite(sourceDuration) || captureDuration === null) return null;
  return Number(Math.abs((sourceDuration || 0) - captureDuration).toFixed(3));
}

function createRecordingQualityReport(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  exportedAt: string,
  audioStemFiles: RecordingAudioStemFile[],
  skippedAudioStemCount: number,
  audioStemCandidateCount: number
): RecordingQualityReport {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const safeSessionDuration = Number.isFinite(source.durationSeconds) ? Math.max(0, Number(source.durationSeconds)) : null;
  const tracks = files.map((file, index): RecordingQualityTrackReport => {
    const captureDurationSeconds = getCaptureDurationSeconds(file);
    const durationDeltaSeconds = getDurationDeltaSeconds(safeSessionDuration, captureDurationSeconds);
    const hasAudio = getFileHasAudio(file);
    const hasVideo = getFileHasVideo(file);
    const issues: string[] = [];

    if (file.size <= 0) issues.push('Track file is empty.');
    if (!file.capture) issues.push('Capture metadata is missing.');
    if (!hasAudio && !hasVideo) issues.push('Track does not advertise audio or video media.');
    if (durationDeltaSeconds !== null && durationDeltaSeconds > 2) {
      issues.push(`Track duration differs from session by ${durationDeltaSeconds.toFixed(3)} seconds.`);
    }

    return {
      trackIndex: index + 1,
      label: file.label,
      kind: file.kind || inferEditorTrackKind(file),
      zipPath: file.zipPath,
      size: file.size,
      type: file.type,
      captureDurationSeconds,
      durationDeltaSeconds,
      hasCaptureMetadata: Boolean(file.capture),
      hasAudio,
      hasVideo,
      issues,
    };
  });

  const issues = tracks.flatMap((track) => track.issues.map((issue) => `${track.label}: ${issue}`));
  const hasAudioTrack = tracks.some((track) => track.hasAudio);
  const hasVideoTrack = tracks.some((track) => track.hasVideo);
  if (!hasAudioTrack) issues.push('No audio track was included in this export.');
  if (!hasVideoTrack && files.some((file) => file.kind !== 'audio')) issues.push('No video track was included in this export.');
  if (audioStemCandidateCount > 0 && skippedAudioStemCount > 0) {
    issues.push(`${skippedAudioStemCount} of ${audioStemCandidateCount} audio stem candidate${audioStemCandidateCount === 1 ? '' : 's'} could not be converted to WAV in this browser.`);
  }

  return {
    app: 'livestream-studio',
    exportType: 'recording-quality-report',
    version: 1,
    exportedAt,
    status: issues.length > 0 ? 'review' : 'ready',
    session: {
      id: source.sessionId,
      roomName: source.roomName,
      createdAt: source.createdAt,
      durationSeconds: safeSessionDuration,
      trackCount: files.length,
      totalBytes,
    },
    checks: {
      hasAudioTrack,
      hasVideoTrack,
      hasProgramMix: files.some((file) => file.kind === 'program'),
      hasIsoTracks: files.some((file) => file.kind === 'iso'),
      audioStemCandidateCount,
      audioStemGeneratedCount: audioStemFiles.length,
      audioStemSkippedCount: skippedAudioStemCount,
    },
    tracks,
    issues,
  };
}

function buildRecordingQualityReportText(report: RecordingQualityReport): string {
  const lines = [
    'LiveStream Studio Recording Quality Report',
    '',
    `Status: ${report.status.toUpperCase()}`,
    `Room: ${report.session.roomName}`,
    `Created: ${report.session.createdAt}`,
    `Duration: ${formatDuration(report.session.durationSeconds)}`,
    `Tracks: ${report.session.trackCount}`,
    `Total size: ${formatFileSize(report.session.totalBytes)}`,
    '',
    'Checks:',
    `- Audio track: ${report.checks.hasAudioTrack ? 'yes' : 'no'}`,
    `- Video track: ${report.checks.hasVideoTrack ? 'yes' : 'no'}`,
    `- Program mix: ${report.checks.hasProgramMix ? 'yes' : 'no'}`,
    `- ISO tracks: ${report.checks.hasIsoTracks ? 'yes' : 'no'}`,
    `- WAV stems: ${report.checks.audioStemGeneratedCount}/${report.checks.audioStemCandidateCount} generated, ${report.checks.audioStemSkippedCount} skipped`,
    '',
    'Track review:',
  ];

  for (const track of report.tracks) {
    lines.push(`- ${track.trackIndex}. ${track.label} (${track.kind})`);
    lines.push(`  Path: ${track.zipPath}`);
    lines.push(`  Media: ${track.hasAudio ? 'audio' : 'no audio'} / ${track.hasVideo ? 'video' : 'no video'}`);
    lines.push(`  Capture metadata: ${track.hasCaptureMetadata ? 'yes' : 'no'}`);
    if (track.captureDurationSeconds !== null) lines.push(`  Capture duration: ${formatDuration(track.captureDurationSeconds)}`);
    if (track.durationDeltaSeconds !== null) lines.push(`  Duration delta: ${track.durationDeltaSeconds.toFixed(3)}s`);
    if (track.issues.length > 0) {
      for (const issue of track.issues) lines.push(`  Issue: ${issue}`);
    }
  }

  if (report.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of report.issues) lines.push(`- ${issue}`);
  } else {
    lines.push('', 'No quality issues detected by this browser-side export check.');
  }

  return `${lines.join('\n')}\n`;
}

function buildRecordingQualityEntries(report: RecordingQualityReport) {
  const json = JSON.stringify(report, null, 2);
  const text = buildRecordingQualityReportText(report);
  return [
    {
      path: 'quality/recording_quality_report.json',
      blob: new Blob([json], { type: 'application/json' }),
      label: 'Recording quality report JSON',
      format: 'json' as const,
    },
    {
      path: 'quality/recording_quality_report.txt',
      blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
      label: 'Recording quality report text',
      format: 'txt' as const,
    },
  ];
}

function createRecordingManifest(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  exportedAt: string,
  captionFiles: RecordingCaptionFile[],
  markerFiles: RecordingMarkerFile[],
  editorFiles: RecordingEditorFile[],
  qualityFiles: RecordingQualityFile[],
  audioStemFiles: RecordingAudioStemFile[],
  skippedAudioStemCount: number,
  audioStemCandidateCount: number
) {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const finalCaptionSegments = getFinalCaptionSegments(source.captionSegments);
  const generatedTranscript = source.generatedTranscript?.text.trim() ? source.generatedTranscript : null;
  const markers = getSortedRecordingMarkers(source.markers);
  return {
    app: 'livestream-studio',
    exportType: 'local-recording-bundle',
    version: 1,
    exportedAt,
    session: {
      id: source.sessionId,
      roomName: source.roomName,
      createdAt: source.createdAt,
      durationSeconds: source.durationSeconds,
      trackCount: files.length,
      totalBytes,
    },
    files: files.map((file, index) => ({
      trackIndex: index + 1,
      label: file.label,
      fileName: file.fileName,
      zipPath: file.zipPath,
      size: file.size,
      type: file.type,
      kind: file.kind || inferEditorTrackKind(file),
      ...(file.capture ? { capture: file.capture } : {}),
    })),
    ...(audioStemCandidateCount > 0
      ? {
          audioStems: {
            format: 'wav',
            encoding: 'pcm_s16le',
            bitDepth: 16,
            generatedCount: audioStemFiles.length,
            skippedCount: skippedAudioStemCount,
            files: audioStemFiles,
          },
        }
      : {}),
    editor: {
      timelineVersion: 1,
      files: editorFiles,
    },
    quality: {
      reportVersion: 1,
      files: qualityFiles,
    },
    ...(captionFiles.length > 0
      ? {
          captions: {
            language: source.captionLanguage || null,
            languageLabel: getCaptionLanguageLabel(source.captionLanguage),
            segmentCount: finalCaptionSegments.length,
            ...(generatedTranscript
              ? {
                  generatedTranscript: {
                    model: generatedTranscript.model,
                    sourceFileName: generatedTranscript.sourceFileName,
                    sourceLabel: generatedTranscript.sourceLabel,
                    createdAt: generatedTranscript.createdAt,
                    language: generatedTranscript.language || null,
                  },
                }
              : {}),
            files: captionFiles,
          },
        }
      : {}),
    ...(markers.length > 0
      ? {
          markers: {
            markerCount: markers.length,
            files: markerFiles,
          },
        }
      : {}),
  };
}

function createPodcastManifest(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  exportedAt: string,
  captionFiles: RecordingCaptionFile[],
  markerFiles: RecordingMarkerFile[],
  qualityFiles: RecordingQualityFile[],
  audioStemFiles: RecordingAudioStemFile[],
  skippedAudioStemCount: number,
  audioStemCandidateCount: number
) {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const finalCaptionSegments = getFinalCaptionSegments(source.captionSegments);
  const generatedTranscript = source.generatedTranscript?.text.trim() ? source.generatedTranscript : null;
  const markers = getSortedRecordingMarkers(source.markers);
  return {
    app: 'livestream-studio',
    exportType: 'podcast-audio-bundle',
    version: 1,
    exportedAt,
    session: {
      id: source.sessionId,
      roomName: source.roomName,
      createdAt: source.createdAt,
      durationSeconds: source.durationSeconds,
      audioTrackCount: files.length,
      totalBytes,
    },
    audioTracks: files.map((file, index) => ({
      trackIndex: index + 1,
      label: file.label,
      fileName: file.fileName,
      zipPath: file.zipPath,
      size: file.size,
      type: file.type,
      kind: 'audio',
      ...(file.capture ? { capture: file.capture } : {}),
    })),
    audioStems: {
      format: 'wav',
      encoding: 'pcm_s16le',
      bitDepth: 16,
      generatedCount: audioStemFiles.length,
      skippedCount: skippedAudioStemCount,
      candidateCount: audioStemCandidateCount,
      files: audioStemFiles,
    },
    quality: {
      reportVersion: 1,
      files: qualityFiles,
    },
    ...(captionFiles.length > 0
      ? {
          captions: {
            language: source.captionLanguage || null,
            languageLabel: getCaptionLanguageLabel(source.captionLanguage),
            segmentCount: finalCaptionSegments.length,
            ...(generatedTranscript
              ? {
                  generatedTranscript: {
                    model: generatedTranscript.model,
                    sourceFileName: generatedTranscript.sourceFileName,
                    sourceLabel: generatedTranscript.sourceLabel,
                    createdAt: generatedTranscript.createdAt,
                    language: generatedTranscript.language || null,
                  },
                }
              : {}),
            files: captionFiles,
          },
        }
      : {}),
    ...(markers.length > 0
      ? {
          markers: {
            markerCount: markers.length,
            files: markerFiles,
          },
        }
      : {}),
  };
}

async function createZipBundle(entries: ZipEntry[]): Promise<Blob> {
  if (entries.length > ZIP_UINT16_MAX) {
    throw new Error('Too many files for this browser ZIP export');
  }

  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const pathBytes = ZIP_ENCODER.encode(entry.path);
    assertZipLimit(pathBytes.length, 'ZIP file path', ZIP_UINT16_MAX);

    const dataBuffer = await entry.blob.arrayBuffer();
    const data = new Uint8Array(dataBuffer);
    assertZipLimit(data.byteLength, entry.path);

    const checksum = crc32(data);
    const { time, date } = getZipTimestamp(entry.modifiedAt || new Date());

    const localHeader = new Uint8Array(30 + pathBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, pathBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(pathBytes, 30);

    const centralHeader = new Uint8Array(46 + pathBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, pathBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(pathBytes, 46);

    localParts.push(localHeader.buffer, dataBuffer);
    centralParts.push(centralHeader.buffer);
    centralSize += centralHeader.byteLength;
    offset += localHeader.byteLength + data.byteLength;
    assertZipLimit(offset, 'ZIP archive');
  }

  const centralOffset = offset;
  assertZipLimit(centralOffset + centralSize, 'ZIP archive');

  const endHeader = new Uint8Array(22);
  const endView = new DataView(endHeader.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, endHeader.buffer], { type: 'application/zip' });
}

function buildRecordingCaptionEntries(source: RecordingBundleSource) {
  const finalCaptionSegments = getFinalCaptionSegments(source.captionSegments);
  const entries = finalCaptionSegments.length > 0
    ? [
        {
          path: 'captions/live_captions.txt',
          blob: new Blob([buildPlainCaptionTranscript(source, finalCaptionSegments)], { type: 'text/plain;charset=utf-8' }),
          label: 'Live captions transcript',
          format: 'txt' as const,
        },
        {
          path: 'captions/live_captions.vtt',
          blob: new Blob([buildCaptionWebVtt(source, finalCaptionSegments)], { type: 'text/vtt;charset=utf-8' }),
          label: 'Live captions WebVTT',
          format: 'vtt' as const,
        },
      ]
    : [];

  if (source.generatedTranscript?.text.trim()) {
    entries.push({
      path: 'captions/generated_transcript.txt',
      blob: new Blob([buildGeneratedRecordingTranscriptText(source, source.generatedTranscript)], { type: 'text/plain;charset=utf-8' }),
      label: 'Generated transcript',
      format: 'txt' as const,
    });
  }

  return entries;
}

export async function createRecordingBundle(source: RecordingBundleSource): Promise<Blob> {
  const exportedAt = new Date().toISOString();
  const seenPaths = new Set<string>();
  const trackEntries = source.files.map((file, index) => ({
    path: makeUniqueZipPath(file.fileName, index, seenPaths),
    blob: file.blob,
    file,
  }));
  const manifestFiles: RecordingBundleFile[] = trackEntries.map((entry) => ({
    label: entry.file.label,
    fileName: entry.file.fileName,
    zipPath: entry.path,
    size: entry.file.blob.size,
    type: getRecordingFileType(entry.file),
    kind: entry.file.kind,
    capture: entry.file.capture,
  }));
  const audioStemResult = await buildWavAudioStems(trackEntries, manifestFiles, seenPaths);
  const captionEntries = buildRecordingCaptionEntries(source);
  const captionFiles: RecordingCaptionFile[] = captionEntries.map((entry) => ({
    label: entry.label,
    format: entry.format,
    zipPath: entry.path,
    size: entry.blob.size,
    type: entry.blob.type,
  }));
  const sortedMarkers = getSortedRecordingMarkers(source.markers);
  const markerEntries = sortedMarkers.length > 0
    ? [
        {
          path: 'markers/recording_markers.json',
          blob: new Blob([buildRecordingMarkersJson(source, sortedMarkers)], { type: 'application/json' }),
          label: 'Recording markers JSON',
          format: 'json' as const,
        },
        {
          path: 'markers/recording_markers.csv',
          blob: new Blob([buildRecordingMarkersCsv(sortedMarkers)], { type: 'text/csv;charset=utf-8' }),
          label: 'Recording markers CSV',
          format: 'csv' as const,
        },
      ]
    : [];
  const markerFiles: RecordingMarkerFile[] = markerEntries.map((entry) => ({
    label: entry.label,
    format: entry.format,
    zipPath: entry.path,
    size: entry.blob.size,
    type: entry.blob.type,
  }));
  const editorTimeline = createEditorTimeline(source, manifestFiles, audioStemResult.files, sortedMarkers, exportedAt);
  const editorEntries = [
    {
      path: 'editor/local_recording_timeline.json',
      blob: new Blob([JSON.stringify(editorTimeline, null, 2)], { type: 'application/json' }),
      label: 'Editor timeline JSON',
      format: 'json' as const,
    },
    {
      path: 'editor/local_recording_timeline.csv',
      blob: new Blob([buildEditorTimelineCsv(source, manifestFiles, audioStemResult.files)], { type: 'text/csv;charset=utf-8' }),
      label: 'Editor timeline CSV',
      format: 'csv' as const,
    },
    {
      path: 'editor/local_recording_timeline.fcpxml',
      blob: new Blob([buildFinalCutProXml(source, manifestFiles, audioStemResult.files, sortedMarkers)], { type: 'application/xml;charset=utf-8' }),
      label: 'Final Cut Pro XML',
      format: 'fcpxml' as const,
    },
    {
      path: 'editor/premiere_pro_sequence.xml',
      blob: new Blob([buildPremiereProXml(source, manifestFiles, audioStemResult.files, sortedMarkers)], { type: 'application/xml;charset=utf-8' }),
      label: 'Adobe Premiere Pro XML',
      format: 'premiere-xml' as const,
    },
    {
      path: 'editor/davinci_resolve_timeline.xml',
      blob: new Blob([buildDaVinciResolveXml(source, manifestFiles, audioStemResult.files, sortedMarkers)], { type: 'application/xml;charset=utf-8' }),
      label: 'DaVinci Resolve XML',
      format: 'davinci-resolve-xml' as const,
    },
    {
      path: 'editor/README.txt',
      blob: new Blob([buildEditorReadme(source)], { type: 'text/plain;charset=utf-8' }),
      label: 'Editor export notes',
      format: 'txt' as const,
    },
  ];
  const editorFiles: RecordingEditorFile[] = editorEntries.map((entry) => ({
    label: entry.label,
    format: entry.format,
    zipPath: entry.path,
    size: entry.blob.size,
    type: entry.blob.type,
  }));
  const qualityReport = createRecordingQualityReport(
    source,
    manifestFiles,
    exportedAt,
    audioStemResult.files,
    audioStemResult.skippedCount,
    audioStemResult.candidateCount
  );
  const qualityEntries = buildRecordingQualityEntries(qualityReport);
  const qualityFiles: RecordingQualityFile[] = qualityEntries.map((entry) => ({
    label: entry.label,
    format: entry.format,
    zipPath: entry.path,
    size: entry.blob.size,
    type: entry.blob.type,
  }));
  const manifest = createRecordingManifest(
    source,
    manifestFiles,
    exportedAt,
    captionFiles,
    markerFiles,
    editorFiles,
    qualityFiles,
    audioStemResult.files,
    audioStemResult.skippedCount,
    audioStemResult.candidateCount
  );
  const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });

  return createZipBundle([
    { path: 'manifest.json', blob: manifestBlob },
    ...trackEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...audioStemResult.entries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...editorEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...qualityEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...captionEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...markerEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
  ]);
}

export async function createPodcastAudioBundle(source: RecordingBundleSource): Promise<Blob> {
  const audioFiles = source.files.filter(isPodcastAudioFile);
  if (audioFiles.length === 0) {
    throw new Error('Podcast export requires at least one audio track.');
  }

  const exportedAt = new Date().toISOString();
  const seenPaths = new Set<string>();
  const audioEntries = audioFiles.map((file, index) => ({
    path: makeUniquePodcastAudioZipPath(file.fileName, index, seenPaths),
    blob: file.blob,
    file,
  }));
  const manifestFiles: RecordingBundleFile[] = audioEntries.map((entry) => ({
    label: entry.file.label,
    fileName: entry.file.fileName,
    zipPath: entry.path,
    size: entry.file.blob.size,
    type: getRecordingFileType(entry.file),
    kind: 'audio',
    capture: entry.file.capture,
  }));
  const audioStemResult = await buildWavAudioStems(audioEntries, manifestFiles, seenPaths);
  const captionEntries = buildRecordingCaptionEntries(source);
  const captionFiles: RecordingCaptionFile[] = captionEntries.map((entry) => ({
    label: entry.label,
    format: entry.format,
    zipPath: entry.path,
    size: entry.blob.size,
    type: entry.blob.type,
  }));
  const sortedMarkers = getSortedRecordingMarkers(source.markers);
  const markerEntries = sortedMarkers.length > 0
    ? [
        {
          path: 'markers/recording_markers.json',
          blob: new Blob([buildRecordingMarkersJson(source, sortedMarkers)], { type: 'application/json' }),
          label: 'Recording markers JSON',
          format: 'json' as const,
        },
        {
          path: 'markers/recording_markers.csv',
          blob: new Blob([buildRecordingMarkersCsv(sortedMarkers)], { type: 'text/csv;charset=utf-8' }),
          label: 'Recording markers CSV',
          format: 'csv' as const,
        },
      ]
    : [];
  const markerFiles: RecordingMarkerFile[] = markerEntries.map((entry) => ({
    label: entry.label,
    format: entry.format,
    zipPath: entry.path,
    size: entry.blob.size,
    type: entry.blob.type,
  }));
  const readmeEntry = {
    path: 'README.txt',
    blob: new Blob([buildPodcastReadme(source)], { type: 'text/plain;charset=utf-8' }),
  };
  const qualityReport = createRecordingQualityReport(
    source,
    manifestFiles,
    exportedAt,
    audioStemResult.files,
    audioStemResult.skippedCount,
    audioStemResult.candidateCount
  );
  const qualityEntries = buildRecordingQualityEntries(qualityReport);
  const qualityFiles: RecordingQualityFile[] = qualityEntries.map((entry) => ({
    label: entry.label,
    format: entry.format,
    zipPath: entry.path,
    size: entry.blob.size,
    type: entry.blob.type,
  }));
  const manifest = createPodcastManifest(
    source,
    manifestFiles,
    exportedAt,
    captionFiles,
    markerFiles,
    qualityFiles,
    audioStemResult.files,
    audioStemResult.skippedCount,
    audioStemResult.candidateCount
  );
  const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });

  return createZipBundle([
    { path: 'manifest.json', blob: manifestBlob },
    ...audioEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...audioStemResult.entries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...qualityEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    readmeEntry,
    ...captionEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...markerEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
  ]);
}

export async function createRecordingDriveHandoffFiles(
  source: RecordingBundleSource,
  retention?: RecordingDriveRetentionManifest
): Promise<RecordedFile[]> {
  const uploadFiles = source.files.filter((file) => file.blob.size > 0);
  const editorBundle = await createRecordingBundle(source);
  const handoffFiles: RecordedFile[] = [
    ...uploadFiles,
    {
      label: 'Editor bundle ZIP',
      blob: editorBundle,
      fileName: makeBundleFileName(source.roomName, source.createdAt),
    },
  ];

  if (uploadFiles.some(isPodcastAudioFile)) {
    const podcastBundle = await createPodcastAudioBundle(source);
    handoffFiles.push({
      label: 'Podcast audio ZIP',
      blob: podcastBundle,
      fileName: makePodcastBundleFileName(source.roomName, source.createdAt),
    });
  }

  if (retention) {
    handoffFiles.push({
      label: 'Drive retention manifest',
      blob: new Blob([buildRecordingDriveRetentionManifest(source, retention)], { type: 'application/json' }),
      fileName: makeDriveRetentionManifestFileName(source.roomName, source.createdAt),
    });
  }

  return handoffFiles;
}

export function RecordingPanel({
  isRecording,
  formattedTime,
  recordingTrackLabels = [],
  recordingReadiness,
  recordingMarkers = [],
  onStartRecording,
  onStopRecording,
  onUploadRecording,
  onDownloadRecordingExportArtifact,
  onAddRecordingMarker,
  onRemoveRecordingMarker,
  onClearRecordingMarkers,
  onReplaceRecordingMarkers,
  roomName,
  captionSegments = [],
  captionLanguage,
  onClose,
}: RecordingPanelProps) {
  const [recordedFiles, setRecordedFiles] = useState<RecordedFile[]>([]);
  const [lastRecordingDurationSeconds, setLastRecordingDurationSeconds] = useState<number | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; type: string; label: string } | null>(null);
  const [libraryBusyId, setLibraryBusyId] = useState<string | null>(null);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [libraryTrackFiles, setLibraryTrackFiles] = useState<Record<string, RecordedFile[]>>({});
  const [libraryTrackError, setLibraryTrackError] = useState<{ sessionId: string; message: string } | null>(null);
  const [isBundling, setIsBundling] = useState(false);
  const [isPodcastBundling, setIsPodcastBundling] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [markerLabel, setMarkerLabel] = useState('');
  const markerImportInputRef = useRef<HTMLInputElement>(null);
  const [markerImportMessage, setMarkerImportMessage] = useState<string | null>(null);
  const [markerImportError, setMarkerImportError] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryFilter, setLibraryFilter] = useState<RecordingLibraryFilter>('all');
  const [libraryActionError, setLibraryActionError] = useState<string | null>(null);
  const [driveShareLink, setDriveShareLink] = useState<string | null>(null);
  const [driveUploadMessage, setDriveUploadMessage] = useState<string | null>(null);
  const [driveUploadError, setDriveUploadError] = useState<string | null>(null);
  const [mediaUploadMessage, setMediaUploadMessage] = useState<string | null>(null);
  const [mediaUploadError, setMediaUploadError] = useState<string | null>(null);
  const [mediaExportJob, setMediaExportJob] = useState<RecordingExportJobResponse | null>(null);
  const [mediaExportDownloadError, setMediaExportDownloadError] = useState<string | null>(null);
  const [mediaExportDownloadingId, setMediaExportDownloadingId] = useState<string | null>(null);
  const [recordingExportVideoCodec, setRecordingExportVideoCodec] = useState<RecordingExportVideoCodec>('h264');
  const [driveLinkCopied, setDriveLinkCopied] = useState(false);
  const [driveRetentionPolicyId, setDriveRetentionPolicyId] = useState<RecordingCloudRetentionPolicyId>(
    DEFAULT_RECORDING_CLOUD_RETENTION_POLICY_ID
  );
  const [generatedTranscript, setGeneratedTranscript] = useState<RecordingTranscriptionResult | null>(null);
  const [isGeneratingTranscript, setIsGeneratingTranscript] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);

  const {
    authorize,
    uploadFile,
    createFolder,
    createShareLink,
    uploadProgress,
    isUploading,
    isAuthorized,
  } = useGoogleDriveUpload();
  const {
    sessions,
    isLoading: libraryLoading,
    error: libraryError,
    saveSession,
    deleteSession,
    loadFiles,
    updateSessionCloudHandoff,
    updateSessionMediaExport,
  } = useRecordingLibrary();
  const visibleTrackLabels = recordingTrackLabels.length > 0
    ? recordingTrackLabels
    : ['Audio', 'Video', 'Screen'];
  const canStartRecording = recordingReadiness?.canStart ?? true;
  const finalCaptionCount = getFinalCaptionSegments(captionSegments).length;
  const sortedRecordingMarkers = useMemo(() => getSortedRecordingMarkers(recordingMarkers), [recordingMarkers]);
  const markerCount = sortedRecordingMarkers.length;
  const hasPodcastAudioTracks = useMemo(
    () => recordedFiles.some(isPodcastAudioFile),
    [recordedFiles]
  );
  const transcriptionCandidate = useMemo(
    () => selectRecordingTranscriptionCandidate(recordedFiles),
    [recordedFiles]
  );
  const filteredSessions = useMemo(
    () => filterRecordingLibrarySessions(sessions, libraryQuery, libraryFilter),
    [libraryFilter, libraryQuery, sessions]
  );
  const libraryDashboard = useMemo(
    () => buildRecordingLibraryDashboardSummary(sessions, filteredSessions),
    [filteredSessions, sessions]
  );
  const recordingSummary = useMemo(() => buildRecordingSessionSummary({
    durationSeconds: lastRecordingDurationSeconds,
    files: recordedFiles.map((file) => ({ size: file.blob.size, kind: file.kind })),
    markerCount,
    captionCount: finalCaptionCount,
  }), [finalCaptionCount, lastRecordingDurationSeconds, markerCount, recordedFiles]);
  const driveRetentionPolicy = useMemo(
    () => getRecordingCloudRetentionPolicy(driveRetentionPolicyId),
    [driveRetentionPolicyId]
  );

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const handleStop = useCallback(async () => {
    setIsStopping(true);
    const durationSeconds = parseDurationSeconds(formattedTime);
    try {
      const result = await onStopRecording();
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      setDriveShareLink(null);
      setDriveUploadMessage(null);
      setDriveUploadError(null);
      setDriveLinkCopied(false);
      setMediaUploadMessage(null);
      setMediaUploadError(null);
      setMediaExportJob(null);
      setMediaExportDownloadError(null);
      setMediaExportDownloadingId(null);
      setGeneratedTranscript(null);
      setTranscriptionError(null);
      const resultFiles = result.files.length > 0
        ? result.files
        : [
            { label: 'Audio', kind: 'audio' as const, blob: result.audio },
            { label: 'Video', kind: 'video' as const, blob: result.video },
            ...(result.screen ? [{ label: 'Screen', kind: 'screen' as const, blob: result.screen }] : []),
            ...(result.program ? [{ label: 'Program mix', kind: 'program' as const, blob: result.program }] : []),
          ];
      const files: RecordedFile[] = resultFiles
        .filter((file) => file.blob.size > 0)
        .map((file, index) => ({
          label: file.label,
          blob: file.blob,
          fileName: makeRecordingFileName(roomName, file.label, timestamp, index, file),
          kind: file.kind,
          capture: file.capture,
        }));

      setRecordedFiles(files);
      setLastRecordingDurationSeconds(durationSeconds);
      if (files.length > 0) {
        const session = await saveSession({
          roomName,
          durationSeconds,
          files,
          markers: sortedRecordingMarkers,
        });
        setActiveSessionId(session.id);
        setLibraryTrackFiles((current) => ({ ...current, [session.id]: files }));
        if (onUploadRecording) {
          setMediaUploadMessage('Uploading recording tracks to media server...');
          try {
            const upload = await onUploadRecording({
              sessionId: session.id,
              files,
              exportVideoCodec: recordingExportVideoCodec,
            });
            const skipped = upload.skippedTracks > 0 ? `, ${upload.skippedTracks} skipped` : '';
            const readyArtifacts = upload.exportJob?.artifacts.filter((artifact) => artifact.status === 'ready') || [];
            const artifactSummary = readyArtifacts.length > 0
              ? ` ${readyArtifacts.map((artifact) => artifact.format.toUpperCase()).join(', ')} ready.`
              : '';
            const exportStatus = upload.exportJob
              ? ` Export ${upload.exportJob.status}.${artifactSummary}`
              : upload.exportError
                ? ` Export not started: ${upload.exportError}.`
                : '';
            setMediaUploadMessage(
              `Media server received ${upload.uploadedTracks} track${upload.uploadedTracks === 1 ? '' : 's'} (${formatFileSize(upload.bytesReceived)}${skipped}).${exportStatus}`
            );
            setMediaExportJob(upload.exportJob || null);
            setMediaExportDownloadError(null);
            setMediaUploadError(null);
            if (upload.exportJob) {
              try {
                await updateSessionMediaExport(session.id, upload.exportJob);
              } catch (err) {
                console.warn('Failed to save media export metadata:', err);
              }
            }
          } catch (err) {
            console.warn('Media-server recording upload failed:', err);
            setMediaUploadMessage(null);
            setMediaUploadError('Media server upload unavailable. Local recording is saved in this browser.');
            setMediaExportJob(null);
          }
        }
      }
    } catch (err) {
      console.error('Error stopping recording:', err);
    } finally {
      setIsStopping(false);
    }
  }, [formattedTime, onStopRecording, onUploadRecording, recordingExportVideoCodec, roomName, saveSession, sortedRecordingMarkers, updateSessionMediaExport]);

  const readyMediaExportArtifacts = useMemo(() => (
    mediaExportJob?.artifacts.filter((artifact) => artifact.status === 'ready') || []
  ), [mediaExportJob]);

  const handleDownloadMediaExportArtifact = useCallback(async (artifact: RecordingExportArtifactStatus) => {
    if (!mediaExportJob || !onDownloadRecordingExportArtifact) return;
    setMediaExportDownloadingId(artifact.id);
    setMediaExportDownloadError(null);
    try {
      const download = await onDownloadRecordingExportArtifact({
        uploadId: mediaExportJob.uploadId,
        exportId: mediaExportJob.exportId,
        artifact,
      });
      downloadBlob(download.blob, download.fileName);
    } catch (err) {
      console.warn('Media-server export artifact download failed:', err);
      setMediaExportDownloadError(err instanceof Error && err.message
        ? err.message
        : 'Media server export download failed.');
    } finally {
      setMediaExportDownloadingId(null);
    }
  }, [mediaExportJob, onDownloadRecordingExportArtifact]);

  const handleDownloadAll = useCallback(async () => {
    for (let i = 0; i < recordedFiles.length; i++) {
      downloadBlob(recordedFiles[i].blob, recordedFiles[i].fileName);
      if (i < recordedFiles.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }, [recordedFiles]);

  const handleAddMarker = useCallback(() => {
    if (!onAddRecordingMarker) return;
    const seconds = parseDurationSeconds(formattedTime) ?? 0;
    const label = markerLabel.trim() || `Marker ${markerCount + 1}`;
    onAddRecordingMarker(seconds, label);
    setMarkerLabel('');
    setMarkerImportMessage(null);
    setMarkerImportError(null);
  }, [formattedTime, markerCount, markerLabel, onAddRecordingMarker]);

  const handleDownloadMarkersCsv = useCallback(() => {
    const fileName = `${sanitizeFileName(roomName, 'studio')}_recording_markers.csv`;
    downloadTextFile(buildRecordingMarkersCsv(sortedRecordingMarkers), fileName, 'text/csv;charset=utf-8');
  }, [roomName, sortedRecordingMarkers]);

  const handleExportLibraryCatalog = useCallback(() => {
    if (filteredSessions.length === 0) return;
    downloadTextFile(
      buildRecordingLibraryCatalogCsv(filteredSessions),
      buildRecordingLibraryCatalogFilename(),
      'text/csv;charset=utf-8'
    );
  }, [filteredSessions]);

  const handleImportMarkersCsv = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !onReplaceRecordingMarkers) return;

    setMarkerImportMessage(null);
    setMarkerImportError(null);
    try {
      const text = await file.text();
      const result = parseRecordingMarkersCsv(text);
      if (result.markers.length === 0) {
        setMarkerImportError('No valid markers found in CSV.');
        return;
      }
      onReplaceRecordingMarkers(result.markers);
      setMarkerImportMessage(`Imported ${result.markers.length} marker${result.markers.length === 1 ? '' : 's'}${result.skippedRows > 0 ? `, skipped ${result.skippedRows}` : ''}.`);
    } catch (err) {
      setMarkerImportError(err instanceof Error ? err.message : 'Could not import marker CSV.');
    }
  }, [onReplaceRecordingMarkers]);

  const handleDownloadBundle = useCallback(async () => {
    if (recordedFiles.length === 0) return;
    const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
    const source: RecordingBundleSource = {
      roomName: activeSession?.roomName || roomName,
      sessionId: activeSession?.id || activeSessionId,
      createdAt: activeSession?.createdAt || new Date().toISOString(),
      durationSeconds: activeSession?.durationSeconds ?? parseDurationSeconds(formattedTime),
      files: recordedFiles,
      captionSegments,
      captionLanguage,
      markers: sortedRecordingMarkers,
      generatedTranscript,
    };

    setIsBundling(true);
    setBundleError(null);
    try {
      const bundle = await createRecordingBundle(source);
      downloadBlob(bundle, makeBundleFileName(source.roomName, source.createdAt));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create recording bundle';
      setBundleError(message);
    } finally {
      setIsBundling(false);
    }
  }, [activeSessionId, captionLanguage, captionSegments, formattedTime, generatedTranscript, recordedFiles, roomName, sessions, sortedRecordingMarkers]);

  const handleDownloadPodcastBundle = useCallback(async () => {
    if (recordedFiles.length === 0) return;
    const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
    const source: RecordingBundleSource = {
      roomName: activeSession?.roomName || roomName,
      sessionId: activeSession?.id || activeSessionId,
      createdAt: activeSession?.createdAt || new Date().toISOString(),
      durationSeconds: activeSession?.durationSeconds ?? parseDurationSeconds(formattedTime),
      files: recordedFiles,
      captionSegments,
      captionLanguage,
      markers: sortedRecordingMarkers,
      generatedTranscript,
    };

    setIsPodcastBundling(true);
    setBundleError(null);
    try {
      const bundle = await createPodcastAudioBundle(source);
      downloadBlob(bundle, makePodcastBundleFileName(source.roomName, source.createdAt));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create podcast audio export';
      setBundleError(message);
    } finally {
      setIsPodcastBundling(false);
    }
  }, [activeSessionId, captionLanguage, captionSegments, formattedTime, generatedTranscript, recordedFiles, roomName, sessions, sortedRecordingMarkers]);

  const handleGenerateTranscript = useCallback(async () => {
    if (!transcriptionCandidate) {
      setTranscriptionError('Record an audio track before generating a transcript.');
      return;
    }

    setIsGeneratingTranscript(true);
    setTranscriptionError(null);
    try {
      const transcript = await requestRecordingTranscription(transcriptionCandidate, captionLanguage);
      setGeneratedTranscript(transcript);
    } catch (err) {
      setTranscriptionError(err instanceof Error ? err.message : 'Transcript generation failed.');
    } finally {
      setIsGeneratingTranscript(false);
    }
  }, [captionLanguage, transcriptionCandidate]);

  const handleDownloadGeneratedTranscript = useCallback(() => {
    if (!generatedTranscript) return;
    const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
    const source: RecordingBundleSource = {
      roomName: activeSession?.roomName || roomName,
      sessionId: activeSession?.id || activeSessionId,
      createdAt: activeSession?.createdAt || new Date().toISOString(),
      durationSeconds: activeSession?.durationSeconds ?? parseDurationSeconds(formattedTime),
      files: recordedFiles,
      captionLanguage,
      generatedTranscript,
    };
    downloadTextFile(
      buildGeneratedRecordingTranscriptText(source, generatedTranscript),
      `${sanitizeFileName(source.roomName, 'studio')}_generated_transcript.txt`,
      'text/plain;charset=utf-8'
    );
  }, [activeSessionId, captionLanguage, formattedTime, generatedTranscript, recordedFiles, roomName, sessions]);

  const handleDownloadSingle = useCallback((file: RecordedFile) => {
    downloadBlob(file.blob, file.fileName);
  }, []);

  const handleUploadToDrive = useCallback(async () => {
    setDriveShareLink(null);
    setDriveUploadMessage(null);
    setDriveUploadError(null);
    setDriveLinkCopied(false);
    let authorized = isAuthorized;
    if (!authorized) {
      authorized = await authorize();
      if (!authorized) {
        setDriveUploadError('Google Drive authorization failed.');
        console.error('Google Drive authorization failed');
        return;
      }
    }

    const activeSession = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : null;
    const source: RecordingBundleSource = {
      roomName: activeSession?.roomName || roomName,
      sessionId: activeSession?.id || activeSessionId,
      createdAt: activeSession?.createdAt || new Date().toISOString(),
      durationSeconds: activeSession?.durationSeconds ?? parseDurationSeconds(formattedTime),
      files: recordedFiles,
      captionSegments,
      captionLanguage,
      markers: sortedRecordingMarkers,
      generatedTranscript,
    };
    const uploadedAt = new Date().toISOString();
    const retentionPolicy = getRecordingCloudRetentionPolicy(driveRetentionPolicyId);
    const retentionManifest: RecordingDriveRetentionManifest = {
      policyId: retentionPolicy.id,
      label: retentionPolicy.label,
      uploadedAt,
      expiresAt: getRecordingCloudRetentionExpiresAt(retentionPolicy.id, uploadedAt),
      permanent: retentionPolicy.permanent,
    };

    let uploadFiles: RecordedFile[];
    try {
      setDriveUploadMessage('Preparing editor bundles for Google Drive...');
      uploadFiles = await createRecordingDriveHandoffFiles(source, retentionManifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to prepare Google Drive upload bundle.';
      setDriveUploadError(message);
      setDriveUploadMessage(null);
      return;
    }

    // Create a folder for this recording session
    const date = new Date().toISOString().slice(0, 10);
    const folderName = `${source.roomName} - ${date}`;
    const folderId = await createFolder(folderName);

    if (!folderId) {
      setDriveUploadError('Failed to create Google Drive folder.');
      console.error('Failed to create Google Drive folder');
      return;
    }

    // Upload all files into the folder
    setDriveUploadMessage(`Uploading ${uploadFiles.length} Drive handoff files...`);
    const uploadPromises = uploadFiles.map((file) =>
      uploadFile(file.blob, file.fileName, folderId)
    );

    const uploadResults = await Promise.all(uploadPromises);
    if (uploadResults.some((id) => !id)) {
      setDriveUploadError('Some recording handoff files failed to upload.');
      return;
    }

    const shareResult = await createShareLink(folderId);
    if (!shareResult) {
      setDriveUploadError('Uploaded to Google Drive, but sharing could not be enabled.');
      return;
    }

    setDriveShareLink(shareResult.webViewLink);
    const cloudHandoff: RecordingCloudHandoff = {
      provider: 'google-drive',
      folderId: shareResult.folderId || folderId,
      webViewLink: shareResult.webViewLink,
      uploadedAt,
      expiresAt: retentionManifest.expiresAt,
      retentionPolicyId: retentionManifest.policyId,
      permanent: retentionManifest.permanent,
      fileCount: uploadFiles.length,
      totalBytes: uploadFiles.reduce((total, file) => total + file.blob.size, 0),
    };
    if (activeSession?.id) {
      await updateSessionCloudHandoff(activeSession.id, cloudHandoff);
    }
    const retentionLabel = retentionManifest.permanent
      ? 'permanent archive'
      : `expires ${formatDateTime(retentionManifest.expiresAt || uploadedAt)}`;
    setDriveUploadMessage(`Uploaded ${uploadFiles.length} files to Google Drive. Share link is ready; ${retentionLabel}.`);
    console.log('All files uploaded to Google Drive');
  }, [activeSessionId, authorize, captionLanguage, captionSegments, createFolder, createShareLink, driveRetentionPolicyId, formattedTime, generatedTranscript, isAuthorized, recordedFiles, roomName, sessions, sortedRecordingMarkers, updateSessionCloudHandoff, uploadFile]);

  const handleCopyDriveShareLink = useCallback(async () => {
    if (!driveShareLink) return;
    try {
      await copyTextToClipboard(driveShareLink);
      setDriveLinkCopied(true);
      window.setTimeout(() => setDriveLinkCopied(false), 2200);
    } catch (err) {
      setDriveUploadError(err instanceof Error ? err.message : 'Could not copy Drive share link.');
    }
  }, [driveShareLink]);

  const handleNewRecording = useCallback(() => {
    setRecordedFiles([]);
    setLastRecordingDurationSeconds(null);
    setActiveSessionId(null);
    setPreview(null);
    setDriveShareLink(null);
    setDriveUploadMessage(null);
    setDriveUploadError(null);
    setDriveLinkCopied(false);
    setGeneratedTranscript(null);
    setTranscriptionError(null);
    onClearRecordingMarkers?.();
  }, [onClearRecordingMarkers]);

  const handlePreviewFile = useCallback((file: RecordedFile) => {
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return {
        url: URL.createObjectURL(file.blob),
        type: getRecordingFileType(file),
        label: file.label,
      };
    });
  }, []);

  const handleToggleSessionTracks = useCallback(async (session: LocalRecordingSession) => {
    setLibraryTrackError(null);
    if (expandedSessionId === session.id) {
      setExpandedSessionId(null);
      return;
    }

    setExpandedSessionId(session.id);
    if (libraryTrackFiles[session.id]) return;

    setLibraryBusyId(session.id);
    try {
      const files = await loadFiles(session.id);
      setLibraryTrackFiles((current) => ({
        ...current,
        [session.id]: mapRecordingLibraryFiles(files),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load recording tracks';
      setLibraryTrackError({ sessionId: session.id, message });
    } finally {
      setLibraryBusyId(null);
    }
  }, [expandedSessionId, libraryTrackFiles, loadFiles]);

  const handleLoadSession = useCallback(async (session: LocalRecordingSession) => {
    setLibraryBusyId(session.id);
    setLibraryActionError(null);
    try {
      const files = await loadFiles(session.id);
      const mappedFiles = mapRecordingLibraryFiles(files);
      setRecordedFiles(mappedFiles);
      setLibraryTrackFiles((current) => ({
        ...current,
        [session.id]: mappedFiles,
      }));
      setActiveSessionId(session.id);
      setPreview(null);
      setGeneratedTranscript(null);
      setTranscriptionError(null);
      if (onReplaceRecordingMarkers) {
        onReplaceRecordingMarkers(session.markers || []);
      } else {
        onClearRecordingMarkers?.();
      }
    } catch (err) {
      console.error('Failed to load recording session:', err);
    } finally {
      setLibraryBusyId(null);
    }
  }, [loadFiles, onClearRecordingMarkers, onReplaceRecordingMarkers]);

  const handleDownloadSessionMp4Export = useCallback(async (session: LocalRecordingSession) => {
    if (!session.mediaExport || !onDownloadRecordingExportArtifact) return;
    const artifact = getReadyFinalMp4Artifact(session.mediaExport);
    if (!artifact) return;

    setLibraryBusyId(session.id);
    setLibraryActionError(null);
    try {
      const download = await onDownloadRecordingExportArtifact({
        uploadId: session.mediaExport.uploadId,
        exportId: session.mediaExport.exportId,
        artifact,
      });
      downloadBlob(download.blob, download.fileName);
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : 'Media-server MP4 export download failed.';
      setLibraryActionError(message);
    } finally {
      setLibraryBusyId(null);
    }
  }, [onDownloadRecordingExportArtifact]);

  const handleDownloadSessionBundle = useCallback(async (session: LocalRecordingSession) => {
    setLibraryBusyId(session.id);
    setBundleError(null);
    setLibraryActionError(null);
    try {
      const files = await loadFiles(session.id);
      const source: RecordingBundleSource = {
        roomName: session.roomName,
        sessionId: session.id,
        createdAt: session.createdAt,
        durationSeconds: session.durationSeconds,
        files: files.map((file) => ({
          label: file.label,
          blob: file.blob,
          fileName: file.fileName,
          kind: file.kind,
          capture: file.capture,
        })),
        markers: session.id === activeSessionId ? sortedRecordingMarkers : session.markers,
        ...(session.id === activeSessionId ? { captionSegments, captionLanguage, generatedTranscript } : {}),
      };
      const bundle = await createRecordingBundle(source);
      downloadBlob(bundle, makeBundleFileName(session.roomName, session.createdAt));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create recording bundle';
      setBundleError(message);
    } finally {
      setLibraryBusyId(null);
    }
  }, [activeSessionId, captionLanguage, captionSegments, generatedTranscript, loadFiles, sortedRecordingMarkers]);

  const handleDownloadSessionPodcastBundle = useCallback(async (session: LocalRecordingSession) => {
    setLibraryBusyId(session.id);
    setBundleError(null);
    setLibraryActionError(null);
    try {
      const files = await loadFiles(session.id);
      const source: RecordingBundleSource = {
        roomName: session.roomName,
        sessionId: session.id,
        createdAt: session.createdAt,
        durationSeconds: session.durationSeconds,
        files: files.map((file) => ({
          label: file.label,
          blob: file.blob,
          fileName: file.fileName,
          kind: file.kind,
          capture: file.capture,
        })),
        markers: session.id === activeSessionId ? sortedRecordingMarkers : session.markers,
        ...(session.id === activeSessionId ? { captionSegments, captionLanguage, generatedTranscript } : {}),
      };
      const bundle = await createPodcastAudioBundle(source);
      downloadBlob(bundle, makePodcastBundleFileName(session.roomName, session.createdAt));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create podcast audio export';
      setBundleError(message);
    } finally {
      setLibraryBusyId(null);
    }
  }, [activeSessionId, captionLanguage, captionSegments, generatedTranscript, loadFiles, sortedRecordingMarkers]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    setLibraryBusyId(sessionId);
    setLibraryActionError(null);
    try {
      await deleteSession(sessionId);
      if (activeSessionId === sessionId) {
        setRecordedFiles([]);
        setActiveSessionId(null);
        setPreview(null);
        setGeneratedTranscript(null);
        setTranscriptionError(null);
        onClearRecordingMarkers?.();
      }
      if (expandedSessionId === sessionId) {
        setExpandedSessionId(null);
      }
      setLibraryTrackFiles((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      if (libraryTrackError?.sessionId === sessionId) {
        setLibraryTrackError(null);
      }
    } catch (err) {
      console.error('Failed to delete recording session:', err);
    } finally {
      setLibraryBusyId(null);
    }
  }, [activeSessionId, deleteSession, expandedSessionId, libraryTrackError, onClearRecordingMarkers]);

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Local Recording</h3>
          <p style={styles.subtitle}>Multi-track recording</p>
        </div>
        <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={styles.body}>
        {/* Recording Status */}
        {isRecording && (
          <div style={styles.statusCard}>
            <div style={styles.statusHeader}>
              <span style={styles.recordingDot} />
              <span style={styles.statusLabel}>Recording</span>
            </div>
            <div style={styles.timer}>{formattedTime}</div>
            <div style={styles.trackIndicators}>
              {visibleTrackLabels.slice(0, 6).map((label) => (
                <span key={label} style={styles.trackBadge}>{label}</span>
              ))}
              {visibleTrackLabels.length > 6 && (
                <span style={styles.trackBadge}>+{visibleTrackLabels.length - 6}</span>
              )}
              {finalCaptionCount > 0 && <span style={styles.trackBadge}>CC {finalCaptionCount}</span>}
              {markerCount > 0 && <span style={styles.trackBadge}>Markers {markerCount}</span>}
            </div>
            {onAddRecordingMarker && (
              <div style={styles.markerComposer}>
                <input
                  aria-label="Recording marker label"
                  style={styles.markerInput}
                  value={markerLabel}
                  onChange={(event) => setMarkerLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleAddMarker();
                  }}
                  placeholder={`Marker ${markerCount + 1}`}
                  maxLength={120}
                />
                <button type="button" style={styles.markerBtn} onClick={handleAddMarker}>
                  Add Marker
                </button>
              </div>
            )}
            <button
              className="hover-scale"
              style={styles.stopBtn}
              onClick={handleStop}
              disabled={isStopping}
            >
              {isStopping ? 'Stopping...' : 'Stop Recording'}
            </button>
          </div>
        )}

        {onReplaceRecordingMarkers && (
          <div style={styles.markerTools}>
            <input
              ref={markerImportInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={handleImportMarkersCsv}
            />
            <button type="button" style={styles.markerToolBtn} onClick={() => markerImportInputRef.current?.click()}>
              Import CSV
            </button>
            <button type="button" style={styles.markerToolBtn} onClick={handleDownloadMarkersCsv}>
              {markerCount > 0 ? 'Export CSV' : 'CSV Template'}
            </button>
            {markerImportMessage && <span style={styles.markerImportOk}>{markerImportMessage}</span>}
            {markerImportError && <span style={styles.markerImportError}>{markerImportError}</span>}
          </div>
        )}

        {onUploadRecording && (
          <div style={styles.exportCodecCard}>
            <div style={styles.exportCodecHeader}>
              <span style={styles.exportCodecTitle}>Media export MP4</span>
              <span style={styles.exportCodecValue}>{recordingExportVideoCodec === 'h265' ? 'H.265' : 'H.264'}</span>
            </div>
            <div style={styles.exportCodecToggle} role="group" aria-label="Media server MP4 codec">
              {(['h264', 'h265'] as const).map((codec) => {
                const active = recordingExportVideoCodec === codec;
                return (
                  <button
                    key={codec}
                    type="button"
                    style={{
                      ...styles.exportCodecButton,
                      ...(active ? styles.exportCodecButtonActive : {}),
                    }}
                    onClick={() => setRecordingExportVideoCodec(codec)}
                    disabled={isRecording || isStopping}
                  >
                    {codec === 'h265' ? 'H.265' : 'H.264'}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {markerCount > 0 && (
          <div style={styles.markerList}>
            <div style={styles.markerListHeader}>
              <span>Markers</span>
              {onClearRecordingMarkers && (
                <button type="button" style={styles.markerClearBtn} onClick={onClearRecordingMarkers}>
                  Clear
                </button>
              )}
            </div>
            {sortedRecordingMarkers.slice(-8).map((marker) => (
              <div key={marker.id} style={styles.markerRow}>
                <span style={styles.markerTime}>{formatDuration(marker.seconds)}</span>
                <span style={styles.markerText}>{marker.label}</span>
                {onRemoveRecordingMarker && (
                  <button
                    type="button"
                    aria-label={`Remove ${marker.label}`}
                    style={styles.markerRemoveBtn}
                    onClick={() => onRemoveRecordingMarker(marker.id)}
                  >
                    x
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {!isRecording && recordingReadiness && (
          <div style={styles.readinessCard}>
            <div style={styles.readinessHeader}>
              <div>
                <span style={styles.readinessTitle}>Recording Readiness</span>
                <p style={styles.readinessSubtitle}>
                  {recordingReadiness.expectedTracks.length} isolated track{recordingReadiness.expectedTracks.length === 1 ? '' : 's'} detected
                </p>
              </div>
              <span style={{
                ...styles.readinessBadge,
                color: getRecordingReadinessColor(recordingReadiness.status),
                borderColor: getRecordingReadinessBorder(recordingReadiness.status),
                background: getRecordingReadinessBackground(recordingReadiness.status),
              }}>
                {recordingReadiness.label}
              </span>
            </div>
            {recordingReadiness.blockingIssue && (
              <p style={styles.readinessBlocking}>{recordingReadiness.blockingIssue}</p>
            )}
            {recordingReadiness.expectedTracks.length > 0 && (
              <div style={styles.readinessTracks}>
                {recordingReadiness.expectedTracks.slice(0, 8).map((track) => (
                  <span key={track.id} style={styles.readinessTrackBadge}>{track.label}</span>
                ))}
                {recordingReadiness.expectedTracks.length > 8 && (
                  <span style={styles.readinessTrackBadge}>+{recordingReadiness.expectedTracks.length - 8}</span>
                )}
              </div>
            )}
            <div style={styles.readinessItems}>
              {recordingReadiness.items.map((item) => (
                <div key={item.id} style={styles.readinessItem}>
                  <span style={{ ...styles.readinessDot, background: getRecordingReadinessColor(item.status) }} />
                  <div style={styles.readinessItemBody}>
                    <div style={styles.readinessItemTop}>
                      <span style={styles.readinessItemLabel}>{item.label}</span>
                      <span style={{ ...styles.readinessItemStatus, color: getRecordingReadinessColor(item.status) }}>
                        {getRecordingReadinessLabel(item.status)}
                      </span>
                    </div>
                    <p style={styles.readinessItemDetail}>{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Idle State - No recordings, not recording */}
        {!isRecording && recordedFiles.length === 0 && (
          <div style={styles.idleCard}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="4" fill="var(--text-muted)" />
            </svg>
            <p style={styles.idleText}>Record isolated on-stage audio, camera, and screen tracks locally for maximum quality.</p>
            <button
              className="hover-scale"
              style={{
                ...styles.startBtn,
                ...(!canStartRecording ? styles.startBtnDisabled : {}),
              }}
              onClick={onStartRecording}
              disabled={!canStartRecording}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="4" fill="currentColor" />
              </svg>
              Start Recording
            </button>
          </div>
        )}

        {/* Recorded Files */}
        {!isRecording && recordedFiles.length > 0 && (
          <>
            <div style={styles.recordingSummaryCard}>
              <div style={styles.recordingSummaryHeader}>
                <span style={styles.recordingSummaryIcon}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </span>
                <div style={styles.recordingSummaryCopy}>
                  <span style={styles.recordingSummaryTitle}>{recordingSummary.title}</span>
                  <p style={styles.recordingSummaryText}>{recordingSummary.message}</p>
                </div>
              </div>
              <div style={styles.recordingSummaryStats} aria-label="Recording completion summary">
                <span style={styles.recordingSummaryStat}>
                  <strong>{recordingSummary.durationLabel}</strong>
                  <span>Duration</span>
                </span>
                <span style={styles.recordingSummaryStat}>
                  <strong>{recordingSummary.trackLabel}</strong>
                  <span>Tracks</span>
                </span>
                <span style={styles.recordingSummaryStat}>
                  <strong>{recordingSummary.storageLabel}</strong>
                  <span>Storage</span>
                </span>
                <span style={styles.recordingSummaryStat}>
                  <strong>{recordingSummary.markerLabel}</strong>
                  <span>Markers</span>
                </span>
                {recordingSummary.captionLabel && (
                  <span style={styles.recordingSummaryStat}>
                    <strong>{recordingSummary.captionLabel}</strong>
                    <span>Captions</span>
                  </span>
                )}
              </div>
            </div>
            {(mediaUploadMessage || mediaUploadError) && (
              <div style={{
                ...styles.mediaUploadStatus,
                ...(mediaUploadError ? styles.mediaUploadStatusError : {}),
              }}>
                <span style={styles.mediaUploadStatusLabel}>Media server</span>
                <div style={styles.mediaUploadStatusContent}>
                  <span style={styles.mediaUploadStatusText}>{mediaUploadError || mediaUploadMessage}</span>
                  {readyMediaExportArtifacts.length > 0 && onDownloadRecordingExportArtifact && (
                    <div style={styles.mediaExportActions}>
                      {readyMediaExportArtifacts.map((artifact) => (
                        <button
                          key={artifact.id}
                          type="button"
                          style={styles.mediaExportButton}
                          onClick={() => void handleDownloadMediaExportArtifact(artifact)}
                          disabled={mediaExportDownloadingId === artifact.id}
                        >
                          {mediaExportDownloadingId === artifact.id
                            ? 'Downloading'
                            : getMediaExportDownloadLabel(artifact)}
                        </button>
                      ))}
                    </div>
                  )}
                  {mediaExportDownloadError && (
                    <span style={styles.mediaUploadStatusErrorText}>{mediaExportDownloadError}</span>
                  )}
                </div>
              </div>
            )}
            <div style={styles.filesHeader}>
              <span style={styles.filesTitle}>Recorded Files</span>
              <span style={styles.filesCount}>{recordedFiles.length} track{recordedFiles.length !== 1 ? 's' : ''}</span>
            </div>

            {recordedFiles.map((file) => {
              const progress = uploadProgress[file.fileName];
              const isFileUploading = progress !== undefined && progress >= 0 && progress < 100;
              const isFileUploaded = progress === 100;
              const isFileError = progress === -1;

              return (
                <div key={file.fileName} className="participant-item" style={styles.fileCard}>
                  <div style={styles.fileHeader}>
                    <div style={styles.fileInfo}>
                      <span style={styles.fileLabel}>{file.label}</span>
                      <span style={styles.fileSize}>{formatFileSize(file.blob.size)}</span>
                    </div>
                    <div style={styles.fileActions}>
                      {isPreviewable(file) && (
                        <button
                          className="participant-action-btn"
                          style={styles.iconBtn}
                          onClick={() => handlePreviewFile(file)}
                          title={`Preview ${file.label}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="5 3 19 12 5 21 5 3" />
                          </svg>
                        </button>
                      )}
                      <button
                        className="participant-action-btn"
                        style={styles.iconBtn}
                        onClick={() => handleDownloadSingle(file)}
                        title={`Download ${file.label}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div style={styles.fileName}>{file.fileName}</div>

                  {/* Upload progress bar */}
                  {isFileUploading && (
                    <div style={styles.progressContainer}>
                      <div style={styles.progressTrack}>
                        <div
                          style={{
                            ...styles.progressBar,
                            width: `${progress}%`,
                          }}
                        />
                      </div>
                      <span style={styles.progressText}>{progress}%</span>
                    </div>
                  )}
                  {isFileUploaded && (
                    <div style={styles.uploadedBadge}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      Uploaded
                    </div>
                  )}
                  {isFileError && (
                    <div style={styles.errorBadge}>Upload failed</div>
                  )}
                </div>
              );
            })}

            {preview && (
              <div style={styles.previewCard}>
                <div style={styles.previewHeader}>
                  <span style={styles.previewTitle}>Preview: {preview.label}</span>
                  <button style={styles.previewClose} onClick={() => setPreview(null)}>Close</button>
                </div>
                {preview.type.startsWith('audio/') ? (
                  <audio src={preview.url} controls style={styles.previewMedia} />
                ) : (
                  <video src={preview.url} controls style={styles.previewMedia} />
                )}
              </div>
            )}

            {/* Action buttons */}
            <div style={styles.actions}>
              <div style={styles.captionSidecarNote}>
                ZIP includes editor timeline JSON/CSV, Final Cut Pro XML, Premiere Pro XML, DaVinci Resolve XML, and WAV audio stems when supported.
              </div>
              <div style={styles.captionSidecarNote}>
                Podcast ZIP includes audio-only tracks, WAV stems when supported, captions, and markers for show editing.
              </div>
              {finalCaptionCount > 0 && (
                <div style={styles.captionSidecarNote}>
                  ZIP includes captions as TXT and WebVTT sidecars.
                </div>
              )}
              {generatedTranscript && (
                <div style={styles.captionSidecarNote}>
                  ZIP includes the generated transcript as a TXT sidecar.
                </div>
              )}
              {markerCount > 0 && (
                <div style={styles.captionSidecarNote}>
                  ZIP includes recording markers as JSON and CSV sidecars.
                </div>
              )}
              <div style={styles.captionSidecarNote}>
                Google Drive uploads include original tracks plus an editor ZIP and a podcast ZIP when audio is available.
              </div>
              <div style={styles.driveRetentionCard}>
                <label style={styles.driveRetentionLabel} htmlFor="recording-drive-retention">Drive retention</label>
                <select
                  id="recording-drive-retention"
                  style={styles.driveRetentionSelect}
                  value={driveRetentionPolicyId}
                  onChange={(event) => setDriveRetentionPolicyId(event.target.value as RecordingCloudRetentionPolicyId)}
                  disabled={isUploading}
                >
                  {RECORDING_CLOUD_RETENTION_POLICIES.map((policy) => (
                    <option key={policy.id} value={policy.id}>{policy.label}</option>
                  ))}
                </select>
                <span style={styles.driveRetentionDescription}>{driveRetentionPolicy.description}</span>
              </div>
              <button
                className="hover-lift"
                style={{
                  ...styles.transcriptBtn,
                  opacity: !transcriptionCandidate ? 0.45 : isGeneratingTranscript ? 0.6 : 1,
                  ...(!transcriptionCandidate ? styles.startBtnDisabled : {}),
                }}
                onClick={handleGenerateTranscript}
                disabled={!transcriptionCandidate || isGeneratingTranscript}
              >
                {isGeneratingTranscript ? 'Generating Transcript...' : generatedTranscript ? 'Regenerate Transcript' : 'Generate Transcript'}
              </button>
              {transcriptionError && <div style={styles.errorBadge}>{transcriptionError}</div>}
              {generatedTranscript && (
                <div style={styles.transcriptBox}>
                  <div style={styles.transcriptHeader}>
                    <span style={styles.transcriptTitle}>{generatedTranscript.sourceLabel}</span>
                    <button
                      type="button"
                      style={styles.transcriptDownloadBtn}
                      onClick={handleDownloadGeneratedTranscript}
                    >
                      TXT
                    </button>
                  </div>
                  <p style={styles.transcriptPreview}>{generatedTranscript.text}</p>
                </div>
              )}
              <button
                className="hover-lift"
                style={{
                  ...styles.bundleBtn,
                  opacity: isBundling ? 0.6 : 1,
                }}
                onClick={handleDownloadBundle}
                disabled={isBundling}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                  <path d="M7 3h10" />
                </svg>
                {isBundling ? 'Bundling...' : 'Download ZIP'}
              </button>

              <button
                className="hover-lift"
                style={{
                  ...styles.podcastBtn,
                  opacity: !hasPodcastAudioTracks ? 0.45 : isPodcastBundling ? 0.6 : 1,
                  ...(!hasPodcastAudioTracks ? styles.startBtnDisabled : {}),
                }}
                onClick={handleDownloadPodcastBundle}
                disabled={!hasPodcastAudioTracks || isPodcastBundling}
                title={hasPodcastAudioTracks ? 'Download podcast audio ZIP' : 'No audio tracks recorded'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
                {isPodcastBundling ? 'Exporting...' : 'Podcast ZIP'}
              </button>

              <button
                className="hover-lift"
                style={styles.downloadAllBtn}
                onClick={handleDownloadAll}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download Tracks
              </button>

              <button
                className="hover-lift"
                style={{
                  ...styles.driveBtn,
                  opacity: isUploading ? 0.6 : 1,
                }}
                onClick={handleUploadToDrive}
                disabled={isUploading}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 15v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {isUploading ? 'Uploading...' : 'Upload to Google Drive'}
              </button>

              {driveUploadMessage && <div style={styles.driveStatusBadge}>{driveUploadMessage}</div>}
              {driveUploadError && <div style={styles.errorBadge}>{driveUploadError}</div>}
              {driveShareLink && (
                <div style={styles.driveShareBox}>
                  <span style={styles.driveShareText}>{driveShareLink}</span>
                  <button
                    type="button"
                    style={styles.driveShareCopyBtn}
                    onClick={handleCopyDriveShareLink}
                  >
                    {driveLinkCopied ? 'Copied' : 'Copy Link'}
                  </button>
                </div>
              )}
            </div>

            {bundleError && <div style={styles.errorBadge}>{bundleError}</div>}

            {/* New recording button */}
            <button
              style={styles.newRecordingBtn}
              onClick={handleNewRecording}
            >
              New Recording
            </button>
          </>
        )}

        <div style={styles.librarySection}>
          <div style={styles.filesHeader}>
            <span style={styles.filesTitle}>Recording Library</span>
            <div style={styles.libraryHeaderActions}>
              <span style={styles.filesCount}>
                {libraryDashboard.visibleSessions}/{libraryDashboard.totalSessions} saved | {formatFileSize(libraryDashboard.totalBytes)}
              </span>
              {sessions.length > 0 && (
                <button
                  type="button"
                  style={{
                    ...styles.libraryExportBtn,
                    ...(filteredSessions.length === 0 ? styles.libraryExportBtnDisabled : {}),
                  }}
                  onClick={handleExportLibraryCatalog}
                  disabled={filteredSessions.length === 0}
                >
                  CSV
                </button>
              )}
            </div>
          </div>

          {sessions.length > 0 && (
            <div style={styles.libraryDashboard} aria-label="Recording dashboard">
              <div style={styles.libraryStat}>
                <span style={styles.libraryStatLabel}>Sessions</span>
                <span style={styles.libraryStatValue}>{libraryDashboard.visibleSessions}/{libraryDashboard.totalSessions}</span>
              </div>
              <div style={styles.libraryStat}>
                <span style={styles.libraryStatLabel}>Tracks</span>
                <span style={styles.libraryStatValue}>{libraryDashboard.totalTracks}</span>
              </div>
              <div style={styles.libraryStat}>
                <span style={styles.libraryStatLabel}>Duration</span>
                <span style={styles.libraryStatValue}>{formatDuration(libraryDashboard.totalDurationSeconds)}</span>
              </div>
              <div style={styles.libraryStat}>
                <span style={styles.libraryStatLabel}>Storage</span>
                <span style={styles.libraryStatValue}>{formatFileSize(libraryDashboard.totalBytes)}</span>
              </div>
              <div style={styles.libraryStat}>
                <span style={styles.libraryStatLabel}>Cloud</span>
                <span style={styles.libraryStatValue}>{libraryDashboard.cloudSessionCount}</span>
              </div>
              <div style={styles.libraryStat}>
                <span style={styles.libraryStatLabel}>MP4</span>
                <span style={styles.libraryStatValue}>{libraryDashboard.readyMp4ExportSessionCount}/{libraryDashboard.mediaExportSessionCount}</span>
              </div>
              <div style={styles.libraryDashboardFooter}>
                <span style={styles.libraryLatestLabel}>Latest</span>
                <span style={styles.libraryLatestValue}>
                  {libraryDashboard.latestSession
                    ? `${libraryDashboard.latestSession.roomName} | ${formatDateTime(libraryDashboard.latestSession.createdAt)}`
                    : 'No recordings yet'}
                </span>
                <span style={styles.libraryLatestLabel}>
                  {libraryDashboard.markerCount} mark{libraryDashboard.markerCount === 1 ? '' : 's'}
                </span>
                <span style={styles.libraryLatestLabel}>
                  {libraryDashboard.expiringCloudSessionCount} expiring / {libraryDashboard.permanentCloudSessionCount} permanent
                </span>
              </div>
            </div>
          )}

          {sessions.length > 0 && (
            <div style={styles.libraryControls}>
              <input
                aria-label="Search recording library"
                style={styles.librarySearch}
                value={libraryQuery}
                onChange={(event) => setLibraryQuery(event.target.value)}
                placeholder="Search recordings"
                maxLength={120}
              />
              <div style={styles.libraryFilterRow} role="group" aria-label="Filter recording library">
                {RECORDING_LIBRARY_FILTERS.map((filter) => {
                  const active = libraryFilter === filter.value;
                  return (
                    <button
                      key={filter.value}
                      type="button"
                      style={{
                        ...styles.libraryFilterBtn,
                        ...(active ? styles.libraryFilterBtnActive : {}),
                      }}
                      onClick={() => setLibraryFilter(filter.value)}
                    >
                      {filter.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {libraryError && <div style={styles.errorBadge}>{libraryError}</div>}
          {libraryActionError && <div style={styles.errorBadge}>{libraryActionError}</div>}
          {libraryLoading && <div style={styles.libraryEmpty}>Loading saved recordings...</div>}
          {!libraryLoading && sessions.length === 0 && (
            <div style={styles.libraryEmpty}>Saved sessions will appear here after you stop a recording.</div>
          )}
          {!libraryLoading && sessions.length > 0 && filteredSessions.length === 0 && (
            <div style={styles.libraryEmpty}>No saved recordings match the current search and filters.</div>
          )}

          {filteredSessions.map((session) => {
            const isActive = activeSessionId === session.id;
            const isBusy = libraryBusyId === session.id;
            const hasSessionPodcastAudio = sessionHasPodcastAudio(session);
            const isTrackExpanded = expandedSessionId === session.id;
            const sessionTracks = libraryTrackFiles[session.id];
            const trackError = libraryTrackError?.sessionId === session.id ? libraryTrackError.message : null;
            const sessionMp4Artifact = getReadyFinalMp4Artifact(session.mediaExport);
            const canDownloadSessionMp4 = Boolean(sessionMp4Artifact && onDownloadRecordingExportArtifact);
            return (
                <div key={session.id} style={{ ...styles.sessionCard, ...(isActive ? styles.sessionCardActive : {}) }}>
                  <div style={styles.sessionTop}>
                    <div style={styles.sessionInfo}>
                      <span style={styles.sessionName}>{session.roomName}</span>
                      <span style={styles.sessionMeta}>
                        {formatDateTime(session.createdAt)} | {formatDuration(session.durationSeconds)} | {session.trackCount} track{session.trackCount === 1 ? '' : 's'} | {session.markers?.length || 0} mark{(session.markers?.length || 0) === 1 ? '' : 's'} | {formatFileSize(session.totalBytes)}
                      </span>
                      {session.cloud && (
                        <span style={styles.sessionCloudMeta}>
                          Google Drive | {getRecordingCloudRetentionLabel(session.cloud)} | {session.cloud.fileCount} file{session.cloud.fileCount === 1 ? '' : 's'}
                        </span>
                      )}
                      {session.mediaExport && (
                        <span style={styles.sessionCloudMeta}>
                          {getRecordingMediaExportLabel(session.mediaExport)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={styles.sessionActions}>
                    {session.cloud?.webViewLink && (
                      <button
                        style={styles.sessionBtn}
                        onClick={() => window.open(session.cloud?.webViewLink, '_blank', 'noopener,noreferrer')}
                        disabled={isBusy}
                        title="Open Google Drive handoff"
                      >
                        Cloud
                      </button>
                    )}
                    {session.mediaExport && (
                      <button
                        style={{
                          ...styles.sessionBtn,
                          ...(!canDownloadSessionMp4 ? styles.sessionBtnDisabled : {}),
                        }}
                        onClick={() => handleDownloadSessionMp4Export(session)}
                        disabled={isBusy || !canDownloadSessionMp4}
                        title={canDownloadSessionMp4 ? 'Download the media-server MP4 export' : 'MP4 export is not ready'}
                      >
                        {isBusy && canDownloadSessionMp4 ? 'Working...' : 'MP4'}
                      </button>
                    )}
                    <button
                      style={styles.sessionBtn}
                      onClick={() => handleDownloadSessionBundle(session)}
                      disabled={isBusy}
                    >
                      {isBusy ? 'Working...' : 'ZIP'}
                    </button>
                  <button
                    style={{
                      ...styles.sessionBtn,
                      ...(!hasSessionPodcastAudio ? styles.sessionBtnDisabled : {}),
                    }}
                    onClick={() => handleDownloadSessionPodcastBundle(session)}
                    disabled={isBusy || !hasSessionPodcastAudio}
                    title={hasSessionPodcastAudio ? 'Download podcast audio ZIP' : 'No audio tracks in this session'}
                  >
                    {isBusy ? 'Working...' : 'Podcast'}
                  </button>
                  <button
                    style={styles.sessionBtn}
                    onClick={() => handleToggleSessionTracks(session)}
                    disabled={isBusy && !sessionTracks}
                    title="Preview or download saved tracks"
                  >
                    {isTrackExpanded && !sessionTracks && isBusy ? 'Loading...' : isTrackExpanded ? 'Hide' : 'Tracks'}
                  </button>
                  <button
                    style={styles.sessionBtn}
                    onClick={() => handleLoadSession(session)}
                    disabled={isBusy}
                  >
                    {isActive ? 'Loaded' : isBusy ? 'Loading...' : 'Load'}
                  </button>
                  <button
                    style={{ ...styles.sessionBtn, ...styles.deleteBtn }}
                    onClick={() => handleDeleteSession(session.id)}
                    disabled={isBusy}
                  >
                    Delete
                  </button>
                </div>
                {isTrackExpanded && (
                  <div style={styles.sessionTrackList}>
                    {trackError && <div style={styles.libraryTrackError}>{trackError}</div>}
                    {!trackError && !sessionTracks && (
                      <div style={styles.libraryTrackEmpty}>Loading saved tracks...</div>
                    )}
                    {sessionTracks?.map((file) => {
                      const previewable = isPreviewable(file);
                      const fileType = getRecordingFileType(file);
                      const kindLabel = file.kind
                        ? `${file.kind.slice(0, 1).toUpperCase()}${file.kind.slice(1)}`
                        : fileType.split('/')[0] || 'Track';
                      return (
                        <div key={`${file.fileName}-${file.label}`} style={styles.sessionTrackRow}>
                          <div style={styles.sessionTrackInfo}>
                            <div style={styles.sessionTrackTopLine}>
                              <span style={styles.sessionTrackLabel}>{file.label}</span>
                              <span style={styles.sessionTrackMeta}>
                                {kindLabel} | {formatFileSize(file.blob.size)}
                              </span>
                            </div>
                            <div style={styles.sessionTrackName}>{file.fileName}</div>
                          </div>
                          <div style={styles.sessionTrackActions}>
                            <button
                              type="button"
                              style={{
                                ...styles.sessionTrackBtn,
                                ...(!previewable ? styles.sessionTrackBtnDisabled : {}),
                              }}
                              onClick={() => handlePreviewFile(file)}
                              disabled={!previewable}
                              title={previewable ? `Preview ${file.label}` : 'Preview unavailable for this track'}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="5 3 19 12 5 21 5 3" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              style={styles.sessionTrackBtn}
                              onClick={() => handleDownloadSingle(file)}
                              title={`Download ${file.label}`}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 320,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    borderLeft: '1px solid var(--border)',
    height: '100%',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '14px 16px 10px',
    borderBottom: '1px solid var(--border)',
  },
  title: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
  },
  subtitle: {
    fontSize: 11,
    color: 'var(--text-muted)',
    margin: 0,
    marginTop: 2,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 4,
    borderRadius: 6,
    display: 'flex',
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  // Recording Status
  statusCard: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: 16,
    border: '1px solid rgba(239, 68, 68, 0.3)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  statusHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: '#ef4444',
    animation: 'livePulse 1.5s infinite',
  },
  statusLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: '#ef4444',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  timer: {
    fontSize: 32,
    fontWeight: 700,
    fontFamily: 'monospace',
    color: 'var(--text-primary)',
    letterSpacing: '0.02em',
  },
  trackIndicators: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  trackBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 4,
    background: 'rgba(99, 102, 241, 0.15)',
    color: '#818cf8',
  },
  markerComposer: {
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 6,
  },
  markerInput: {
    minWidth: 0,
    height: 34,
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    padding: '0 10px',
    fontSize: 12,
    outline: 'none',
  },
  markerBtn: {
    height: 34,
    borderRadius: 7,
    border: 'none',
    background: '#6366f1',
    color: 'white',
    padding: '0 10px',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  markerTools: {
    background: 'rgba(255,255,255,0.035)',
    borderRadius: 10,
    padding: 10,
    border: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    gap: 8,
  },
  markerToolBtn: {
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-secondary)',
    borderRadius: 7,
    padding: '7px 10px',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
  },
  markerImportOk: {
    flexBasis: '100%',
    color: '#86efac',
    fontSize: 11,
    lineHeight: 1.35,
  },
  markerImportError: {
    flexBasis: '100%',
    color: '#fca5a5',
    fontSize: 11,
    lineHeight: 1.35,
  },
  markerList: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: 10,
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  markerListHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 700,
  },
  markerClearBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    padding: 0,
  },
  markerRow: {
    display: 'grid',
    gridTemplateColumns: '48px 1fr 24px',
    alignItems: 'center',
    gap: 6,
    minHeight: 26,
  },
  markerTime: {
    color: '#a5b4fc',
    fontSize: 10,
    fontWeight: 700,
    fontFamily: 'monospace',
  },
  markerText: {
    minWidth: 0,
    color: 'var(--text-secondary)',
    fontSize: 11,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  markerRemoveBtn: {
    width: 24,
    height: 24,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-muted)',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
    padding: 0,
  },
  readinessCard: {
    background: 'rgba(255,255,255,0.035)',
    borderRadius: 10,
    padding: 10,
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 9,
  },
  readinessHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  readinessTitle: {
    fontSize: 12,
    fontWeight: 800,
    color: 'var(--text-primary)',
  },
  readinessSubtitle: {
    margin: '2px 0 0',
    fontSize: 10,
    color: 'var(--text-muted)',
    lineHeight: 1.35,
  },
  readinessBadge: {
    flexShrink: 0,
    fontSize: 9,
    fontWeight: 800,
    textTransform: 'uppercase',
    borderRadius: 999,
    border: '1px solid',
    padding: '3px 7px',
    letterSpacing: 0,
  },
  readinessBlocking: {
    margin: 0,
    color: '#fca5a5',
    fontSize: 11,
    lineHeight: 1.4,
  },
  readinessTracks: {
    display: 'flex',
    gap: 5,
    flexWrap: 'wrap',
  },
  readinessTrackBadge: {
    maxWidth: '100%',
    fontSize: 10,
    fontWeight: 700,
    padding: '3px 7px',
    borderRadius: 999,
    background: 'rgba(99, 102, 241, 0.14)',
    color: '#c4b5fd',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  readinessItems: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  readinessItem: {
    display: 'grid',
    gridTemplateColumns: '8px 1fr',
    gap: 8,
    alignItems: 'start',
  },
  readinessDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    marginTop: 4,
  },
  readinessItemBody: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  readinessItemTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  readinessItemLabel: {
    minWidth: 0,
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  readinessItemStatus: {
    flexShrink: 0,
    fontSize: 9,
    fontWeight: 800,
    textTransform: 'uppercase',
  },
  readinessItemDetail: {
    margin: 0,
    fontSize: 10,
    color: 'var(--text-muted)',
    lineHeight: 1.35,
  },
  stopBtn: {
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#ef4444',
    color: 'white',
    cursor: 'pointer',
    marginTop: 4,
  },

  // Idle State
  idleCard: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: 24,
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    textAlign: 'center' as const,
  },
  idleText: {
    fontSize: 12,
    color: 'var(--text-muted)',
    lineHeight: 1.5,
    margin: 0,
  },
  startBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#ef4444',
    color: 'white',
    cursor: 'pointer',
  },
  startBtnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },

  // Recorded Files
  recordingSummaryCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    border: '1px solid rgba(34, 197, 94, 0.24)',
    background: 'rgba(34, 197, 94, 0.09)',
  },
  recordingSummaryHeader: {
    display: 'grid',
    gridTemplateColumns: '22px minmax(0, 1fr)',
    gap: 9,
    alignItems: 'start',
  },
  recordingSummaryIcon: {
    width: 22,
    height: 22,
    borderRadius: 999,
    background: 'rgba(34, 197, 94, 0.16)',
    color: '#86efac',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingSummaryCopy: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  recordingSummaryTitle: {
    color: '#bbf7d0',
    fontSize: 13,
    fontWeight: 800,
  },
  recordingSummaryText: {
    margin: 0,
    color: 'var(--text-secondary)',
    fontSize: 12,
    lineHeight: 1.4,
  },
  recordingSummaryStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(82px, 1fr))',
    gap: 6,
  },
  recordingSummaryStat: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '7px 8px',
    borderRadius: 8,
    border: '1px solid rgba(34, 197, 94, 0.16)',
    background: 'rgba(15, 23, 42, 0.24)',
    color: 'var(--text-secondary)',
    fontSize: 9,
    fontWeight: 800,
    textTransform: 'uppercase' as const,
  },
  mediaUploadStatus: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 8,
    border: '1px solid rgba(56, 189, 248, 0.22)',
    background: 'rgba(8, 47, 73, 0.22)',
  },
  mediaUploadStatusError: {
    border: '1px solid rgba(245, 158, 11, 0.24)',
    background: 'rgba(120, 53, 15, 0.16)',
  },
  mediaUploadStatusLabel: {
    flexShrink: 0,
    color: '#7dd3fc',
    fontSize: 10,
    fontWeight: 900,
    textTransform: 'uppercase' as const,
  },
  mediaUploadStatusContent: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 7,
  },
  mediaUploadStatusText: {
    minWidth: 0,
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.35,
    textAlign: 'right' as const,
  },
  mediaUploadStatusErrorText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1.3,
    textAlign: 'right' as const,
  },
  mediaExportActions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 6,
  },
  mediaExportButton: {
    padding: '5px 8px',
    borderRadius: 7,
    border: '1px solid rgba(125, 211, 252, 0.32)',
    background: 'rgba(14, 116, 144, 0.18)',
    color: '#bae6fd',
    fontSize: 10,
    fontWeight: 800,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  exportCodecCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 10,
    borderRadius: 8,
    border: '1px solid rgba(125, 211, 252, 0.2)',
    background: 'rgba(8, 47, 73, 0.16)',
  },
  exportCodecHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  exportCodecTitle: {
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 800,
    textTransform: 'uppercase' as const,
  },
  exportCodecValue: {
    color: '#bae6fd',
    fontSize: 11,
    fontWeight: 900,
  },
  exportCodecToggle: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 6,
  },
  exportCodecButton: {
    minHeight: 30,
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-muted)',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
  },
  exportCodecButtonActive: {
    borderColor: 'rgba(125, 211, 252, 0.45)',
    background: 'rgba(14, 116, 144, 0.22)',
    color: '#bae6fd',
  },
  filesHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  filesTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  filesCount: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  libraryHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  libraryExportBtn: {
    height: 24,
    minWidth: 42,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: '#c7d2fe',
    fontSize: 10,
    fontWeight: 800,
    cursor: 'pointer',
    padding: '0 8px',
  },
  libraryExportBtnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  fileCard: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: '10px 12px',
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  fileHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fileInfo: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
  },
  fileLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  fileSize: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  fileName: {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  fileActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  iconBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  previewCard: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: 10,
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  previewHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  previewTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  previewClose: {
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    fontSize: 11,
    cursor: 'pointer',
    padding: 0,
  },
  previewMedia: {
    width: '100%',
    maxHeight: 170,
    borderRadius: 8,
    background: 'black',
  },

  // Progress
  progressContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  progressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    background: 'var(--bg-surface)',
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: 2,
    background: '#6366f1',
    transition: 'width 0.3s ease',
  },
  progressText: {
    fontSize: 10,
    fontWeight: 600,
    color: '#6366f1',
    minWidth: 30,
    textAlign: 'right' as const,
  },
  uploadedBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10,
    fontWeight: 600,
    color: '#22c55e',
    marginTop: 2,
  },
  driveStatusBadge: {
    fontSize: 10,
    fontWeight: 700,
    color: '#86efac',
    padding: '7px 9px',
    borderRadius: 7,
    border: '1px solid rgba(34, 197, 94, 0.28)',
    background: 'rgba(34, 197, 94, 0.1)',
  },
  errorBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#ef4444',
    marginTop: 2,
  },

  // Actions
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 4,
  },
  captionSidecarNote: {
    padding: '7px 9px',
    borderRadius: 7,
    border: '1px solid rgba(20, 184, 166, 0.26)',
    background: 'rgba(20, 184, 166, 0.1)',
    color: '#99f6e4',
    fontSize: 11,
    fontWeight: 700,
    lineHeight: 1.35,
  },
  downloadAllBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  bundleBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#14b8a6',
    color: 'white',
    cursor: 'pointer',
    transition: 'opacity 0.2s ease',
  },
  podcastBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#8b5cf6',
    color: 'white',
    cursor: 'pointer',
    transition: 'opacity 0.2s ease',
  },
  transcriptBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#0f766e',
    color: 'white',
    cursor: 'pointer',
    transition: 'opacity 0.2s ease',
  },
  transcriptBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 9,
    borderRadius: 8,
    border: '1px solid rgba(20, 184, 166, 0.28)',
    background: 'rgba(20, 184, 166, 0.08)',
  },
  transcriptHeader: {
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 8,
    alignItems: 'center',
  },
  transcriptTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    color: '#ccfbf1',
    fontSize: 11,
    fontWeight: 800,
  },
  transcriptDownloadBtn: {
    height: 26,
    padding: '0 9px',
    borderRadius: 7,
    border: '1px solid rgba(45, 212, 191, 0.42)',
    background: 'rgba(15, 118, 110, 0.28)',
    color: '#ccfbf1',
    fontSize: 10,
    fontWeight: 900,
    cursor: 'pointer',
  },
  transcriptPreview: {
    margin: 0,
    maxHeight: 72,
    overflow: 'hidden',
    color: 'var(--text-secondary)',
    fontSize: 11,
    lineHeight: 1.4,
  },
  driveBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    border: 'none',
    background: '#4285f4',
    color: 'white',
    cursor: 'pointer',
    transition: 'opacity 0.2s ease',
  },
  driveRetentionCard: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: 6,
    padding: '8px 9px',
    borderRadius: 8,
    border: '1px solid rgba(66, 133, 244, 0.24)',
    background: 'rgba(66, 133, 244, 0.08)',
  },
  driveRetentionLabel: {
    fontSize: 10,
    fontWeight: 800,
    color: '#bfdbfe',
    textTransform: 'uppercase' as const,
  },
  driveRetentionSelect: {
    width: '100%',
    minHeight: 32,
    borderRadius: 7,
    border: '1px solid rgba(147, 197, 253, 0.34)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    padding: '0 9px',
    fontSize: 12,
    outline: 'none',
  },
  driveRetentionDescription: {
    fontSize: 10,
    color: '#bfdbfe',
    lineHeight: 1.35,
  },
  driveShareBox: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    borderRadius: 8,
    border: '1px solid rgba(66, 133, 244, 0.32)',
    background: 'rgba(66, 133, 244, 0.09)',
  },
  driveShareText: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 11,
    color: '#bfdbfe',
  },
  driveShareCopyBtn: {
    flexShrink: 0,
    height: 28,
    padding: '0 10px',
    borderRadius: 7,
    border: '1px solid rgba(147, 197, 253, 0.5)',
    background: 'rgba(59, 130, 246, 0.18)',
    color: '#dbeafe',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
  },
  newRecordingBtn: {
    width: '100%',
    padding: '8px 16px',
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    marginTop: 4,
    textDecoration: 'underline',
  },
  librarySection: {
    marginTop: 12,
    paddingTop: 12,
    borderTop: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  libraryDashboard: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(76px, 1fr))',
    gap: 6,
    padding: 8,
    borderRadius: 8,
    border: '1px solid rgba(148, 163, 184, 0.18)',
    background: 'rgba(15, 23, 42, 0.32)',
  },
  libraryStat: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  libraryStatLabel: {
    fontSize: 9,
    fontWeight: 800,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
  },
  libraryStatValue: {
    minWidth: 0,
    fontSize: 12,
    fontWeight: 800,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  libraryDashboardFooter: {
    gridColumn: '1 / -1',
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto auto',
    gap: 6,
    alignItems: 'center',
    paddingTop: 6,
    borderTop: '1px solid rgba(148, 163, 184, 0.14)',
  },
  libraryLatestLabel: {
    fontSize: 9,
    fontWeight: 800,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
  },
  libraryLatestValue: {
    minWidth: 0,
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  libraryEmpty: {
    fontSize: 11,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
    padding: 10,
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  },
  libraryControls: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
  },
  librarySearch: {
    width: '100%',
    height: 34,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    padding: '0 10px',
    fontSize: 12,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  libraryFilterRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(58px, 1fr))',
    gap: 4,
  },
  libraryFilterBtn: {
    minWidth: 0,
    height: 28,
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-muted)',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'pointer',
    padding: '0 4px',
  },
  libraryFilterBtnActive: {
    background: 'rgba(99, 102, 241, 0.16)',
    borderColor: 'rgba(129, 140, 248, 0.5)',
    color: '#c7d2fe',
  },
  sessionCard: {
    background: 'var(--bg-tertiary)',
    borderRadius: 10,
    padding: '10px 12px',
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sessionCardActive: {
    borderColor: 'rgba(99, 102, 241, 0.55)',
    boxShadow: '0 0 0 1px rgba(99, 102, 241, 0.18) inset',
  },
  sessionTop: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  sessionInfo: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  sessionName: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  sessionMeta: {
    fontSize: 10,
    color: 'var(--text-muted)',
    lineHeight: 1.35,
  },
  sessionCloudMeta: {
    fontSize: 10,
    fontWeight: 700,
    color: '#bfdbfe',
    lineHeight: 1.35,
  },
  sessionActions: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(58px, 1fr))',
    gap: 6,
  },
  sessionBtn: {
    minWidth: 0,
    height: 28,
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
  },
  sessionBtnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  sessionTrackList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    paddingTop: 2,
  },
  sessionTrackRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 8,
    alignItems: 'center',
    padding: '8px 9px',
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.07)',
    background: 'rgba(255, 255, 255, 0.035)',
  },
  sessionTrackInfo: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  sessionTrackTopLine: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  sessionTrackLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  sessionTrackMeta: {
    flexShrink: 0,
    fontSize: 9,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
  },
  sessionTrackName: {
    fontSize: 9,
    color: 'var(--text-muted)',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  sessionTrackActions: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
  },
  sessionTrackBtn: {
    width: 26,
    height: 26,
    borderRadius: 6,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  sessionTrackBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  libraryTrackEmpty: {
    fontSize: 10,
    color: 'var(--text-muted)',
    padding: '7px 8px',
    borderRadius: 8,
    background: 'rgba(255,255,255,0.03)',
  },
  libraryTrackError: {
    fontSize: 10,
    fontWeight: 700,
    color: '#fca5a5',
    padding: '7px 8px',
    borderRadius: 8,
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.18)',
  },
  deleteBtn: {
    color: '#ef4444',
    borderColor: 'rgba(239, 68, 68, 0.25)',
  },
};
