import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertMediaLibraryCapacity,
  getMediaBatchFailureMessage,
  getMediaFilePreparationError,
  getPersistableMediaAssets,
  normalizeMediaAssetUrl,
} from '../src/utils/mediaPreparation.ts';

describe('media preparation', () => {
  it('accepts direct and signed media URLs without requiring a file extension', () => {
    assert.equal(normalizeMediaAssetUrl(' https://cdn.example.com/clip.mp4?token=abc ', 'video'), 'https://cdn.example.com/clip.mp4?token=abc');
    assert.equal(normalizeMediaAssetUrl('https://cdn.example.com/media?id=42', 'image'), 'https://cdn.example.com/media?id=42');
    assert.equal(normalizeMediaAssetUrl('http://localhost:5173/clip.webm', 'video'), 'http://localhost:5173/clip.webm');
  });
  it('rejects unsupported URL schemes, relative paths, and embedded credentials', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/movie.mp4', '/movie.mp4', 'https://user:secret@example.com/video.mp4']) {
      assert.throws(() => normalizeMediaAssetUrl(url, 'video'), /HTTP|HTTPS/);
    }
  });
  it('explains why video watch pages cannot be played as a media file', () => {
    for (const url of ['https://www.youtube.com/watch?v=123', 'https://youtu.be/123', 'https://player.vimeo.com/video/123']) {
      assert.throws(() => normalizeMediaAssetUrl(url, 'video'), /direct video file link.*share the browser tab/);
    }
    assert.equal(normalizeMediaAssetUrl('https://notyoutube.com/video.mp4', 'video'), 'https://notyoutube.com/video.mp4');
  });
  it('matches the deck renderer limit and provides a Keynote export path', () => {
    assert.equal(getMediaFilePreparationError({ name: 'slides.pdf', size: 50 * 1024 * 1024 }, 'pdf'), undefined);
    assert.match(getMediaFilePreparationError({ name: 'slides.pptx', size: 50 * 1024 * 1024 + 1 }, 'presentation') || '', /50 MB/);
    assert.match(getMediaFilePreparationError({ name: 'talk.KEY', size: 1024 }, 'presentation') || '', /Export.*PDF or PowerPoint/);
    assert.equal(getMediaFilePreparationError({ name: 'movie.mp4', size: 100 * 1024 * 1024 }, 'video'), undefined);
    assert.match(getMediaFilePreparationError({ name: 'empty.png', size: 0 }, 'image') || '', /empty/);
  });
  it('rejects additions that would otherwise silently evict saved media', () => {
    assert.doesNotThrow(() => assertMediaLibraryCapacity(78, 2));
    assert.throws(() => assertMediaLibraryCapacity(78, 3), /2 more files/);
    assert.throws(() => assertMediaLibraryCapacity(80, 1), /library is full/);
  });
  it('reports partial success without suggesting successful files failed', () => {
    const failures = [{ name: 'one.pdf', message: 'Could not render.' }, { name: 'two.key', message: 'Export first.' }];
    assert.equal(getMediaBatchFailureMessage(failures, 3), '1 file added. 2 files need attention. Check the message beside each file.');
    assert.equal(getMediaBatchFailureMessage(failures.slice(0, 1), 2), 'one.pdf: Could not render.');
  });
});

import { probeMediaAsset } from '../src/utils/mediaPreparation.ts';

function createProbeElement() {
  let source = '';
  const element = {
    crossOrigin: '', preload: '', muted: false, naturalWidth: 640, videoWidth: 1280, videoHeight: 720,
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onloadeddata: null as (() => void) | null,
    pauses: 0, loads: 0,
    get src() { return source; },
    set src(value: string) { source = value; },
    removeAttribute() { source = ''; },
    pause() { this.pauses++; },
    load() { this.loads++; },
  };
  return element;
}

describe('media decoding probe', () => {
  it('uses anonymous CORS and cleans up a successfully decoded image', async () => {
    const element = createProbeElement();
    const pending = probeMediaAsset('https://cdn.example.com/image', 'image', { createElement: () => element as unknown as HTMLImageElement });
    assert.equal(element.crossOrigin, 'anonymous');
    element.onload?.();
    await pending;
    assert.equal(element.src, '');
    assert.equal(element.onload, null);
  });
  it('waits for a decoded video frame and releases the temporary player', async () => {
    const element = createProbeElement();
    const pending = probeMediaAsset('blob:clip', 'video', { createElement: () => element as unknown as HTMLVideoElement });
    assert.equal(element.muted, true);
    assert.equal(element.crossOrigin, 'anonymous');
    element.onloadeddata?.();
    await pending;
    assert.equal(element.pauses, 1);
    assert.equal(element.loads, 2);
    assert.equal(element.src, '');
  });
  it('rejects decode/CORS failures and zero-size frames with actionable errors', async () => {
    const element = createProbeElement();
    const pending = probeMediaAsset('https://example.com/blocked.mp4', 'video', { createElement: () => element as unknown as HTMLVideoElement });
    element.onerror?.();
    await assert.rejects(pending, /cross-origin access/);
    const empty = createProbeElement();
    empty.videoWidth = 0;
    const emptyPending = probeMediaAsset('blob:empty', 'video', { createElement: () => empty as unknown as HTMLVideoElement });
    empty.onloadeddata?.();
    await assert.rejects(emptyPending, /no readable picture/);
  });
  it('times out stalled probes and frees their resource', async () => {
    const element = createProbeElement();
    const pending = probeMediaAsset('blob:stalled', 'video', { timeoutMs: 5, createElement: () => element as unknown as HTMLVideoElement });
    await assert.rejects(pending, /too long/);
    assert.equal(element.src, '');
    assert.equal(element.onerror, null);
  });
});

it('does not restore unfinished probes as permanently processing media after reload', () => {
  const base = { id: 'url', name: 'video', url: 'https://cdn.example.com/video.mp4', type: 'video' as const, mimeType: 'video/url', createdAt: '2026-09-06T00:00:00Z', source: 'url' as const };
  const result = getPersistableMediaAssets([
    { ...base, id: 'pending', processingStatus: 'processing' },
    { ...base, id: 'ready', processingStatus: 'ready' },
    { ...base, id: 'failed', processingStatus: 'error' },
    { ...base, id: 'upload', source: 'upload', url: 'blob:local' },
  ]);
  assert.deepEqual(result.map(asset => asset.id), ['ready', 'failed']);
});
