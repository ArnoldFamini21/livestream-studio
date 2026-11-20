import {
  openRecordingDb,
  RECORDING_SESSION_STORE,
  RECORDING_TRANSCRIPT_STORE,
} from './recordingLibraryStorage.ts';
import type { RecordingTranscriptProject } from './transcriptEditing.ts';

export async function readRecordingTranscriptProject(sessionId: string): Promise<RecordingTranscriptProject | null> {
  const db = await openRecordingDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(RECORDING_TRANSCRIPT_STORE, 'readonly')
        .objectStore(RECORDING_TRANSCRIPT_STORE).get(sessionId);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveRecordingTranscriptProject(sessionId: string, project: RecordingTranscriptProject): Promise<void> {
  const db = await openRecordingDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([RECORDING_SESSION_STORE, RECORDING_TRANSCRIPT_STORE], 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('The saved take is no longer in the library.'));
      const session = transaction.objectStore(RECORDING_SESSION_STORE).getKey(sessionId);
      session.onsuccess = () => {
        if (session.result === undefined) {
          transaction.abort();
          return;
        }
        transaction.objectStore(RECORDING_TRANSCRIPT_STORE).put(project, sessionId);
      };
    });
  } finally {
    db.close();
  }
}
