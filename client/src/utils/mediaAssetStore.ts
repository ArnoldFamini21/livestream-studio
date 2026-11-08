import type { PresentationSlidePreview, StudioMediaAsset, StudioMediaAssetPreview } from '@studio/shared';

/**
 * Uploaded media (decks, videos, images) and their rendered slide pictures,
 * kept in this browser's IndexedDB so a reload, a crashed tab or a deck
 * prepared the night before comes back without re-uploading or re-rendering.
 *
 * - Files are stored once per content fingerprint and shared by every studio
 *   and asset that uses them.
 * - Each library entry is stored per studio (room id + asset id) with its
 *   rendered slide images as Blobs (smaller than data URLs).
 * - Total size is capped (and never more than a quarter of the origin quota,
 *   so crash-recovery recording chunks always have room). The least recently
 *   used entries are evicted first.
 *
 * Every call degrades to a no-op when IndexedDB is unavailable (private
 * windows, blocked storage): the library then behaves as before.
 */

const DB_NAME = 'livestream-studio-media-assets';
const DB_VERSION = 1;
const FILE_STORE = 'files';
const ASSET_STORE = 'assets';

export const MEDIA_ASSET_STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const MEDIA_ASSET_MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
/** Share of the origin's storage quota this store may use at most. */
export const MEDIA_ASSET_STORE_QUOTA_SHARE = 0.25;
const FINGERPRINT_SAMPLE_BYTES = 2 * 1024 * 1024;

export interface StoredMediaFile {
  hash: string;
  blob: Blob;
  bytes: number;
}

export interface StoredSlide extends Omit<PresentationSlidePreview, 'imageUrl'> {
  /** Rendered slide picture, decoded from its data URL. */
  imageBlob?: Blob;
  /** Kept as-is when the picture was not a data URL. */
  imageUrl?: string;
}

export interface StoredMediaAssetRecord {
  key: string;
  roomId: string;
  assetId: string;
  fileHash: string;
  name: string;
  type: StudioMediaAsset['type'];
  mimeType: string;
  sizeBytes?: number;
  createdAt: string;
  preview?: { kind: StudioMediaAssetPreview['kind']; sourceFormat: StudioMediaAssetPreview['sourceFormat']; slides: StoredSlide[] };
  previewBytes: number;
  lastUsedAt: number;
}

export type SaveStoredMediaAssetResult =
  | { saved: true; evicted: number }
  | { saved: false; reason: 'unavailable' | 'too-large' | 'not-ready' | 'error'; message: string };

export function getStoredMediaAssetKey(roomId: string, assetId: string): string {
  return `${roomId}\u0000${assetId}`;
}

/** Only finished uploads are worth keeping: a URL asset reloads by itself, and a failed or half-prepared one cannot be shown. */
export function isStorableUploadedMediaAsset(asset: Pick<StudioMediaAsset, 'source' | 'processingStatus'>): boolean {
  return asset.source === 'upload' && (asset.processingStatus === undefined || asset.processingStatus === 'ready');
}

export function dataUrlToBlob(dataUrl: string): Blob | undefined {
  const match = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return undefined;
  const mimeType = match[1] || 'application/octet-stream';
  try {
    if (match[3]) {
      const binary = atob(match[4]);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: mimeType });
    }
    return new Blob([decodeURIComponent(match[4])], { type: mimeType });
  } catch {
    return undefined;
  }
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

export function toStoredPreview(preview: StudioMediaAssetPreview | undefined): { preview?: StoredMediaAssetRecord['preview']; bytes: number } {
  if (!preview) return { bytes: 0 };
  let bytes = 0;
  const slides = preview.slides.map((slide): StoredSlide => {
    const { imageUrl, ...rest } = slide;
    if (!imageUrl) return rest;
    if (imageUrl.startsWith('data:')) {
      const imageBlob = dataUrlToBlob(imageUrl);
      if (imageBlob) {
        bytes += imageBlob.size;
        return { ...rest, imageBlob };
      }
    }
    // A blob: URL dies with the page, so it cannot be kept.
    if (imageUrl.startsWith('blob:')) return { ...rest, rendered: false };
    bytes += imageUrl.length;
    return { ...rest, imageUrl };
  });
  return { preview: { kind: preview.kind, sourceFormat: preview.sourceFormat, slides }, bytes };
}

