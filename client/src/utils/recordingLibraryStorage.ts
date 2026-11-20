export const RECORDING_DB_NAME = 'livestream-studio-recording-library';
export const RECORDING_SESSION_STORE = 'sessions';
export const RECORDING_FILE_STORE = 'files';
export const RECORDING_TRANSCRIPT_STORE = 'transcript-projects';

/** Shared schema keeps recovery ownership checks safe even before the library opens. */
export function openRecordingDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECORDING_DB_NAME, 2);
    request.onerror = () => reject(request.error || new Error('Failed to open recording database'));
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close other studio tabs to update the recording library.'));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDING_SESSION_STORE)) {
        db.createObjectStore(RECORDING_SESSION_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RECORDING_FILE_STORE)) {
        const store = db.createObjectStore(RECORDING_FILE_STORE, { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains(RECORDING_TRANSCRIPT_STORE)) {
        db.createObjectStore(RECORDING_TRANSCRIPT_STORE);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close();
      else resolve(db);
    };
  });
}

/** Consult committed metadata, without materializing the potentially huge media Blobs. */
export async function isRecordingBackupReferenced(backupId: string): Promise<boolean> {
  const db = await openRecordingDb();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const request = db.transaction(RECORDING_SESSION_STORE, 'readonly').objectStore(RECORDING_SESSION_STORE).openCursor();
      request.onerror = () => reject(request.error || new Error('Failed to check recording ownership'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(false); return; }
        const session = cursor.value as { files?: Array<{ recoveryId?: string }> };
        if (session.files?.some(file => file.recoveryId === backupId)) { resolve(true); return; }
        cursor.continue();
      };
    });
  } finally { db.close(); }
}
