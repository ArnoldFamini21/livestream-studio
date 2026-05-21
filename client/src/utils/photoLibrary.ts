// Personal photo library backed by IndexedDB. Used by both the stage background
// picker and the virtual webcam background picker.
//
// Images are stored as data URLs so they survive a page reload without needing
// blob URL re-creation. Cap is enforced on insert: 20 photos, 4MB each.

const DB_NAME = 'livestream-studio';
const DB_VERSION = 1;
const STORE = 'photoLibrary';

export const MAX_PHOTOS = 20;
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

export interface LibraryPhoto {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  addedAt: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('addedAt', 'addedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open photo library DB'));
  });
  return dbPromise;
}

function tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function listPhotos(): Promise<LibraryPhoto[]> {
  const store = await tx('readonly');
  const all = await reqToPromise(store.getAll() as IDBRequest<LibraryPhoto[]>);
  return all.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}

export async function addPhoto(file: File): Promise<LibraryPhoto> {
  if (file.size > MAX_PHOTO_BYTES) {
    throw new Error(`Image is too large (max ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB).`);
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files are supported.');
  }

  const existing = await listPhotos();
  if (existing.length >= MAX_PHOTOS) {
    throw new Error(`Library is full (max ${MAX_PHOTOS} photos). Remove one to add a new background.`);
  }

  const dataUrl = await readAsDataUrl(file);
  const { width, height } = await getImageDimensions(dataUrl);

  const photo: LibraryPhoto = {
    id: cryptoRandomId(),
    name: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Background',
    dataUrl,
    width,
    height,
    addedAt: new Date().toISOString(),
  };

  const store = await tx('readwrite');
  await reqToPromise(store.put(photo));
  return photo;
}

export async function removePhoto(id: string): Promise<void> {
  const store = await tx('readwrite');
  await reqToPromise(store.delete(id));
}

export async function getPhoto(id: string): Promise<LibraryPhoto | undefined> {
  const store = await tx('readonly');
  return reqToPromise(store.get(id) as IDBRequest<LibraryPhoto | undefined>);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = src;
  });
}

function cryptoRandomId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
