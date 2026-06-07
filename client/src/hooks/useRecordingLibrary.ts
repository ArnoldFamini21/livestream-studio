import { useCallback, useEffect, useState } from 'react';

const DB_NAME = 'livestream-studio-recording-library';
const DB_VERSION = 1;
const SESSION_STORE = 'sessions';
const FILE_STORE = 'files';

export interface LocalRecordingFileInput {
  label: string;
  blob: Blob;
  fileName: string;
}

export interface LocalRecordingFileMetadata {
  id: string;
  label: string;
  fileName: string;
  size: number;
  type: string;
}

export interface LocalRecordingFileRecord extends LocalRecordingFileMetadata {
  sessionId: string;
  blob: Blob;
}

export interface LocalRecordingMarker {
  id: string;
  label: string;
  seconds: number;
  createdAt: string;
}

export interface LocalRecordingSession {
  id: string;
  roomName: string;
  createdAt: string;
  trackCount: number;
  totalBytes: number;
  durationSeconds: number | null;
  files: LocalRecordingFileMetadata[];
  markers?: LocalRecordingMarker[];
}

interface SaveRecordingSessionInput {
  roomName: string;
  durationSeconds?: number | null;
  files: LocalRecordingFileInput[];
  markers?: LocalRecordingMarker[];
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

function openRecordingDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error('Failed to open recording database'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        const fileStore = db.createObjectStore(FILE_STORE, { keyPath: 'id' });
        fileStore.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function listRecordingSessions(): Promise<LocalRecordingSession[]> {
  const db = await openRecordingDb();
  try {
    const transaction = db.transaction(SESSION_STORE, 'readonly');
    const store = transaction.objectStore(SESSION_STORE);
    const sessions = await requestToPromise<LocalRecordingSession[]>(store.getAll());
    return sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } finally {
    db.close();
  }
}

async function saveRecordingSession(input: SaveRecordingSessionInput): Promise<LocalRecordingSession> {
  const db = await openRecordingDb();
  try {
    const sessionId = makeId('recording');
    const files: LocalRecordingFileMetadata[] = input.files.map((file, index) => ({
      id: `${sessionId}-track-${index + 1}`,
      label: file.label,
      fileName: file.fileName,
      size: file.blob.size,
      type: file.blob.type || 'application/octet-stream',
    }));
    const session: LocalRecordingSession = {
      id: sessionId,
      roomName: input.roomName,
      createdAt: new Date().toISOString(),
      trackCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      durationSeconds: input.durationSeconds ?? null,
      files,
      markers: (input.markers || []).filter((marker) => (
        marker &&
        typeof marker.id === 'string' &&
        typeof marker.label === 'string' &&
        Number.isFinite(marker.seconds) &&
        typeof marker.createdAt === 'string'
      )),
    };

    const transaction = db.transaction([SESSION_STORE, FILE_STORE], 'readwrite');
    transaction.objectStore(SESSION_STORE).put(session);
    const fileStore = transaction.objectStore(FILE_STORE);
    input.files.forEach((file, index) => {
      const metadata = files[index];
      const record: LocalRecordingFileRecord = {
        ...metadata,
        sessionId,
        blob: file.blob,
      };
      fileStore.put(record);
    });
    await transactionDone(transaction);
    return session;
  } finally {
    db.close();
  }
}

async function getRecordingFiles(sessionId: string): Promise<LocalRecordingFileRecord[]> {
  const db = await openRecordingDb();
  try {
    const transaction = db.transaction(FILE_STORE, 'readonly');
    const index = transaction.objectStore(FILE_STORE).index('sessionId');
    const files = await requestToPromise<LocalRecordingFileRecord[]>(index.getAll(IDBKeyRange.only(sessionId)));
    return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  } finally {
    db.close();
  }
}

async function deleteRecordingSession(sessionId: string): Promise<void> {
  const db = await openRecordingDb();
  try {
    const files = await getRecordingFiles(sessionId);
    const transaction = db.transaction([SESSION_STORE, FILE_STORE], 'readwrite');
    transaction.objectStore(SESSION_STORE).delete(sessionId);
    const fileStore = transaction.objectStore(FILE_STORE);
    files.forEach((file) => fileStore.delete(file.id));
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export function useRecordingLibrary() {
  const [sessions, setSessions] = useState<LocalRecordingSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const next = await listRecordingSessions();
      setSessions(next);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load recordings';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSession = useCallback(async (input: SaveRecordingSessionInput) => {
    const session = await saveRecordingSession(input);
    setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    return session;
  }, []);

  const deleteSession = useCallback(async (sessionId: string) => {
    await deleteRecordingSession(sessionId);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
  }, []);

  const loadFiles = useCallback((sessionId: string) => getRecordingFiles(sessionId), []);

  return {
    sessions,
    isLoading,
    error,
    refresh,
    saveSession,
    deleteSession,
    loadFiles,
  };
}
