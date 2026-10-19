import { normalizeRecordingCaptureMetadata } from './recordingCaptureMetadata.ts';

export const RECORDING_FOLDER_MANIFEST_NAME = 'recording-manifest.json';

export interface RecordingFolderSaveInput {
  id?: string;
  roomName: string;
  createdAt: string;
  durationSeconds: number | null;
  files: Array<{ label: string; fileName: string; blob: Blob; kind?: string; capture?: unknown }>;
  markers?: Array<{ id: string; label: string; seconds: number; createdAt: string }>;
}

export interface RecordingFolderWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface RecordingFolderFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<RecordingFolderWritable>;
  getFile(): Promise<Blob>;
}

export interface RecordingFolderDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<RecordingFolderDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<RecordingFolderFileHandle>;
  keys(): AsyncIterableIterator<string>;
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
}

export interface RecordingFolderSaveProgress {
  folderName: string;
  fileName: string;
  completedFiles: number;
  totalFiles: number;
  writtenBytes: number;
  totalBytes: number;
}

export interface RecordingFolderSaveResult {
  folderName: string;
  fileCount: number;
  totalBytes: number;
  files: Array<{ fileName: string; label: string; file: Blob }>;
}

export class RecordingFolderSaveError extends Error {
  constructor(message: string, readonly folderName?: string, readonly completedFiles = 0, cause?: unknown) {
    super(message, { cause });
    this.name = 'RecordingFolderSaveError';
  }
}

type FolderPicker = (options: { id: string; mode: 'readwrite' }) => Promise<RecordingFolderDirectoryHandle>;

function getFolderPicker(): FolderPicker | undefined {
  return (globalThis as unknown as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker;
}

export function isRecordingFolderSaveSupported(): boolean {
  return typeof getFolderPicker() === 'function';
}

/** Call from the click handler: the native picker must retain the user gesture. */
export function pickRecordingFolder(): Promise<RecordingFolderDirectoryHandle> {
  const picker = getFolderPicker();
  if (!picker) throw new RecordingFolderSaveError('Folder backup is not supported in this browser.');
  return picker.call(globalThis, { id: 'studio-recording-backups', mode: 'readwrite' });
}

function safeText(value: unknown, fallback: string, maxLength = 200): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\x00-\x1f\x7f]/g, ' ') : '';
  return (text || fallback).slice(0, maxLength);
}

function safeName(value: unknown, fallback: string, maxLength = 160): string {
  let name = typeof value === 'string' ? value.normalize('NFKC') : '';
  name = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, maxLength).replace(/[.\s]+$/g, '');
  if (!name) return fallback;
  if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `recording_${name}`;
  return name;
}

function uniqueFileName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix += 1) candidate = `${stem}-${suffix}${extension}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function isNamedError(error: unknown, name: string): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === name);
}

async function requireWritePermission(parent: RecordingFolderDirectoryHandle): Promise<void> {
  const permission = parent.queryPermission ? await parent.queryPermission({ mode: 'readwrite' }) : 'prompt';
  if (permission === 'granted') return;
  if (permission === 'denied' || (parent.requestPermission && await parent.requestPermission({ mode: 'readwrite' }) !== 'granted')) {
    throw new RecordingFolderSaveError('Write permission for the selected recording backup folder was not granted.');
  }
}

async function createSessionDirectory(parent: RecordingFolderDirectoryHandle, baseName: string) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const folderName = `${baseName}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    try {
      await parent.getDirectoryHandle(folderName);
      continue;
    } catch (error) {
      if (isNamedError(error, 'TypeMismatchError')) continue;
      if (!isNamedError(error, 'NotFoundError')) throw error;
    }
    const directory = await parent.getDirectoryHandle(folderName, { create: true });
    // The native API has no exclusive-create flag. Reject a directory that
    // became occupied between the existence check and creation.
    let occupied = false;
    for await (const _name of directory.keys()) { occupied = true; break; }
    if (!occupied) return { directory, folderName };
  }
  throw new RecordingFolderSaveError('Could not create a new, unused recording backup folder.');
}

async function writeNewFile(directory: RecordingFolderDirectoryHandle, name: string, blob: Blob): Promise<Blob> {
  try {
    await directory.getFileHandle(name);
    throw new RecordingFolderSaveError(`A file named “${name}” already exists; it was not overwritten.`);
  } catch (error) {
    if (isNamedError(error, 'TypeMismatchError')) throw new RecordingFolderSaveError(`“${name}” already exists; it was not overwritten.`);
    if (!isNamedError(error, 'NotFoundError')) throw error;
  }
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    // Native file streams accept a Blob directly, preserving its backing file
    // without assembling the complete recording in an ArrayBuffer or ZIP.
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(error); } catch { /* Keep the original write failure. */ }
    throw error;
  }
  const file = await handle.getFile();
  if (file.size !== blob.size) throw new RecordingFolderSaveError(`Verification failed for “${name}”: expected ${blob.size} bytes, found ${file.size}.`);
  return file;
}

