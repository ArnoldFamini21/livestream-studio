import { createRecordingChunkStore, type RecordingChunkDirectory } from './recordingChunkStore.ts';
import { getRecordingFileExtension } from './recordingMimeTypes.ts';

const ROOT = 'studio-recording-recovery';
const MANIFEST = 'recording.json';
export type RecoveryTrackKind = 'audio' | 'video' | 'screen' | 'program' | 'iso';
export interface RecordingRecoveryMetadata {
  id: string;
  roomName: string;
  label: string;
  kind: RecoveryTrackKind;
  mimeType: string;
  createdAt: string;
  complete: boolean;
  savedToLibrary?: boolean;
}
export interface RecoverableRecording extends RecordingRecoveryMetadata {
  size: number;
  chunkCount: number;
}
interface RecoveryDirectory extends RecordingChunkDirectory {
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<RecoveryDirectory>;
  entries(): AsyncIterableIterator<[string, { kind: string }]>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}
interface RecoveryEnvironment {
  root(): Promise<RecoveryDirectory>;
  lock<T>(name: string, task: (available: boolean) => Promise<T>): Promise<T>;
}
// Also injectable for crash, quota and concurrent-tab regression tests.
export function browserRecoveryEnvironment(): RecoveryEnvironment | undefined {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory || !navigator.locks?.request) return undefined;
  return {
    root: async () => (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true }) as unknown as RecoveryDirectory,
    lock: async (name, task) => await navigator.locks.request(`studio-recovery:${name}`, { ifAvailable: true }, lock => task(Boolean(lock))),
  };
}
const savedBlobs = new WeakMap<Blob, () => Promise<void>>();
const validId = (id: string) => /^take-[a-zA-Z0-9_-]+$/.test(id);
const notify = (report: ((error: unknown) => void) | undefined, error: unknown) => {
  try { report?.(error); } catch { /* Reporting must not stop recording. */ }
};
async function writeManifest(directory: RecoveryDirectory, metadata: RecordingRecoveryMetadata) {
  const file = await directory.getFileHandle(MANIFEST, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(new Blob([JSON.stringify(metadata)]));
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* Failed atomic write. */ }
    throw error;
  }
}
async function readManifest(directory: RecoveryDirectory, id: string): Promise<RecordingRecoveryMetadata> {
  const file = await (await directory.getFileHandle(MANIFEST, { create: false })).getFile();
  if (file.size > 16_384) throw new Error('Invalid recording metadata');
  const m = JSON.parse(await file.text());
  if (m.id !== id || !validId(id) || typeof m.roomName !== 'string' || typeof m.label !== 'string'
    || !['audio', 'video', 'screen', 'program', 'iso'].includes(m.kind)
    || typeof m.mimeType !== 'string' || !/^(audio|video)\//.test(m.mimeType)
    || !Number.isFinite(Date.parse(m.createdAt))) throw new Error('Invalid recording metadata');
  return { ...m, complete: m.complete === true, savedToLibrary: m.savedToLibrary === true };
}
/** Only a contiguous prefix starting with the container header can be recovered. */
export async function readRecoveryChunks(directory: RecoveryDirectory): Promise<{ chunks: Blob[]; truncated: boolean }> {
  const names: string[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === 'file' && /^chunk-\d{6,}\.part$/.test(name)) names.push(name);
  }
  names.sort((a, b) => Number(a.slice(6, -5)) - Number(b.slice(6, -5)));
  const chunks: Blob[] = [];
  for (const name of names) {
    if (Number(name.slice(6, -5)) !== chunks.length) break;
    const blob = await (await directory.getFileHandle(name, { create: false })).getFile();
    if (!blob.size) break; // An interrupted write must never bridge a missing fragment.
    chunks.push(blob);
  }
  return { chunks, truncated: chunks.length !== names.length };
}

