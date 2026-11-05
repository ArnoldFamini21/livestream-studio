// Custom sound board pads, kept in this browser's IndexedDB so they survive a
// reload. Files are stored as Blobs (no base64 inflation) in their own
// database, so this store never forces a version bump on other studio stores.

const DB_NAME = 'livestream-studio-sound-board';
const DB_VERSION = 1;
const STORE = 'customSounds';

export interface StoredCustomSound {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  addedAt: string;
  data: Blob;
}

export interface SoundBoardLibrary {
  list(): Promise<StoredCustomSound[]>;
  put(sound: StoredCustomSound): Promise<void>;
  remove(id: string): Promise<void>;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function createSoundBoardLibrary(factory: IDBFactory | undefined = globalThis.indexedDB): SoundBoardLibrary {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('This browser cannot save custom sounds.'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('addedAt', 'addedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open the sound board library.'));
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  };

  return {
    async list() {
      const db = await open();
      const sounds = await requestToPromise(
        db.transaction(STORE, 'readonly').objectStore(STORE).getAll() as IDBRequest<StoredCustomSound[]>
      );
      return sounds.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    },
    async put(sound) {
      const db = await open();
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(sound);
      await transactionDone(transaction);
    },
    async remove(id) {
      const db = await open();
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(id);
      await transactionDone(transaction);
    },
  };
}
