import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StudioMediaAsset } from '@studio/shared';

import {
  blobToDataUrl,
  dataUrlToBlob,
  fingerprintMediaFile,
  fromStoredPreview,
  getStoredMediaAssetKey,
  isStorableUploadedMediaAsset,
  loadStoredMediaAssets,
  MEDIA_ASSET_STORE_MAX_BYTES,
  mergeRestoredMediaAssets,
  planMediaAssetEviction,
  resolveMediaAssetStoreBudget,
  saveStoredMediaAsset,
  toStoredPreview,
} from '../src/utils/mediaAssetStore.ts';

const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;

function asset(id: string, createdAt: string, extra: Partial<StudioMediaAsset> = {}): StudioMediaAsset {
  return { id, name: id, url: `blob:${id}`, type: 'image', mimeType: 'image/png', createdAt, source: 'upload', ...extra };
}

describe('media asset store', () => {
  it('keeps only finished uploads', () => {
    assert.equal(isStorableUploadedMediaAsset({ source: 'upload', processingStatus: 'ready' }), true);
    assert.equal(isStorableUploadedMediaAsset({ source: 'upload' }), true);
    assert.equal(isStorableUploadedMediaAsset({ source: 'upload', processingStatus: 'processing' }), false);
    assert.equal(isStorableUploadedMediaAsset({ source: 'upload', processingStatus: 'error' }), false);
    assert.equal(isStorableUploadedMediaAsset({ source: 'url', processingStatus: 'ready' }), false);
  });

  it('scopes entries per studio', () => {
    assert.notEqual(getStoredMediaAssetKey('room-a', 'media-1'), getStoredMediaAssetKey('room-b', 'media-1'));
  });

  it('round-trips data URLs through blobs', async () => {
    const blob = dataUrlToBlob(jpegDataUrl);
    assert.equal(blob?.type, 'image/jpeg');
    assert.equal(blob?.size, 8);
    assert.equal(await blobToDataUrl(blob!), jpegDataUrl);
    assert.equal(await dataUrlToBlob('data:text/plain,hello%20there')?.text(), 'hello there');
    assert.equal(dataUrlToBlob('https://example.test/a.png'), undefined);
  });

  it('stores rendered slides as blobs and restores them as data URLs', async () => {
    const { preview, bytes } = toStoredPreview({
      kind: 'presentation-slides',
      sourceFormat: 'pdf',
      slides: [
        { id: 'p1', title: 'Page 1', lines: [], imageUrl: jpegDataUrl, rendered: true, notes: ['hi'] },
        { id: 'p2', title: 'Page 2', lines: ['text'] },
        { id: 'p3', title: 'Page 3', lines: [], imageUrl: 'blob:gone', rendered: true },
      ],
    });
    assert.equal(bytes, 8);
    assert.ok(preview?.slides[0].imageBlob instanceof Blob);
    assert.equal(preview?.slides[0].imageUrl, undefined);
    assert.equal(preview?.slides[2].rendered, false);

    const restored = await fromStoredPreview(preview);
    assert.equal(restored?.slides[0].imageUrl, jpegDataUrl);
    assert.deepEqual(restored?.slides[0].notes, ['hi']);
    assert.equal(restored?.slides[1].imageUrl, undefined);
    assert.equal(restored?.sourceFormat, 'pdf');
  });

  it('fingerprints content, not names', async () => {
    const a = await fingerprintMediaFile(new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }));
    const b = await fingerprintMediaFile(new File([new Uint8Array([1, 2, 3])], 'b.png', { type: 'image/png' }));
    const c = await fingerprintMediaFile(new File([new Uint8Array([1, 2, 4])], 'a.png', { type: 'image/png' }));
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^sha256-[0-9a-f]{64}$/);
  });

  it('never takes more than a quarter of the origin quota', () => {
    assert.equal(resolveMediaAssetStoreBudget(null), MEDIA_ASSET_STORE_MAX_BYTES);
    assert.equal(resolveMediaAssetStoreBudget({ quota: 400 }), 100);
    assert.equal(resolveMediaAssetStoreBudget({ quota: 100 * MEDIA_ASSET_STORE_MAX_BYTES }), MEDIA_ASSET_STORE_MAX_BYTES);
  });

  it('evicts least recently used entries and files nobody uses', () => {
    const files = new Map([['f1', 100], ['f2', 100], ['orphan', 50]]);
    const plan = planMediaAssetEviction([
      { key: 'old', fileHash: 'f1', previewBytes: 10, lastUsedAt: 1 },
      { key: 'shared', fileHash: 'f2', previewBytes: 10, lastUsedAt: 2 },
      { key: 'new', fileHash: 'f2', previewBytes: 10, lastUsedAt: 3 },
    ], files, 115, new Set(['new']));
    // The orphan goes regardless; 'old' frees f1; 'shared' only frees its preview while 'new' still uses f2.
    assert.deepEqual(plan.deleteKeys, ['old', 'shared']);
    assert.deepEqual(plan.deleteFileHashes.sort(), ['f1', 'orphan']);
    assert.equal(plan.totalBytes, 110);
  });

  it('keeps everything that fits', () => {
    const plan = planMediaAssetEviction([{ key: 'a', fileHash: 'f', previewBytes: 5, lastUsedAt: 1 }], new Map([['f', 10]]), 100);
    assert.deepEqual(plan, { deleteKeys: [], deleteFileHashes: [], totalBytes: 15 });
  });

  it('merges restored uploads newest first without duplicating ids', () => {
    const current = [asset('media-3', '2026-01-03T00:00:00Z', { source: 'url' }), asset('media-1', '2026-01-01T00:00:00Z', { source: 'url' })];
    const merged = mergeRestoredMediaAssets(current, [asset('media-2', '2026-01-02T00:00:00Z'), asset('media-3', '2026-01-09T00:00:00Z')]);
    assert.deepEqual(merged.map((item) => item.id), ['media-3', 'media-2', 'media-1']);
    assert.equal(merged[0].source, 'url');
    assert.equal(mergeRestoredMediaAssets(current, []), current);
  });

  it('degrades to no-ops without IndexedDB', async () => {
    assert.deepEqual(await loadStoredMediaAssets('room'), []);
    const result = await saveStoredMediaAsset('room', asset('media-1', '2026-01-01T00:00:00Z'), new Blob(['x']));
    assert.equal(result.saved, false);
  });
});
