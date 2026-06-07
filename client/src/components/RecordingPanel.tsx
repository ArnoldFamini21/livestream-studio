import { useEffect, useState, useCallback, useMemo } from 'react';
import type { LiveCaptionSegment } from '../hooks/useLiveCaptions';
import type { RecordingResult } from '../hooks/useLocalRecording';
import { useGoogleDriveUpload } from '../hooks/useGoogleDriveUpload';
import { useRecordingLibrary, type LocalRecordingSession } from '../hooks/useRecordingLibrary';

interface RecordingPanelProps {
  isRecording: boolean;
  formattedTime: string;
  recordingTrackLabels?: string[];
  recordingMarkers?: RecordingMarker[];
  onStartRecording: () => void;
  onStopRecording: () => Promise<RecordingResult>;
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

interface RecordedFile {
  label: string;
  blob: Blob;
  fileName: string;
}

interface RecordingBundleFile {
  label: string;
  fileName: string;
  zipPath: string;
  size: number;
  type: string;
}

interface RecordingBundleSource {
  roomName: string;
  sessionId: string | null;
  createdAt: string;
  durationSeconds: number | null;
  files: RecordedFile[];
  captionSegments?: LiveCaptionSegment[];
  captionLanguage?: string;
  markers?: RecordingMarker[];
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

interface ZipEntry {
  path: string;
  blob: Blob;
  modifiedAt?: Date;
}

const ZIP_UINT32_MAX = 0xffffffff;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_ENCODER = new TextEncoder();

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

function isPreviewable(file: RecordedFile): boolean {
  const type = file.blob.type;
  return type.startsWith('video/') || type.startsWith('audio/') || /\.(webm|mp4|mov|ogg|mp3|wav)$/i.test(file.fileName);
}

function getBlobExtension(blob: Blob): string {
  if (blob.type.includes('ogg')) return 'ogg';
  if (blob.type.includes('mp4')) return 'mp4';
  if (blob.type.includes('mpeg') || blob.type.includes('mp3')) return 'mp3';
  if (blob.type.includes('wav')) return 'wav';
  return 'webm';
}

function makeRecordingFileName(roomName: string, label: string, timestamp: string, index: number, blob: Blob): string {
  const roomPrefix = sanitizeFileName(roomName, 'studio');
  const labelPart = sanitizeFileName(label, `track_${index + 1}`);
  return `${roomPrefix}_${String(index + 1).padStart(2, '0')}_${labelPart}_${timestamp}.${getBlobExtension(blob)}`;
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

function makeBundleFileName(roomName: string, createdAt: string): string {
  const roomPrefix = sanitizeFileName(roomName, 'studio');
  const timestamp = createdAt.slice(0, 19).replace(/[:T]/g, '-');
  return `${roomPrefix}_recording_bundle_${timestamp}.zip`;
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

function buildRecordingMarkersCsv(markers: RecordingMarker[]): string {
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

function createRecordingManifest(
  source: RecordingBundleSource,
  files: RecordingBundleFile[],
  exportedAt: string,
  captionFiles: RecordingCaptionFile[],
  markerFiles: RecordingMarkerFile[]
) {
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  const finalCaptionSegments = getFinalCaptionSegments(source.captionSegments);
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
    })),
    ...(finalCaptionSegments.length > 0
      ? {
          captions: {
            language: source.captionLanguage || null,
            languageLabel: getCaptionLanguageLabel(source.captionLanguage),
            segmentCount: finalCaptionSegments.length,
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

async function createRecordingBundle(source: RecordingBundleSource): Promise<Blob> {
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
    type: entry.file.blob.type || 'application/octet-stream',
  }));
  const finalCaptionSegments = getFinalCaptionSegments(source.captionSegments);
  const captionEntries = finalCaptionSegments.length > 0
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
  const manifest = createRecordingManifest(source, manifestFiles, exportedAt, captionFiles, markerFiles);
  const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });

