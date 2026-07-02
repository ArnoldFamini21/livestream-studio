import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SUPPORTED_MEDIA_ACCEPT,
  canPlayMediaAsset,
  detectMediaType,
  getMediaTabForType,
} from '../src/components/MediaLibrary.tsx';

describe('media library upload support', () => {
  it('allows presentation and document files from the shared upload picker', () => {
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.pdf/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.ppt/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.pptx/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.ppsx/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.potx/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /video\/\*/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /image\/\*/);
  });

  it('detects PowerPoint and PDF files by extension and MIME type', () => {
    assert.equal(detectMediaType({ name: 'Distinct But Not Distant.pdf', type: '' } as File), 'pdf');
    assert.equal(detectMediaType({ name: 'Discipleship-Via-Triads.pptx', type: '' } as File), 'presentation');
    assert.equal(detectMediaType({ name: 'legacy-sermon.ppt', type: 'application/vnd.ms-powerpoint' } as File), 'presentation');
    assert.equal(detectMediaType({ name: 'slides.ppsx', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' } as File), 'presentation');
    assert.equal(detectMediaType({ name: 'template.potx', type: 'application/vnd.openxmlformats-officedocument.presentationml.template' } as File), 'presentation');
  });

  it('routes PDF and PowerPoint uploads to the Slides tab', () => {
    assert.equal(getMediaTabForType('pdf'), 'slides');
    assert.equal(getMediaTabForType('presentation'), 'slides');
    assert.equal(getMediaTabForType('video'), 'videos');
    assert.equal(getMediaTabForType('image'), 'images');
    assert.equal(getMediaTabForType('file'), 'files');
  });

  it('requires uploaded decks to have rendered slide previews before playback', () => {
    assert.equal(canPlayMediaAsset({
      id: 'deck-1',
      name: 'Discipleship-Via-Triads.pptx',
      url: 'blob:deck',
      type: 'presentation',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'upload',
      createdAt: '2026-07-02T05:56:32.000Z',
    }), false);

    assert.equal(canPlayMediaAsset({
      id: 'deck-2',
      name: 'Distinct But Not Distant.pptx',
      url: 'blob:deck',
      type: 'presentation',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'upload',
      createdAt: '2026-07-02T05:56:32.000Z',
      preview: {
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'slide-1', title: 'Slide 1', lines: [], imageUrl: 'data:image/png;base64,rendered' },
        ],
      },
    }), true);

    assert.equal(canPlayMediaAsset({
      id: 'deck-3',
      name: 'Failed deck.pptx',
      url: 'blob:deck',
      type: 'presentation',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'upload',
      createdAt: '2026-07-02T05:56:32.000Z',
      processingStatus: 'error',
      processingMessage: 'PowerPoint design could not be rendered.',
    }), false);
  });
});
