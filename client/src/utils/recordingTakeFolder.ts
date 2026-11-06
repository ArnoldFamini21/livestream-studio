import { safeName, type RecordingFolderDirectoryHandle, type RecordingFolderFileHandle } from './recordingFolderSave.ts';

/**
 * Direct-to-folder recording: every track is written progressively into the
 * host's chosen folder (an external SSD) while it records, organised as
 *
 *   <folder>/<Studio name>/<YYYY-MM-DD HHmm take>/<participant>/<track>.webm
 *
 * Crash safety: browsers stage FileSystemWritableFileStream data in a hidden
 * swap file until close(), so one long-lived writable would lose the whole
 * take on a crash. Instead, footage is committed in small part files
 * (`<track>.webm.parts/000001.part`) that are closed every few seconds, and
 * stitched into the final file when the track ends. A crash leaves at most
 * the last few seconds uncommitted; the parts can be joined by any tool
 * (`cat 0*.part > track.webm`).
 */

export interface TakeFileWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface TakeFileHandle extends RecordingFolderFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<TakeFileWritable>;
}

export interface TakeDirectoryHandle extends RecordingFolderDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<TakeDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<TakeFileHandle>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export const TAKE_MANIFEST_FILE_NAME = 'take-manifest.json';
export const DEFAULT_PART_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PART_MS = 5_000;

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** "2026-11-05 2130 take" in the host's local time. */
export function formatTakeFolderName(date: Date, suffix = 'take'): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())} ${suffix}`;
}

/** Folder or file name segment that keeps non-ASCII names (José, Niño, 王) intact. */
export function recordingPathSegment(value: unknown, fallback: string, maxLength = 80): string {
  return safeName(typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ') : value, fallback, maxLength);
}

function isNamedError(error: unknown, name: string): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name: string }).name === name);
}

async function entryExists(directory: TakeDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (isNamedError(error, 'TypeMismatchError')) return true;
    if (!isNamedError(error, 'NotFoundError')) throw error;
  }
  return false;
}

async function directoryIsEmpty(directory: TakeDirectoryHandle): Promise<boolean> {
  for await (const _name of directory.keys()) return false;
  return true;
}

/** Creates `<base>`, or `<base> 2`, `<base> 3`… so an earlier take is never mixed in. */
async function createFreshDirectory(parent: TakeDirectoryHandle, baseName: string) {
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const name = attempt === 1 ? baseName : `${baseName} ${attempt}`;
    let existing: TakeDirectoryHandle | undefined;
    try {
      existing = await parent.getDirectoryHandle(name);
    } catch (error) {
      if (isNamedError(error, 'TypeMismatchError')) continue;
      if (!isNamedError(error, 'NotFoundError')) throw error;
    }
    if (existing && !(await directoryIsEmpty(existing))) continue;
    const directory = existing || await parent.getDirectoryHandle(name, { create: true });
    return { name, directory };
  }
  throw new Error(`Could not create a new folder for “${baseName}”.`);
}

async function uniqueFileName(directory: TakeDirectoryHandle, fileName: string, reserved: Set<string>): Promise<string> {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = suffix === 1 ? fileName : `${stem} ${suffix}${extension}`;
    const key = candidate.toLowerCase();
    if (reserved.has(key)) continue;
    if (await entryExists(directory, candidate) || await entryExists(directory, `${candidate}.parts`)) continue;
    reserved.add(key);
    return candidate;
  }
  throw new Error(`Could not find a free file name for “${fileName}”.`);
}

async function writeWholeFile(directory: TakeDirectoryHandle, name: string, data: Blob): Promise<Blob> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(error); } catch { /* Keep the original failure. */ }
    throw error;
  }
  const file = await handle.getFile();
  if (file.size !== data.size) throw new Error(`“${name}” was not written completely (${file.size} of ${data.size} bytes).`);
  return file;
}

export interface FolderTrackWriterOptions {
  partBytes?: number;
  partMs?: number;
  now?: () => number;
}

export interface FolderTrackFinishOptions {
  mimeType?: string;
  /** Replaces the first `header.size` bytes (e.g. a WAV header with real sizes). */
  header?: Blob;
}

export class FolderTrackWriteError extends Error {
  constructor(message: string, readonly unwritten: Blob[], cause?: unknown) {
    super(message, { cause });
    this.name = 'FolderTrackWriteError';
  }
}

export interface FolderTrackWriter {
  readonly fileName: string;
  /** Path relative to the chosen recording folder. */
  readonly path: string;
  /** Bytes accepted so far (committed parts plus the buffered tail). */
  acceptedBytes(): number;
  committedBytes(): number;
  /** Queue bytes; commits a part once enough is buffered. Rejects after a failure. */
  append(data: Blob): Promise<void>;
  /** Commit everything buffered now. */
  flush(): Promise<void>;
  snapshot(mimeType?: string): Promise<Blob>;
  /** Stitch the parts into the final file, verify its size and remove the parts. */
  finish(options?: FolderTrackFinishOptions): Promise<Blob>;
  /** Remove the parts and any partial final file. */
  abort(): Promise<void>;
  readonly failed: boolean;
}

export function createFolderTrackWriter(
  directory: TakeDirectoryHandle,
  fileName: string,
  path: string,
  options: FolderTrackWriterOptions = {},
): FolderTrackWriter {
  const partBytes = Math.max(64 * 1024, options.partBytes ?? DEFAULT_PART_BYTES);
  const partMs = Math.max(250, options.partMs ?? DEFAULT_PART_MS);
  const now = options.now ?? (() => Date.now());
  const partsName = `${fileName}.parts`;
  let partsDirectory: Promise<TakeDirectoryHandle> | undefined;
  const committed: Blob[] = [];
  let committedSize = 0;
  let pending: Blob[] = [];
  let pendingSize = 0;
  let firstPendingAt = 0;
  let queue: Promise<void> = Promise.resolve();
  let failure: FolderTrackWriteError | undefined;
  let finished: Promise<Blob> | undefined;
  let aborted = false;

  const getPartsDirectory = () => partsDirectory ??= directory.getDirectoryHandle(partsName, { create: true });

  const commit = () => {
    if (!pendingSize) return queue;
    const batch = pending;
    const batchSize = pendingSize;
    pending = [];
    pendingSize = 0;
    firstPendingAt = 0;
    queue = queue.then(async () => {
      if (failure) { failure.unwritten.push(...batch); return; }
      try {
        const parts = await getPartsDirectory();
        const file = await writeWholeFile(parts, `${String(committed.length + 1).padStart(6, '0')}.part`, new Blob(batch));
        if (file.size !== batchSize) throw new Error('Recording part size mismatch');
        committed.push(file);
        committedSize += file.size;
      } catch (error) {
        failure = new FolderTrackWriteError(
          `Could not write “${path}”: ${error instanceof Error ? error.message : 'the folder is not writable'}`,
          [...batch],
          error,
        );
      }
    });
    return queue;
  };

  const assertWritable = () => {
    if (failure) throw failure;
    if (aborted) throw new Error('This recording file was discarded.');
    if (finished) throw new Error('This recording file is already finished.');
  };

  return {
    fileName,
    path,
    get failed() { return Boolean(failure); },
    acceptedBytes: () => committedSize + pendingSize + (failure ? failure.unwritten.reduce((sum, blob) => sum + blob.size, 0) : 0),
    committedBytes: () => committedSize,
    async append(data) {
      assertWritable();
      if (!data.size) return;
      if (!pendingSize) firstPendingAt = now();
      pending.push(data);
      pendingSize += data.size;
      if (pendingSize >= partBytes || now() - firstPendingAt >= partMs) await commit();
      if (failure) throw failure;
    },
    async flush() {
      await commit();
      if (failure) throw failure;
    },
    async snapshot(mimeType = '') {
      await queue;
      return new Blob([...committed, ...(failure ? failure.unwritten : []), ...pending], { type: mimeType });
    },
    finish(finishOptions = {}) {
      return finished ??= (async () => {
        await commit();
        if (failure) throw failure;
        const header = finishOptions.header;
        const expected = committedSize;
        const pieces: Blob[] = [];
        let skip = header ? Math.min(header.size, expected) : 0;
        if (header && skip) pieces.push(header.slice(0, skip));
        for (const part of committed) {
          if (skip >= part.size) { skip -= part.size; continue; }
          pieces.push(skip ? part.slice(skip) : part);
          skip = 0;
        }
        const handle = await directory.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable({ keepExistingData: false });
        try {
          // Each part is a disk-backed File: the browser streams it, so the
          // take is never assembled in memory.
          for (const piece of pieces) await writable.write(piece);
          await writable.close();
        } catch (error) {
          try { await writable.abort?.(error); } catch { /* Keep the original failure. */ }
          throw new Error(`Could not finish “${path}”; its parts remain in “${partsName}”. ${error instanceof Error ? error.message : ''}`.trim(), { cause: error });
        }
        const file = await handle.getFile();
        if (file.size !== expected) {
          throw new Error(`“${path}” failed its size check (${file.size} of ${expected} bytes); its parts remain in “${partsName}”.`);
        }
        if (committed.length) {
          try { await directory.removeEntry?.(partsName, { recursive: true }); } catch { /* Parts are a harmless leftover. */ }
        }
        return mimeTypeBlob(file, finishOptions.mimeType);
      })();
    },
    async abort() {
      aborted = true;
      pending = [];
      pendingSize = 0;
      await queue.catch(() => {});
      try { await directory.removeEntry?.(partsName, { recursive: true }); } catch { /* Already gone. */ }
    },
  };
}

function mimeTypeBlob(file: Blob, mimeType: string | undefined): Blob {
  // A File read back from disk carries a type inferred from its extension;
  // keep it (a disk-backed File is cheaper than a copy) unless it is empty.
  if (!mimeType || file.type === mimeType || file.type) return file;
  return file.slice(0, file.size, mimeType);
}

export interface TakeFolder {
  /** "<Studio>/<YYYY-MM-DD HHmm take>" relative to the recording folder. */
  readonly path: string;
  readonly studioName: string;
  readonly takeName: string;
  readonly directory: TakeDirectoryHandle;
  createTrackWriter(participantName: string, fileName: string, options?: FolderTrackWriterOptions): Promise<FolderTrackWriter>;
  writeJson(name: string, value: unknown): Promise<void>;
}

export async function openTakeFolder(
  root: TakeDirectoryHandle,
  input: { studioName: string; startedAt: Date; suffix?: string },
): Promise<TakeFolder> {
  const studioName = recordingPathSegment(input.studioName, 'Studio', 64);
  const studio = await root.getDirectoryHandle(studioName, { create: true });
  const take = await createFreshDirectory(studio, formatTakeFolderName(input.startedAt, input.suffix));
  const participantDirectories = new Map<string, Promise<{ name: string; directory: TakeDirectoryHandle }>>();
  const reservedNames = new Map<string, Set<string>>();
  let jsonQueue: Promise<void> = Promise.resolve();

  const participantDirectory = (participantName: string) => {
    const name = recordingPathSegment(participantName, 'Participant', 64);
    const key = name.toLowerCase();
    let entry = participantDirectories.get(key);
    if (!entry) {
      entry = take.directory.getDirectoryHandle(name, { create: true }).then((directory) => ({ name, directory }));
      participantDirectories.set(key, entry);
      entry.catch(() => participantDirectories.delete(key));
    }
    return entry;
  };

  return {
    path: `${studioName}/${take.name}`,
    studioName,
    takeName: take.name,
    directory: take.directory,
    async createTrackWriter(participantName, fileName, options) {
      const { name, directory } = await participantDirectory(participantName);
      const reserved = reservedNames.get(name.toLowerCase()) || new Set<string>();
      reservedNames.set(name.toLowerCase(), reserved);
      const unique = await uniqueFileName(directory, recordingPathSegment(fileName, 'track.webm', 120), reserved);
      return createFolderTrackWriter(directory, unique, `${studioName}/${take.name}/${name}/${unique}`, options);
    },
    writeJson(name, value) {
      // Serialise writes: the manifest is rewritten as tracks arrive.
      const run = jsonQueue.then(() => writeWholeFile(take.directory, name, new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })).then(() => {}));
      jsonQueue = run.catch(() => {});
      return run;
    },
  };
}
