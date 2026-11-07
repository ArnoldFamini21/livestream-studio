import { createIndexedDbRecordingFolderStore, ensureRecordingFolderAccess, type RecordingFolderHandleStore } from './recordingFolderStore.ts';
import { recordingPathSegment } from './recordingTakeFolder.ts';

/**
 * Where an in-browser render is written, in order of preference:
 *
 * 1. The host's recording folder (the external SSD), under
 *    `<Studio>/Exports/`, streamed straight to disk.
 * 2. A folder the host picks now (browsers with the File System Access API
 *    but no remembered recording folder), also streamed to disk.
 * 3. The browser's private file system (OPFS), streamed to disk and then
 *    downloaded, for browsers without folder access.
 * 4. Memory, then downloaded. Only for short renders; the caller is told.
 *
 * Open it at the start of the click handler: asking for folder permission or
 * showing a picker needs the user's click.
 */

export const EXPORTS_FOLDER_NAME = 'Exports';
/** Without disk-backed output, renders past this are refused rather than risking the tab. */
export const MAX_IN_MEMORY_RENDER_BYTES = 1.5 * 1024 * 1024 * 1024;

export interface PositionedWriteChunk {
  type: 'write';
  data: Uint8Array;
  position: number;
}

export interface RenderOutputFile {
  /** Disk-backed output; null means the render must be buffered in memory. */
  writable: WritableStream<PositionedWriteChunk> | null;
  /** After a successful render: where it went and, for browser storage or memory, the file to download. */
  complete(buffer?: ArrayBuffer | null): Promise<{ savedTo: string; download?: Blob }>;
  /** After a failed or cancelled render: removes the partial file. */
  discard(): Promise<void>;
}

export interface RenderOutputFolder {
  kind: 'recording-folder' | 'picked-folder' | 'browser-storage' | 'memory';
  /** "SSD folder/Studio/Exports" and similar, for the status line. */
  label: string;
  createFile(fileName: string, mimeType: string): Promise<RenderOutputFile>;
}

interface WritableFileHandle {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableStream<PositionedWriteChunk>>;
  getFile(): Promise<File>;
}

interface WritableDirectoryHandle {
  name?: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<WritableDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WritableFileHandle>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export function splitFileName(fileName: string): { stem: string; extension: string } {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? { stem: fileName.slice(0, dot), extension: fileName.slice(dot) } : { stem: fileName, extension: '' };
}

/** "name.mp4", then "name (2).mp4", … so an earlier export is never overwritten. */
export async function findFreeFileName(exists: (name: string) => Promise<boolean>, fileName: string, maxAttempts = 50): Promise<string> {
  const { stem, extension } = splitFileName(fileName);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = attempt === 1 ? fileName : `${stem} (${attempt})${extension}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${extension}`;
}

async function fileExists(directory: WritableDirectoryHandle, name: string): Promise<boolean> {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

function directoryOutput(
  kind: RenderOutputFolder['kind'],
  label: string,
  directory: WritableDirectoryHandle,
  downloadAfter: boolean,
): RenderOutputFolder {
  return {
    kind,
    label,
    async createFile(fileName) {
      const name = await findFreeFileName((candidate) => fileExists(directory, candidate), fileName);
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable({ keepExistingData: false });
      return {
        writable,
        async complete() {
          if (!downloadAfter) return { savedTo: `${label}/${name}` };
          const file = await handle.getFile();
          return { savedTo: name, download: file };
        },
        async discard() {
          await writable.abort().catch(() => {});
          await directory.removeEntry?.(name).catch(() => {});
        },
      };
    },
  };
}

function memoryOutput(): RenderOutputFolder {
  return {
    kind: 'memory',
    label: 'Downloads',
    async createFile(fileName, mimeType) {
      return {
        writable: null,
        async complete(buffer) {
          if (!buffer) throw new Error('The render produced no file.');
          return { savedTo: fileName, download: new Blob([buffer], { type: mimeType }) };
        },
        async discard() {},
      };
    },
  };
}

type DirectoryPicker = (options: { id: string; mode: 'readwrite' }) => Promise<WritableDirectoryHandle>;

export interface OpenRenderOutputOptions {
  studioName: string;
  store?: RecordingFolderHandleStore;
  scope?: unknown;
}

export async function openRenderOutputFolder(options: OpenRenderOutputOptions): Promise<RenderOutputFolder> {
  const scope = (options.scope ?? globalThis) as {
    showDirectoryPicker?: DirectoryPicker;
    navigator?: { storage?: { getDirectory?: () => Promise<WritableDirectoryHandle> } };
  };
  const studioFolder = recordingPathSegment(options.studioName, 'Studio', 64);

  // 1. The remembered recording folder, if it is still there and writable.
  const store = options.store ?? createIndexedDbRecordingFolderStore();
  const stored = await store?.get().catch(() => null);
  if (stored && await ensureRecordingFolderAccess(stored)) {
    // A real FileSystemDirectoryHandle: its writables take positioned writes.
    const root = stored as unknown as WritableDirectoryHandle;
    try {
      const studio = await root.getDirectoryHandle(studioFolder, { create: true });
      const exports = await studio.getDirectoryHandle(EXPORTS_FOLDER_NAME, { create: true });
      const rootName = root.name || 'Recording folder';
      return directoryOutput('recording-folder', `${rootName}/${studioFolder}/${EXPORTS_FOLDER_NAME}`, exports, false);
    } catch {
      // The drive was unplugged; fall through to the other options.
    }
  }

  // 2. Let the host choose a folder (one picker for every track).
  if (typeof scope.showDirectoryPicker === 'function') {
    try {
      const picked = await scope.showDirectoryPicker.call(scope, { id: 'studio-cleaned-exports', mode: 'readwrite' });
      return directoryOutput('picked-folder', picked.name || 'Chosen folder', picked, false);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
    }
  }

  // 3. Browser storage, streamed to disk, then downloaded.
  const getDirectory = scope.navigator?.storage?.getDirectory;
  if (typeof getDirectory === 'function') {
    try {
      const opfs = await getDirectory.call(scope.navigator?.storage);
      // Earlier renders were downloaded already; do not let them pile up.
      await opfs.removeEntry?.('studio-cleaned-exports', { recursive: true }).catch(() => {});
      const exports = await opfs.getDirectoryHandle('studio-cleaned-exports', { create: true });
      const probe = await exports.getFileHandle('.probe', { create: true });
      if (typeof probe.createWritable === 'function') {
        await exports.removeEntry?.('.probe').catch(() => {});
        return directoryOutput('browser-storage', 'Downloads', exports, true);
      }
    } catch {
      // No writable OPFS here.
    }
  }

  return memoryOutput();
}
