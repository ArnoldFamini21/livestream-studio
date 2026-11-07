import type { RecordingFolderDirectoryHandle } from './recordingFolderSave.ts';

/**
 * The host's chosen recording folder (usually on an external SSD).
 *
 * A FileSystemDirectoryHandle is structured-cloneable, so it is kept in
 * IndexedDB and re-used on the next visit. Browsers drop the write permission
 * between visits; one click (any user gesture) re-grants it without showing
 * the folder picker again.
 */
export interface RecordingFolderHandleStore {
  get(): Promise<RecordingFolderDirectoryHandle | null>;
  set(handle: RecordingFolderDirectoryHandle): Promise<void>;
  clear(): Promise<void>;
}

export type RecordingFolderStatus = 'unsupported' | 'none' | 'needs-permission' | 'denied' | 'ready';

export const RECORDING_FOLDER_DB_NAME = 'livestream-studio-recording-folder';
const STORE_NAME = 'handles';
const ROOT_KEY = 'recording-root';

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function openFolderDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(RECORDING_FOLDER_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the recording folder settings'));
  });
}

/** IndexedDB-backed store; undefined where IndexedDB is unavailable. */
export function createIndexedDbRecordingFolderStore(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): RecordingFolderHandleStore | undefined {
  if (!factory) return undefined;
  const run = async <T>(mode: IDBTransactionMode, task: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await openFolderDb(factory);
    try {
      return await promisify(task(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
    } finally { db.close(); }
  };
  return {
    async get() {
      const value = await run('readonly', (store) => store.get(ROOT_KEY));
      return isDirectoryHandle(value) ? value : null;
    },
    async set(handle) { await run('readwrite', (store) => store.put(handle, ROOT_KEY)); },
    async clear() { await run('readwrite', (store) => store.delete(ROOT_KEY)); },
  };
}

function isDirectoryHandle(value: unknown): value is RecordingFolderDirectoryHandle {
  return Boolean(value && typeof value === 'object'
    && typeof (value as RecordingFolderDirectoryHandle).getDirectoryHandle === 'function'
    && typeof (value as RecordingFolderDirectoryHandle).getFileHandle === 'function');
}

export function isDirectRecordingFolderSupported(scope: unknown = globalThis): boolean {
  return typeof (scope as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function getRecordingFolderStatus(handle: RecordingFolderDirectoryHandle | null): Promise<RecordingFolderStatus> {
  if (!handle) return 'none';
  if (!handle.queryPermission) return 'ready';
  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') return 'ready';
    return permission === 'denied' ? 'denied' : 'needs-permission';
  } catch {
    return 'needs-permission';
  }
}

/**
 * Re-grant write access. Must run inside a click handler (before any other
 * await that could lose the user activation) when the status is not ready.
 */
export async function ensureRecordingFolderAccess(handle: RecordingFolderDirectoryHandle): Promise<boolean> {
  const status = await getRecordingFolderStatus(handle);
  if (status === 'ready') return true;
  if (!handle.requestPermission) return false;
  try {
    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  } catch {
    return false;
  }
}

/** Confirms the folder still exists and is writable (e.g. the SSD is still plugged in). */
export async function probeRecordingFolder(handle: RecordingFolderDirectoryHandle): Promise<void> {
  // Iterating the folder fails with NotFoundError when the drive is gone.
  for await (const _name of handle.keys()) break;
}

interface PersistableStorage {
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
}

function getStorageManager(): PersistableStorage | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.storage as PersistableStorage | undefined;
}

export interface PersistentStorageResult {
  supported: boolean;
  persisted: boolean;
}

/**
 * Ask the browser not to evict recording backups (OPFS and the recording
 * library) under storage pressure. Chrome grants this silently for engaged
 * sites; Firefox may ask; Safari decides on its own.
 */
export async function requestPersistentRecordingStorage(storage: PersistableStorage | undefined = getStorageManager()): Promise<PersistentStorageResult> {
  if (!storage?.persist) return { supported: false, persisted: false };
  try {
    if (storage.persisted && await storage.persisted()) return { supported: true, persisted: true };
    return { supported: true, persisted: await storage.persist() };
  } catch {
    return { supported: true, persisted: false };
  }
}

export type RecordingStorageHeadroomStatus = 'ok' | 'warning' | 'critical' | 'unknown';

export interface RecordingStorageHeadroom {
  status: RecordingStorageHeadroomStatus;
  /** Minutes the browser's own storage can hold at the planned rate, when known. */
  minutesAvailable: number | null;
  message: string;
}

export const RECORDING_HEADROOM_WARNING_MINUTES = 120;
export const RECORDING_HEADROOM_CRITICAL_MINUTES = 10;

/**
 * Quota preflight for a take that is written to browser storage. When a
 * recording folder is connected, footage bypasses browser storage, so the
 * browser quota does not limit the take.
 */
export function assessRecordingStorageHeadroom(input: {
  estimate: { quota?: number; usage?: number } | null | undefined;
  bitsPerSecond: number;
  folderConnected: boolean;
}): RecordingStorageHeadroom {
  if (input.folderConnected) {
    return { status: 'ok', minutesAvailable: null, message: 'Recording straight to your folder. Keep enough free space on that drive.' };
  }
  const quota = input.estimate?.quota;
  const usage = input.estimate?.usage ?? 0;
  if (!Number.isFinite(quota) || !quota || !(input.bitsPerSecond > 0)) {
    return { status: 'unknown', minutesAvailable: null, message: 'This browser does not report how much recording space is left.' };
  }
  const freeBytes = Math.max(0, quota - usage);
  const minutesAvailable = Math.floor(freeBytes / (input.bitsPerSecond / 8) / 60);
  if (minutesAvailable < RECORDING_HEADROOM_CRITICAL_MINUTES) {
    return {
      status: 'critical',
      minutesAvailable,
      message: `Browser storage has room for only about ${minutesAvailable} min of recording. Connect a recording folder or free up disk space.`,
    };
  }
  if (minutesAvailable < RECORDING_HEADROOM_WARNING_MINUTES) {
    return {
      status: 'warning',
      minutesAvailable,
      message: `Browser storage has room for about ${formatMinutes(minutesAvailable)} of recording. Connect a recording folder for longer takes.`,
    };
  }
  return { status: 'ok', minutesAvailable, message: `Browser storage has room for about ${formatMinutes(minutesAvailable)} of recording.` };
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export async function estimateRecordingStorage(storage: PersistableStorage | undefined = getStorageManager()) {
  try {
    return storage?.estimate ? await storage.estimate() : null;
  } catch {
    return null;
  }
}