export async function fromStoredPreview(stored: StoredMediaAssetRecord['preview']): Promise<StudioMediaAssetPreview | undefined> {
  if (!stored) return undefined;
  const slides = await Promise.all(stored.slides.map(async (slide): Promise<PresentationSlidePreview> => {
    const { imageBlob, imageUrl, ...rest } = slide;
    if (imageBlob) return { ...rest, imageUrl: await blobToDataUrl(imageBlob) };
    return imageUrl ? { ...rest, imageUrl } : rest;
  }));
  return { kind: stored.kind, sourceFormat: stored.sourceFormat, slides };
}

/**
 * A content fingerprint without reading a whole video into memory: SHA-256 of
 * the size, type and the first and last 2 MB. Falls back to name/size/date
 * when SubtleCrypto is unavailable.
 */
export async function fingerprintMediaFile(file: Blob & { name?: string; lastModified?: number }): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return `meta-${file.size}-${file.lastModified ?? 0}-${(file.name || '').slice(0, 80)}`;
  const head = await file.slice(0, FINGERPRINT_SAMPLE_BYTES).arrayBuffer();
  const tail = file.size > FINGERPRINT_SAMPLE_BYTES * 2
    ? await file.slice(file.size - FINGERPRINT_SAMPLE_BYTES).arrayBuffer()
    : new ArrayBuffer(0);
  const header = new TextEncoder().encode(`${file.size}|${file.type}|`);
  const input = new Uint8Array(header.byteLength + head.byteLength + tail.byteLength);
  input.set(header, 0);
  input.set(new Uint8Array(head), header.byteLength);
  input.set(new Uint8Array(tail), header.byteLength + head.byteLength);
  const digest = new Uint8Array(await subtle.digest('SHA-256', input));
  return `sha256-${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function resolveMediaAssetStoreBudget(estimate?: { quota?: number } | null, cap = MEDIA_ASSET_STORE_MAX_BYTES): number {
  const quota = estimate?.quota;
  if (typeof quota === 'number' && Number.isFinite(quota) && quota > 0) {
    return Math.max(0, Math.min(cap, Math.floor(quota * MEDIA_ASSET_STORE_QUOTA_SHARE)));
  }
  return cap;
}

export interface MediaAssetEvictionPlan {
  deleteKeys: string[];
  deleteFileHashes: string[];
  totalBytes: number;
}

/**
 * Least-recently-used eviction. Files count once however many entries share
 * them; a file goes when its last entry goes. Entries in `keepKeys` stay.
 */
export function planMediaAssetEviction(
  records: Array<Pick<StoredMediaAssetRecord, 'key' | 'fileHash' | 'previewBytes' | 'lastUsedAt'>>,
  fileBytes: ReadonlyMap<string, number>,
  budgetBytes: number,
  keepKeys: ReadonlySet<string> = new Set(),
): MediaAssetEvictionPlan {
  const refs = new Map<string, number>();
  for (const record of records) refs.set(record.fileHash, (refs.get(record.fileHash) || 0) + 1);
  let totalBytes = records.reduce((sum, record) => sum + Math.max(0, record.previewBytes), 0);
  const deleteFileHashes: string[] = [];
  for (const [hash, bytes] of fileBytes) {
    if (refs.has(hash)) totalBytes += bytes;
    else deleteFileHashes.push(hash);
  }

  const deleteKeys: string[] = [];
  const candidates = records
    .filter((record) => !keepKeys.has(record.key))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  for (const record of candidates) {
    if (totalBytes <= budgetBytes) break;
    deleteKeys.push(record.key);
    totalBytes -= Math.max(0, record.previewBytes);
    const remaining = (refs.get(record.fileHash) || 1) - 1;
    refs.set(record.fileHash, remaining);
    if (remaining === 0) {
      totalBytes -= fileBytes.get(record.fileHash) || 0;
      if (fileBytes.has(record.fileHash)) deleteFileHashes.push(record.fileHash);
    }
  }
  return { deleteKeys, deleteFileHashes, totalBytes };
}

/** Library entries come back newest first, the order the library shows them in. */
export function mergeRestoredMediaAssets(current: StudioMediaAsset[], restored: StudioMediaAsset[]): StudioMediaAsset[] {
  const ids = new Set(current.map((asset) => asset.id));
  const additions = restored.filter((asset) => !ids.has(asset.id));
  if (additions.length === 0) return current;
  return [...current, ...additions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

// ---------- IndexedDB ----------

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE, { keyPath: 'hash' });
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        const assets = db.createObjectStore(ASSET_STORE, { keyPath: 'key' });
        assets.createIndex('roomId', 'roomId');
        assets.createIndex('fileHash', 'fileHash');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Could not open the media library store.'));
    request.onblocked = () => reject(new Error('The media library store is busy in another tab.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Media library store request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Media library store transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Media library store transaction was aborted.'));
  });
}

async function readStoreBudget(): Promise<number> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return resolveMediaAssetStoreBudget(estimate);
  } catch {
    return resolveMediaAssetStoreBudget(null);
  }
}

/**
 * Keeps a prepared upload (and its rendered slides) for this studio. Call it
 * once preparation has finished; it never throws.
 */
export async function saveStoredMediaAsset(roomId: string, asset: StudioMediaAsset, file: Blob): Promise<SaveStoredMediaAssetResult> {
  if (!hasIndexedDb()) return { saved: false, reason: 'unavailable', message: 'This browser cannot keep uploads between visits.' };
  if (!isStorableUploadedMediaAsset(asset)) return { saved: false, reason: 'not-ready', message: 'Only prepared uploads are kept.' };
  try {
    const { preview, bytes: previewBytes } = toStoredPreview(asset.preview);
    const budget = await readStoreBudget();
    const entryBytes = file.size + previewBytes;
    if (entryBytes > Math.min(MEDIA_ASSET_MAX_ENTRY_BYTES, budget)) {
      return {
        saved: false,
        reason: 'too-large',
        message: `${asset.name} is too large to keep in this browser. Upload it again after a reload.`,
      };
    }
    const fileHash = await fingerprintMediaFile(file);
    const record: StoredMediaAssetRecord = {
      key: getStoredMediaAssetKey(roomId, asset.id),
      roomId,
      assetId: asset.id,
      fileHash,
      name: asset.name,
      type: asset.type,
      mimeType: asset.mimeType,
      ...(asset.sizeBytes !== undefined ? { sizeBytes: asset.sizeBytes } : {}),
      createdAt: asset.createdAt,
      ...(preview ? { preview } : {}),
      previewBytes,
      lastUsedAt: Date.now(),
    };

    const db = await openDb();
    const transaction = db.transaction([FILE_STORE, ASSET_STORE], 'readwrite');
    const done = transactionDone(transaction);
    const files = transaction.objectStore(FILE_STORE);
    const assets = transaction.objectStore(ASSET_STORE);
    const existingFile = await requestResult(files.get(fileHash) as IDBRequest<StoredMediaFile | undefined>);
    if (!existingFile) files.put({ hash: fileHash, blob: file, bytes: file.size } satisfies StoredMediaFile);
    const previous = await requestResult(assets.get(record.key) as IDBRequest<StoredMediaAssetRecord | undefined>);
    assets.put(record);

    const allRecords = await requestResult(assets.getAll() as IDBRequest<StoredMediaAssetRecord[]>);
    const allFiles = await requestResult(files.getAll() as IDBRequest<StoredMediaFile[]>);
    const plan = planMediaAssetEviction(
      allRecords,
      new Map(allFiles.map((stored) => [stored.hash, stored.bytes])),
      budget,
      new Set([record.key]),
    );
    for (const key of plan.deleteKeys) assets.delete(key);
    for (const hash of plan.deleteFileHashes) files.delete(hash);
    if (previous && previous.fileHash !== fileHash && !plan.deleteFileHashes.includes(previous.fileHash)) {
      const stillUsed = allRecords.some((other) => other.key !== record.key && other.fileHash === previous.fileHash && !plan.deleteKeys.includes(other.key));
      if (!stillUsed) files.delete(previous.fileHash);
    }
    await done;
    return { saved: true, evicted: plan.deleteKeys.length };
  } catch (error) {
    return {
      saved: false,
      reason: 'error',
      message: error instanceof Error ? error.message : 'The upload could not be kept in this browser.',
    };
  }
}

export interface RestoredMediaAsset {
  asset: StudioMediaAsset;
  file: Blob;
}

/**
 * Everything kept for a studio, as library entries with fresh object URLs
 * (the caller owns and revokes them). Marks them as recently used.
 */
export async function loadStoredMediaAssets(
  roomId: string,
  createObjectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): Promise<RestoredMediaAsset[]> {
  if (!hasIndexedDb()) return [];
  try {
    const db = await openDb();
    const transaction = db.transaction([FILE_STORE, ASSET_STORE], 'readwrite');
    const done = transactionDone(transaction);
    const files = transaction.objectStore(FILE_STORE);
    const assets = transaction.objectStore(ASSET_STORE);
    const records = await requestResult(assets.index('roomId').getAll(roomId) as IDBRequest<StoredMediaAssetRecord[]>);
    const found: Array<{ record: StoredMediaAssetRecord; file: StoredMediaFile }> = [];
    const now = Date.now();
    for (const record of records) {
      const file = await requestResult(files.get(record.fileHash) as IDBRequest<StoredMediaFile | undefined>);
      if (!file) {
        assets.delete(record.key);
        continue;
      }
      assets.put({ ...record, lastUsedAt: now });
      found.push({ record, file });
    }
    await done;

    const restored: RestoredMediaAsset[] = [];
    for (const { record, file } of found) {
      const preview = await fromStoredPreview(record.preview);
      restored.push({
        file: file.blob,
        asset: {
          id: record.assetId,
          name: record.name,
          url: createObjectUrl(file.blob),
          type: record.type,
          mimeType: record.mimeType,
          ...(record.sizeBytes !== undefined ? { sizeBytes: record.sizeBytes } : {}),
          createdAt: record.createdAt,
          source: 'upload',
          ...(preview ? { preview } : {}),
          processingStatus: 'ready',
        },
      });
    }
    return restored;
  } catch (error) {
    console.warn('Could not restore uploaded media from this browser:', error);
    return [];
  }
}

/** Forgets one library entry; its file goes too when nothing else uses it. */
export async function deleteStoredMediaAsset(roomId: string, assetId: string): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    const db = await openDb();
    const transaction = db.transaction([FILE_STORE, ASSET_STORE], 'readwrite');
    const done = transactionDone(transaction);
    const assets = transaction.objectStore(ASSET_STORE);
    const key = getStoredMediaAssetKey(roomId, assetId);
    const record = await requestResult(assets.get(key) as IDBRequest<StoredMediaAssetRecord | undefined>);
    if (record) {
      assets.delete(key);
      const users = await requestResult(assets.index('fileHash').getAllKeys(record.fileHash));
      if (users.every((userKey) => userKey === key)) transaction.objectStore(FILE_STORE).delete(record.fileHash);
    }
    await done;
  } catch (error) {
    console.warn('Could not remove uploaded media from this browser:', error);
  }
}