export async function saveRecordingToFolder(
  parent: RecordingFolderDirectoryHandle,
  input: RecordingFolderSaveInput,
  options: { onProgress?: (progress: RecordingFolderSaveProgress) => void } = {},
): Promise<RecordingFolderSaveResult> {
  if (!input || !Array.isArray(input.files) || input.files.length === 0) {
    throw new RecordingFolderSaveError('This recording has no finished files to back up.');
  }
  if (input.files.some((file) => !file || !(file.blob instanceof Blob) || file.blob.size <= 0)) {
    throw new RecordingFolderSaveError('Every recording file must be available and contain recorded data before saving a complete backup.');
  }
  const createdMs = Date.parse(input.createdAt);
  if (!Number.isFinite(createdMs)) throw new RecordingFolderSaveError('The recording creation date is invalid.');
  const createdAt = new Date(createdMs).toISOString();
  const usedNames = new Set([RECORDING_FOLDER_MANIFEST_NAME.toLowerCase()]);
  const files = input.files.map((file, index) => ({
    ...file,
    label: safeText(file.label, `Track ${index + 1}`),
    fileName: uniqueFileName(safeName(file.fileName, `track-${index + 1}`), usedNames),
    capture: normalizeRecordingCaptureMetadata(file.capture),
  }));
  const totalBytes = files.reduce((sum, file) => sum + file.blob.size, 0);
  const roomName = safeText(input.roomName, 'Studio recording');
  const baseName = `${safeName(roomName, 'Studio-recording', 64)}-${createdAt.slice(0, 19).replace(/[T:]/g, '-')}`;
  await requireWritePermission(parent);

  let folderName: string | undefined;
  let completedFiles = 0;
  let writtenBytes = 0;
  try {
    const created = await createSessionDirectory(parent, baseName);
    folderName = created.folderName;
    const savedFiles: RecordingFolderSaveResult['files'] = [];
    const report = (fileName: string) => {
      try { options.onProgress?.({ folderName: created.folderName, fileName, completedFiles, totalFiles: files.length, writtenBytes, totalBytes }); }
      catch { /* Progress observers must not interrupt an explicit backup. */ }
    };
    for (const file of files) {
      const readBack = await writeNewFile(created.directory, file.fileName, file.blob);
      savedFiles.push({ fileName: file.fileName, label: file.label, file: readBack });
      completedFiles += 1;
      writtenBytes += file.blob.size;
      report(file.fileName);
    }
    const manifest = {
      format: 'livestream-studio-recording-backup',
      version: 1,
      status: 'complete',
      recording: {
        ...(input.id ? { id: safeText(input.id, '', 128) } : {}),
        roomName,
        createdAt,
        durationSeconds: typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds) && input.durationSeconds >= 0 ? input.durationSeconds : null,
        markers: (Array.isArray(input.markers) ? input.markers : []).filter((marker) => marker && Number.isFinite(marker.seconds) && marker.seconds >= 0).map((marker) => ({
          id: safeText(marker.id, '', 128), label: safeText(marker.label, 'Marker'), seconds: marker.seconds,
          createdAt: Number.isFinite(Date.parse(marker.createdAt)) ? new Date(marker.createdAt).toISOString() : createdAt,
        })),
      },
      files: files.map((file) => ({
        fileName: file.fileName, label: file.label, bytes: file.blob.size, mimeType: file.blob.type,
        ...(file.kind ? { kind: safeText(file.kind, '', 32) } : {}),
        ...(file.capture ? { capture: file.capture } : {}),
      })),
    };
    await writeNewFile(created.directory, RECORDING_FOLDER_MANIFEST_NAME, new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' }));
    report(RECORDING_FOLDER_MANIFEST_NAME);
    return { folderName, fileCount: files.length, totalBytes, files: savedFiles };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'The selected folder could not be written.';
    throw new RecordingFolderSaveError(
      folderName ? `Backup could not be completed in “${folderName}”. Keep that partial folder; completed files remain there. ${detail}` : `Recording backup could not start. ${detail}`,
      folderName, completedFiles, error,
    );
  }
}