/** Capture to committed files, retaining an ordered RAM fallback if storage fails. */
export function createRecoverableRecordingStore(
  input: Pick<RecordingRecoveryMetadata, 'roomName' | 'label' | 'kind' | 'mimeType'>,
  onStorageFailure?: (error: unknown) => void,
  environment = browserRecoveryEnvironment(),
) {
  const metadata: RecordingRecoveryMetadata = {
    ...input, id: `take-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), complete: false,
  };
  let release = () => {};
  let storageFailed = false;
  const fail = (error: unknown) => {
    if (!storageFailed) notify(onStorageFailure, error);
    storageFailed = true;
  };
  let resolveDirectory: (directory: RecoveryDirectory | undefined) => void;
  const directory = new Promise<RecoveryDirectory | undefined>(resolve => { resolveDirectory = resolve; });
  let root: RecoveryDirectory | undefined;
  // Hold the lock for this document’s lifetime: finished Blobs still reference
  // OPFS files during uploads/downloads. Navigation or crashes release it so a
  // later document can recover unsaved footage or clean acknowledged backups.
  const lockFinished = environment ? environment.lock(metadata.id, async available => {
    if (!available) throw new Error('Recording storage is busy');
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      root = await environment.root();
      const target = await root.getDirectoryHandle(metadata.id, { create: true });
      await writeManifest(target, metadata);
      resolveDirectory(target);
      await held;
    } catch (error) {
      fail(error); resolveDirectory(undefined);
    }
  }).catch(error => { fail(error); resolveDirectory(undefined); }) : Promise.resolve().then(() => {
    fail(new Error('Recoverable recording storage is unavailable in this browser.'));
    resolveDirectory(undefined);
  });
  const proxy: RecordingChunkDirectory = {
    async getFileHandle(name, options) {
      const target = await directory;
      if (!target) throw new Error('Recording storage unavailable');
      return target.getFileHandle(name, options);
    },
    async removeEntry(name) { await (await directory)?.removeEntry(name); },
  };
  const store = createRecordingChunkStore(proxy, 'chunk', fail);
  let finishing: Promise<Blob> | undefined;
  return {
    append: store.append,
    flush: store.flush,
    snapshot: (mimeType = input.mimeType): Promise<Blob> => store.snapshot(mimeType),
    finish(mimeType = input.mimeType): Promise<Blob> {
      return finishing ??= (async () => {
        const blob = await store.finish(mimeType);
        const target = await directory;
        if (target) {
          const completed = { ...metadata, complete: !storageFailed };
          try { await writeManifest(target, completed); } catch (error) { fail(error); }
          savedBlobs.set(blob, async () => {
            // Mark, but do not delete: File-backed Blobs become unreadable if
            // their source disappears, even after an IndexedDB copy is saved.
            await writeManifest(target, { ...completed, savedToLibrary: true });
          });
        }
        return blob;
      })();
    },
    async discard() {
      try { await store.discard(); await directory; await root?.removeEntry(metadata.id, { recursive: true }); }
      finally { release(); await lockFinished; }
    },
  };
}

/** Call only after the complete recording has committed to the recording library. */
export async function acknowledgeRecordingBackups(blobs: Blob[]): Promise<void> {
  await Promise.all(blobs.map(async blob => {
    const acknowledge = savedBlobs.get(blob);
    if (!acknowledge) return;
    try { await acknowledge(); savedBlobs.delete(blob); } catch { /* Retain the backup if cleanup fails. */ }
  }));
}

export async function listRecoverableRecordings(environment = browserRecoveryEnvironment()): Promise<RecoverableRecording[]> {
  if (!environment) return [];
  const root = await environment.root();
  const results: RecoverableRecording[] = [];
  for await (const [id, handle] of root.entries()) {
    if (handle.kind !== 'directory' || !validId(id)) continue;
    await environment.lock(id, async available => {
      if (!available) return;
      try {
        const directory = await root.getDirectoryHandle(id, { create: false });
        const metadata = await readManifest(directory, id);
        if (metadata.savedToLibrary) {
          // The capturing document no longer holds its lock or Blob references.
          await root.removeEntry(id, { recursive: true });
          return;
        }
        const { chunks, truncated } = await readRecoveryChunks(directory);
        const size = chunks.reduce((sum, blob) => sum + blob.size, 0);
        if (size) results.push({ ...metadata, complete: metadata.complete && !truncated, size, chunkCount: chunks.length });
      } catch { /* Do not alter unrelated, invalid or already recovered files. */ }
    });
  }
  return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface RecoveredRecordingInput {
  id: string;
  roomName: string;
  createdAt: string;
  files: Array<{ label: string; fileName: string; kind: RecoveryTrackKind; blob: Blob }>;
}
export async function recoverRecording(
  id: string,
  save: (input: RecoveredRecordingInput) => Promise<unknown>,
  environment = browserRecoveryEnvironment(),
): Promise<void> {
  if (!validId(id) || !environment) throw new Error('Recording recovery is unavailable.');
  await environment.lock(id, async available => {
    if (!available) throw new Error('This recording is still in use in another tab. Try again after it finishes.');
    const root = await environment.root();
    const directory = await root.getDirectoryHandle(id, { create: false });
    const metadata = await readManifest(directory, id);
    if (metadata.savedToLibrary) throw new Error('This recording has already been saved to your library.');
    const { chunks } = await readRecoveryChunks(directory);
    if (!chunks.length) throw new Error('No complete recording fragments are available.');
    const blob = new Blob(chunks, { type: metadata.mimeType });
    const label = metadata.label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'Recording';
    await save({
      id: `recovered-${id}`, roomName: `${metadata.roomName} · Recovered`, createdAt: metadata.createdAt,
      files: [{ label: metadata.label, kind: metadata.kind, blob, fileName: `${label}_recovered.${getRecordingFileExtension(blob.type)}` }],
    });
    // Never remove the only copy before the library transaction succeeds.
    try { await root.removeEntry(id, { recursive: true }); } catch { /* Stable recovery id makes retry idempotent. */ }
  });
}
