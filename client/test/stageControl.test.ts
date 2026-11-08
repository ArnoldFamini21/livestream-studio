import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveMedia } from '@studio/shared';
import {
  buildStageControl,
  getStageMediaId,
  getStageRemoteView,
  resolveStageControl,
} from '../src/utils/stageControl.ts';
import { buildStageContent } from '../src/utils/stageMirror.ts';

const deck: ActiveMedia = {
  assetId: 'deck-1',
  type: 'presentation',
  url: 'blob:deck',
  name: 'Sermon deck',
  preview: {
    kind: 'presentation-slides',
    sourceFormat: 'pptx',
    slides: [0, 1, 2, 3].map((index) => ({ id: `s${index}`, index, title: `Slide ${index + 1}`, rendered: true, imageUrl: `data:image/png;base64,AAAA${index}` })),
  },
} as unknown as ActiveMedia;

const clip: ActiveMedia = { assetId: 'clip-1', type: 'video', url: 'blob:clip', name: 'Intro.mp4' };

describe('stage-control on the stage owner', () => {
  it('moves the deck forward, back and to a slide, within bounds', () => {
    assert.deepEqual(resolveStageControl({ action: 'next' }, { media: deck, slideIndex: 1 }), { kind: 'slide', slideIndex: 2 });
    assert.deepEqual(resolveStageControl({ action: 'previous' }, { media: deck, slideIndex: 1 }), { kind: 'slide', slideIndex: 0 });
    assert.deepEqual(resolveStageControl({ action: 'goto', slideIndex: 99 }, { media: deck, slideIndex: 0 }), { kind: 'slide', slideIndex: 3 });
    assert.deepEqual(resolveStageControl({ action: 'next' }, { media: deck, slideIndex: 3 }), { kind: 'ignore', reason: 'unchanged' });
  });

  it('ignores commands for media that is no longer on stage', () => {
    assert.deepEqual(resolveStageControl({ action: 'next', mediaId: 'other-deck' }, { media: deck, slideIndex: 0 }), { kind: 'ignore', reason: 'stale' });
    assert.deepEqual(resolveStageControl({ action: 'clear', mediaId: 'other-deck' }, { media: deck, slideIndex: 0 }), { kind: 'ignore', reason: 'stale' });
    assert.deepEqual(resolveStageControl({ action: 'next' }, { media: null, slideIndex: 0 }), { kind: 'ignore', reason: 'nothing-staged' });
  });

  it('clears any staged media, but only steps through decks', () => {
    assert.deepEqual(resolveStageControl({ action: 'clear', mediaId: 'clip-1' }, { media: clip, slideIndex: 0 }), { kind: 'clear' });
    assert.deepEqual(resolveStageControl({ action: 'next' }, { media: clip, slideIndex: 0 }), { kind: 'ignore', reason: 'no-deck' });
  });

  it('uses the same media id guests are told about', () => {
    assert.equal(getStageMediaId(deck), buildStageContent(deck, {}).media?.id);
    assert.equal(getStageMediaId({ url: '', name: 'Named' }), 'Named');
    assert.equal(getStageMediaId(null), null);
  });
});

describe('co-host remote', () => {
  const content = { media: { id: 'deck-1', type: 'presentation' as const, name: 'Sermon deck', imageId: 'img', slideIndex: 1, slideCount: 4 } };

  it('sends commands for what guests see, slide index only with goto', () => {
    assert.deepEqual(buildStageControl('next', content), { action: 'next', mediaId: 'deck-1' });
    assert.deepEqual(buildStageControl('goto', content, 2.7), { action: 'goto', slideIndex: 2, mediaId: 'deck-1' });
    assert.deepEqual(buildStageControl('next', content, 3), { action: 'next', mediaId: 'deck-1' });
    assert.deepEqual(buildStageControl('clear', null), { action: 'clear' });
  });

  it('shows the host deck position', () => {
    assert.deepEqual(getStageRemoteView(content), { name: 'Sermon deck', slideIndex: 1, slideCount: 4, canPrevious: true, canNext: true });
    assert.deepEqual(getStageRemoteView({ media: { id: 'clip', type: 'video', name: 'Intro.mp4' } }), {
      name: 'Intro.mp4', slideIndex: null, slideCount: null, canPrevious: false, canNext: false,
    });
    assert.equal(getStageRemoteView({ media: null }), null);
    assert.equal(getStageRemoteView(null), null);
  });
});