  return createZipBundle([
    { path: 'manifest.json', blob: manifestBlob },
    ...trackEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...captionEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
    ...markerEntries.map((entry) => ({ path: entry.path, blob: entry.blob })),
  ]);
}

export function RecordingPanel({
  isRecording,
  formattedTime,
  recordingTrackLabels = [],
  recordingMarkers = [],
  onStartRecording,
  onStopRecording,
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
  const [isStopping, setIsStopping] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; type: string; label: string } | null>(null);
  const [libraryBusyId, setLibraryBusyId] = useState<string | null>(null);
  const [isBundling, setIsBundling] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [markerLabel, setMarkerLabel] = useState('');

  const {
    authorize,
    uploadFile,
    createFolder,
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
  } = useRecordingLibrary();
  const visibleTrackLabels = recordingTrackLabels.length > 0
    ? recordingTrackLabels
    : ['Audio', 'Video', 'Screen'];
  const finalCaptionCount = getFinalCaptionSegments(captionSegments).length;
  const sortedRecordingMarkers = useMemo(() => getSortedRecordingMarkers(recordingMarkers), [recordingMarkers]);
  const markerCount = sortedRecordingMarkers.length;

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  const handleStop = useCallback(async () => {
    setIsStopping(true);
    try {
      const result = await onStopRecording();
      const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const resultFiles = result.files.length > 0
        ? result.files
        : [
            { label: 'Audio', blob: result.audio },
            { label: 'Video', blob: result.video },
            ...(result.screen ? [{ label: 'Screen', blob: result.screen }] : []),
          ];
      const files: RecordedFile[] = resultFiles
        .filter((file) => file.blob.size > 0)
        .map((file, index) => ({
          label: file.label,
          blob: file.blob,
          fileName: makeRecordingFileName(roomName, file.label, timestamp, index, file.blob),
        }));

      setRecordedFiles(files);
      if (files.length > 0) {
        const session = await saveSession({
          roomName,
          durationSeconds: parseDurationSeconds(formattedTime),
          files,
          markers: sortedRecordingMarkers,
        });
        setActiveSessionId(session.id);
      }
    } catch (err) {
      console.error('Error stopping recording:', err);
    } finally {
      setIsStopping(false);
    }
  }, [formattedTime, onStopRecording, roomName, saveSession, sortedRecordingMarkers]);

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
  }, [formattedTime, markerCount, markerLabel, onAddRecordingMarker]);

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
  }, [activeSessionId, captionLanguage, captionSegments, formattedTime, recordedFiles, roomName, sessions, sortedRecordingMarkers]);

  const handleDownloadSingle = useCallback((file: RecordedFile) => {
    downloadBlob(file.blob, file.fileName);
  }, []);

  const handleUploadToDrive = useCallback(async () => {
    let authorized = isAuthorized;
    if (!authorized) {
      authorized = await authorize();
      if (!authorized) {
        console.error('Google Drive authorization failed');
        return;
      }
    }

    // Create a folder for this recording session
    const date = new Date().toISOString().slice(0, 10);
    const folderName = `${roomName} - ${date}`;
    const folderId = await createFolder(folderName);

    if (!folderId) {
      console.error('Failed to create Google Drive folder');
      return;
    }

    // Upload all files into the folder
    const uploadPromises = recordedFiles.map((file) =>
      uploadFile(file.blob, file.fileName, folderId)
    );

    await Promise.all(uploadPromises);
    console.log('All files uploaded to Google Drive');
  }, [isAuthorized, authorize, createFolder, uploadFile, recordedFiles, roomName]);

  const handleNewRecording = useCallback(() => {
    setRecordedFiles([]);
    setActiveSessionId(null);
    setPreview(null);
    onClearRecordingMarkers?.();
  }, [onClearRecordingMarkers]);

  const handlePreviewFile = useCallback((file: RecordedFile) => {
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return {
        url: URL.createObjectURL(file.blob),
        type: file.blob.type || 'video/webm',
        label: file.label,
      };
    });
  }, []);

  const handleLoadSession = useCallback(async (session: LocalRecordingSession) => {
    setLibraryBusyId(session.id);
    try {
      const files = await loadFiles(session.id);
      setRecordedFiles(files.map((file) => ({
        label: file.label,
        blob: file.blob,
        fileName: file.fileName,
      })));
      setActiveSessionId(session.id);
      setPreview(null);
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

  const handleDownloadSessionBundle = useCallback(async (session: LocalRecordingSession) => {
    setLibraryBusyId(session.id);
    setBundleError(null);
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
        })),
        markers: session.id === activeSessionId ? sortedRecordingMarkers : session.markers,
        ...(session.id === activeSessionId ? { captionSegments, captionLanguage } : {}),
      };
      const bundle = await createRecordingBundle(source);
      downloadBlob(bundle, makeBundleFileName(session.roomName, session.createdAt));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create recording bundle';
      setBundleError(message);
    } finally {
      setLibraryBusyId(null);
    }
  }, [activeSessionId, captionLanguage, captionSegments, loadFiles, sortedRecordingMarkers]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    setLibraryBusyId(sessionId);
    try {
      await deleteSession(sessionId);
      if (activeSessionId === sessionId) {
        setRecordedFiles([]);
        setActiveSessionId(null);
        setPreview(null);
        onClearRecordingMarkers?.();
      }
    } catch (err) {
      console.error('Failed to delete recording session:', err);
    } finally {
      setLibraryBusyId(null);
    }
  }, [activeSessionId, deleteSession, onClearRecordingMarkers]);

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
              style={styles.startBtn}
              onClick={onStartRecording}
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
              {finalCaptionCount > 0 && (
                <div style={styles.captionSidecarNote}>
                  ZIP includes captions as TXT and WebVTT sidecars.
                </div>
              )}
              {markerCount > 0 && (
                <div style={styles.captionSidecarNote}>
                  ZIP includes recording markers as JSON and CSV sidecars.
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
            <span style={styles.filesCount}>{sessions.length} saved</span>
          </div>

          {libraryError && <div style={styles.errorBadge}>{libraryError}</div>}
          {libraryLoading && <div style={styles.libraryEmpty}>Loading saved recordings...</div>}
          {!libraryLoading && sessions.length === 0 && (
            <div style={styles.libraryEmpty}>Saved sessions will appear here after you stop a recording.</div>
          )}

          {sessions.map((session) => {
            const isActive = activeSessionId === session.id;
            const isBusy = libraryBusyId === session.id;
            return (
              <div key={session.id} style={{ ...styles.sessionCard, ...(isActive ? styles.sessionCardActive : {}) }}>
                <div style={styles.sessionTop}>
                  <div style={styles.sessionInfo}>
                    <span style={styles.sessionName}>{session.roomName}</span>
                    <span style={styles.sessionMeta}>
                      {formatDateTime(session.createdAt)} | {formatDuration(session.durationSeconds)} | {session.trackCount} track{session.trackCount === 1 ? '' : 's'} | {session.markers?.length || 0} mark{(session.markers?.length || 0) === 1 ? '' : 's'} | {formatFileSize(session.totalBytes)}
                    </span>
                  </div>
                </div>
                <div style={styles.sessionActions}>
                  <button
                    style={styles.sessionBtn}
                    onClick={() => handleDownloadSessionBundle(session)}
                    disabled={isBusy}
                  >
                    {isBusy ? 'Working...' : 'ZIP'}
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

  // Recorded Files
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
  libraryEmpty: {
    fontSize: 11,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
    padding: 10,
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--border)',
    borderRadius: 8,
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
  sessionActions: {
    display: 'flex',
    gap: 6,
  },
  sessionBtn: {
    flex: 1,
    height: 28,
    borderRadius: 7,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
  },
  deleteBtn: {
    color: '#ef4444',
    borderColor: 'rgba(239, 68, 68, 0.25)',
  },
};
