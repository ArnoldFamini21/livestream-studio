import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveMedia } from '@studio/shared';

import {
  clampPresentationSlideIndex,
  getNextPresentationSlideIndex,
  getPresentationDeckStatus,
  getPresentationSlidePickerItems,
  getPresentationSlides,
} from '../src/utils/presentationDeckControls.ts';

const deck: ActiveMedia = {
  assetId: 'deck-1',
  type: 'presentation',
  url: 'blob:deck',
  name: 'Launch Deck',
  preview: {
    kind: 'presentation-slides',
    sourceFormat: 'pptx',
    slides: [
      { id: 'slide-1', title: 'Opening', lines: ['Welcome'] },
      { id: 'slide-2', title: 'Agenda', lines: ['Plan'] },
      { id: 'slide-3', title: 'Close', lines: [] },
    ],
  },
};

describe('presentation deck controls', () => {
  it('returns slides only for active presentation decks', () => {
    assert.equal(getPresentationSlides(deck).length, 3);
    assert.deepEqual(getPresentationSlides({ ...deck, type: 'image' }), []);
    assert.deepEqual(getPresentationSlides(null), []);
  });

  it('clamps requested slide indexes inside deck bounds', () => {
    assert.equal(clampPresentationSlideIndex(-1, 3), 0);
    assert.equal(clampPresentationSlideIndex(1.8, 3), 1);
    assert.equal(clampPresentationSlideIndex(99, 3), 2);
    assert.equal(clampPresentationSlideIndex(4, 0), 0);
  });

  it('advances and reverses without crossing deck bounds', () => {
    assert.equal(getNextPresentationSlideIndex(0, 3, 'previous'), 0);
    assert.equal(getNextPresentationSlideIndex(0, 3, 'next'), 1);
    assert.equal(getNextPresentationSlideIndex(2, 3, 'next'), 2);
  });

  it('builds producer-facing deck status with current and next slides', () => {
    const status = getPresentationDeckStatus(deck, 1);

    assert.equal(status.hasDeck, true);
    assert.equal(status.total, 3);
    assert.equal(status.currentIndex, 1);
    assert.equal(status.currentSlide?.title, 'Agenda');
    assert.equal(status.previousSlide?.title, 'Opening');
    assert.equal(status.nextSlide?.title, 'Close');
    assert.equal(status.canGoPrevious, true);
    assert.equal(status.canGoNext, true);
  });

  it('builds slide picker items with fallback titles and current state', () => {
    const items = getPresentationSlidePickerItems([
      { id: 'slide-1', title: 'Opening', lines: [], imageUrl: 'data:image/png;base64,one' },
      { id: 'slide-2', title: '', lines: [] },
    ], 9);

    assert.deepEqual(items.map((item) => ({
      index: item.index,
      label: item.label,
      title: item.title,
      imageUrl: item.imageUrl,
      isCurrent: item.isCurrent,
    })), [
      {
        index: 0,
        label: 'Slide 1',
        title: 'Opening',
        imageUrl: 'data:image/png;base64,one',
        isCurrent: false,
      },
      {
        index: 1,
        label: 'Slide 2',
        title: 'Slide 2',
        imageUrl: undefined,
        isCurrent: true,
      },
    ]);
  });
});
