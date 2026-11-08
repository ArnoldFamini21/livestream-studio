import type { BrandFont } from '@studio/shared';
import { loadCanvasFonts } from './canvasFonts.ts';
import {
  checkBrandFontFile,
  getBrandFontFamilyStack,
  getBrandFontLoadDescriptors,
  getBrandFontPreset,
  getUploadedBrandFontFaceName,
} from './brandFonts.ts';

/**
 * Uploaded brand fonts live in this browser's IndexedDB (they are binary and
 * can be megabytes, too big for brand kit JSON or localStorage). Brand kits
 * only carry the reference; another browser without the file falls back to
 * Inter and says so.
 */

const DB_NAME = 'livestream-studio-brand-fonts';
const STORE = 'fonts';

interface StoredBrandFont {
  id: string;
  family: string;
  fileName: string;
  data: ArrayBuffer;
  savedAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the font store.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error || request.error || new Error('Font store request failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Font store request was aborted.'));
    });
  } finally {
    db.close();
  }
}

export function createBrandFontFileId(): string {
  return `font-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Stores an uploaded font and returns the brand font that references it. Throws with a readable message. */
export async function saveUploadedBrandFont(file: File, id = createBrandFontFileId()): Promise<Extract<BrandFont, { source: 'upload' }>> {
  const check = checkBrandFontFile(file);
  if (!check.ok) throw new Error(check.reason);
  const data = await file.arrayBuffer();
  const font: Extract<BrandFont, { source: 'upload' }> = { source: 'upload', family: check.family, fileId: id, fileName: file.name.slice(0, 120) };
  // Prove the browser can read it before keeping it.
  await registerUploadedFontFace(font, data);
  const record: StoredBrandFont = { id, family: font.family, fileName: font.fileName, data, savedAt: new Date().toISOString() };
  await withStore('readwrite', (store) => store.put(record));
  return font;
}

export async function readUploadedBrandFont(id: string): Promise<StoredBrandFont | null> {
  try {
    const record = await withStore<StoredBrandFont | undefined>('readonly', (store) => store.get(id) as IDBRequest<StoredBrandFont | undefined>);
    return record && record.data ? record : null;
  } catch {
    return null;
  }
}

export async function deleteUploadedBrandFont(id: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(id));
  } catch {
    // Nothing stored, or storage unavailable.
  }
}

const registeredFaces = new Map<string, Promise<void>>();

async function registerUploadedFontFace(font: Extract<BrandFont, { source: 'upload' }>, data: ArrayBuffer): Promise<void> {
  const key = getUploadedBrandFontFaceName(font);
  const existing = registeredFaces.get(key);
  if (existing) return existing;
  const pending = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
      throw new Error('This browser cannot load custom fonts.');
    }
    // A binary source is not fetched, so it needs no font-src origin.
    const face = new FontFace(key, data);
    try {
      await face.load();
    } catch {
      throw new Error('This file is not a font the browser can read.');
    }
    document.fonts.add(face);
  })();
  registeredFaces.set(key, pending);
  pending.catch(() => registeredFaces.delete(key));
  return pending;
}

export type BrandFontLoadResult =
  | { status: 'ready'; family: string }
  | { status: 'missing' | 'error'; family: null; message: string };

/**
 * Makes a brand font drawable: imports a preset's bundled stylesheet or
 * registers an uploaded file, then waits (bounded) on document.fonts.load for
 * the weights the canvas uses. Never throws.
 */
export async function loadBrandFontFaces(font: BrandFont): Promise<BrandFontLoadResult> {
  try {
    if (font.source === 'preset') {
      await getBrandFontPreset(font.presetId).load();
    } else {
      const record = await readUploadedBrandFont(font.fileId);
      if (!record) {
        return { status: 'missing', family: null, message: `${font.fileName || font.family} is not saved in this browser; Inter is used instead.` };
      }
      await registerUploadedFontFace(font, record.data);
    }
    await loadCanvasFonts(getBrandFontLoadDescriptors(font));
    return { status: 'ready', family: getBrandFontFamilyStack(font) };
  } catch (error) {
    return { status: 'error', family: null, message: error instanceof Error ? error.message : 'The brand font could not be loaded.' };
  }
}
