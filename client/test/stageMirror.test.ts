import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveMedia } from '@studio/shared';
import {
  buildStageContent,
  fitWithin,
  getStageMirrorSource,
  getStageMirrorSourceKey,
  stageContentToActiveMedia,
} from '../src/utils/stageMirror.ts';

const slide = (id: string) => ({ id, title: id, lines: [], imageUrl: `data:image/jpeg;base64,${id}`, rendered: true });
const deck: ActiveMedia = {
  assetId: 'deck-1',
  type: 'pdf',
  url: 'blob:deck',
  name: 'His Purpose',
  preview: { kind: 'presentation-slides', sourceFormat: 'pdf', slides: [slide('a'), slide('b'), slide('c')] },
};

describe('stage mirror', () => {
  it('shrinks pictures to fit 720p without enlarging small ones', () => {
    assert.deepEqual(fitWithin(1920, 1080, 1280, 720), { width: 1280, height: 720 });
    assert.deepEqual(fitWithin(1080, 1920, 1280, 720), { width: 405, height: 720 });
    assert.deepEqual(fitWithin(640, 360, 1280, 720), { width: 640, height: 360 });
  });

  it('picks the current slide of a deck, clamped to the deck', () => {
    assert.deepEqual(getStageMirrorSource(deck, 1), { source: 'data:image/jpeg;base64,b', slideIndex: 1, slideCount: 3 });
    assert.equal(getStageMirrorSource(deck, 9).slideIndex, 2);
  });

  it('uses the image itself for images and nothing for videos', () => {
    assert.equal(getStageMirrorSource({ type: 'image', url: 'blob:img', name: 'Photo' }, 0).source, 'blob:img');
    assert.equal(getStageMirrorSource({ type: 'video', url: 'blob:vid', name: 'Clip' }, 0).source, undefined);
  });

  it('keys pictures by media and content without storing whole data URLs', () => {
    const long = `data:image/jpeg;base64,${'x'.repeat(100_000)}`;
    assert.ok(getStageMirrorSourceKey('deck-1', long).length < 200);
    assert.notEqual(getStageMirrorSourceKey('deck-1', `${long}a`), getStageMirrorSourceKey('deck-1', `${long}b`));
  });

  it('builds the message guests receive', () => {
    assert.deepEqual(buildStageContent(null, {}), { media: null });
    assert.deepEqual(buildStageContent(deck, { imageId: 'img-1', slideIndex: 1, slideCount: 3, layout: 'grid' }), {
      media: { id: 'deck-1', type: 'pdf', name: 'His Purpose', imageId: 'img-1', slideIndex: 1, slideCount: 3 },
      layout: 'grid',
    });
  });

  it('shows guests the uploaded picture, or the file name when there is none', () => {
    const withImage = stageContentToActiveMedia({ media: { id: 'deck-1', type: 'pdf', name: 'His Purpose', imageId: 'img-1' } }, 'room1');
    assert.equal(withImage?.type, 'image');
    assert.match(withImage?.url || '', /\/api\/rooms\/room1\/stage-images\/img-1$/);
    const video = stageContentToActiveMedia({ media: { id: 'v', type: 'video', name: 'Clip' } }, 'room1');
    assert.deepEqual(video, { assetId: 'v', type: 'file', url: '', name: 'Clip' });
    assert.equal(stageContentToActiveMedia({ media: { id: 'p', type: 'pdf', name: 'Deck' } }, 'room1')?.type, 'file');
    assert.equal(stageContentToActiveMedia({ media: null }, 'room1'), null);
  });
});
