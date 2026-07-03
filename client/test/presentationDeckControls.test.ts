import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActiveMedia } from '@studio/shared';

import {
  clampPresentationSlideIndex,
  getPresentationDeckUnitLabel,
  getPresentationItemDisplayTitle,
  getNextPresentationSlideIndex,
  getPresentationDeckStatus,
  getPresentationPresenterCards,
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
      { id: 'slide-1', title: 'Opening', lines: ['Welcome'], imageUrl: 'data:image/png;base64,one', rendered: true },
      {
        id: 'slide-2',
        title: 'Agenda',
        lines: ['Plan'],
        imageUrl: 'data:image/png;base64,two',
        rendered: true,
        notes: ['Ask the guest to introduce the next segment'],
      },
      { id: 'slide-3', title: 'Close', lines: [], imageUrl: 'data:image/png;base64,three', rendered: true },
    ],
  },
};

describe('presentation deck controls', () => {
  it('returns slides only for active presentation decks', () => {
    assert.equal(getPresentationSlides(deck).length, 3);
    assert.deepEqual(getPresentationSlides({ ...deck, type: 'image' }), []);
    assert.deepEqual(getPresentationSlides(null), []);
  });

  it('ignores text-only PowerPoint previews because they do not preserve the original design', () => {
    const textOnlyDeck: ActiveMedia = {
      ...deck,
      preview: {
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'slide-1', title: 'TRIAD FORMATION', lines: ['Discipleship'] },
        ],
      },
    };

    assert.deepEqual(getPresentationSlides(textOnlyDeck), []);
    assert.equal(getPresentationDeckStatus(textOnlyDeck, 0).hasDeck, false);
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
    assert.equal(status.sourceFormat, 'pptx');
    assert.equal(status.unitLabel, 'Slide');
    assert.equal(status.total, 3);
    assert.equal(status.currentIndex, 1);
    assert.equal(status.currentSlide?.title, 'Agenda');
    assert.deepEqual(status.currentSlide?.notes, ['Ask the guest to introduce the next segment']);
    assert.equal(status.previousSlide?.title, 'Opening');
    assert.equal(status.nextSlide?.title, 'Close');
    assert.equal(status.canGoPrevious, true);
    assert.equal(status.canGoNext, true);
  });

  it('builds presenter monitor cards for current and next slides', () => {
    const status = getPresentationDeckStatus(deck, 1);
    const cards = getPresentationPresenterCards(status);

    assert.deepEqual(cards, [
      {
        kind: 'current',
        label: 'Current Slide',
        index: 1,
        title: 'Agenda',
        imageUrl: 'data:image/png;base64,two',
        notes: ['Ask the guest to introduce the next segment'],
        isEnd: false,
      },
      {
        kind: 'next',
        label: 'Next Slide',
        index: 2,
        title: 'Close',
        imageUrl: 'data:image/png;base64,three',
        notes: [],
        isEnd: false,
      },
    ]);
  });

  it('marks the presenter monitor next card as end of deck', () => {
    const status = getPresentationDeckStatus(deck, 2);
    const cards = getPresentationPresenterCards(status);

    assert.deepEqual(cards[1], {
      kind: 'next',
      label: 'Up Next',
      index: null,
      title: 'End of deck',
      notes: [],
      isEnd: true,
    });
  });

  it('uses page labels for PDF-backed deck previews', () => {
    const pdfDeck: ActiveMedia = {
      ...deck,
      type: 'pdf',
      preview: {
        kind: 'presentation-slides',
        sourceFormat: 'pdf',
        slides: [
          { id: 'page-1', title: '', lines: [], imageUrl: 'data:image/png;base64,page-one', rendered: true },
          { id: 'page-2', title: 'Handout details', lines: [], imageUrl: 'data:image/png;base64,page-two', rendered: true },
        ],
      },
    };
    const status = getPresentationDeckStatus(pdfDeck, 0);
    const items = getPresentationSlidePickerItems(status.slides, status.currentIndex, status.unitLabel);

    assert.equal(getPresentationDeckUnitLabel(status.sourceFormat), 'Page');
    assert.equal(status.unitLabel, 'Page');
    assert.equal(getPresentationItemDisplayTitle(status.currentSlide, status.currentIndex, status.unitLabel), 'Page 1');
    assert.deepEqual(getPresentationPresenterCards(status).map((card) => card.label), ['Current Page', 'Next Page']);
    assert.deepEqual(items.map((item) => item.label), ['Page 1', 'Page 2']);
    assert.equal(items[0].imageUrl, 'data:image/png;base64,page-one');
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
