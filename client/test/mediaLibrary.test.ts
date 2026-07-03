import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SUPPORTED_MEDIA_ACCEPT,
  canPlayMediaAsset,
  detectMediaType,
  getDeckUploadBlockMessage,
  getMediaAssetStatusLabel,
  getMediaTabForType,
  hasDeckFiles,
  hasDeckFilesRequiringMediaServer,
} from '../src/components/MediaLibrary.tsx';
import { canBrowserRenderPowerPointFile } from '../src/utils/presentationPreview.ts';

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

  it('detects deck files for media-server upload preflight without blocking normal media', () => {
    assert.equal(hasDeckFiles([
      { name: 'clip.mp4', type: 'video/mp4' } as File,
      { name: 'still.png', type: 'image/png' } as File,
    ]), false);

    assert.equal(hasDeckFiles([
      { name: 'clip.mp4', type: 'video/mp4' } as File,
      { name: 'Discipleship-Via-Triads.pptx', type: '' } as File,
    ]), true);

    assert.equal(hasDeckFiles([
      { name: 'Distinct But Not Distant.pdf', type: 'application/pdf' } as File,
    ]), true);
  });

  it('requires the media-server only for deck formats that cannot render visually in the browser', () => {
    assert.equal(hasDeckFilesRequiringMediaServer([
      { name: 'Distinct But Not Distant.pdf', type: 'application/pdf' } as File,
    ]), false);
    assert.equal(hasDeckFilesRequiringMediaServer([
      { name: 'Discipleship-Via-Triads.pptx', type: '' } as File,
    ]), false);
    assert.equal(hasDeckFilesRequiringMediaServer([
      { name: 'slides.ppsx', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' } as File,
    ]), false);
    assert.equal(hasDeckFilesRequiringMediaServer([
      { name: 'template.potx', type: 'application/vnd.openxmlformats-officedocument.presentationml.template' } as File,
    ]), false);
    assert.equal(hasDeckFilesRequiringMediaServer([
      { name: 'legacy-sermon.ppt', type: 'application/vnd.ms-powerpoint' } as File,
    ]), true);
    assert.equal(hasDeckFilesRequiringMediaServer([
      { name: 'keynote-message.key', type: '' } as File,
    ]), true);

    assert.equal(canBrowserRenderPowerPointFile({ name: 'message.pptx', type: '' } as File), true);
    assert.equal(canBrowserRenderPowerPointFile({ name: 'legacy-message.ppt', type: 'application/vnd.ms-powerpoint' } as File), false);
  });

  it('warns when exact deck rendering is not ready and explains which decks need the media-server', () => {
    assert.match(getDeckUploadBlockMessage(null), /preserve the original design/);
    assert.match(
      getDeckUploadBlockMessage({ status: 'ready', message: 'Ready' }),
      /Legacy PowerPoint and Keynote decks need/
    );
    assert.match(
      getDeckUploadBlockMessage({ status: 'ready', message: 'Ready' }),
      /Modern PPTX and PDFs can still render visually in the browser/
    );
    assert.equal(
      getDeckUploadBlockMessage({
        status: 'ready',
        message: 'Ready',
        presentationRenderer: {
          ready: true,
          message: 'Exact deck renderer ready.',
        },
      }),
      ''
    );
    assert.equal(
      getDeckUploadBlockMessage({
        status: 'ready',
        message: 'Media server reachable.',
        presentationRenderer: {
          ready: false,
          message: 'Exact deck renderer unavailable: LibreOffice is not ready.',
        },
      }),
      'Exact deck renderer unavailable: LibreOffice is not ready.'
    );
    assert.match(
      getDeckUploadBlockMessage({ status: 'checking', message: 'Checking media-server readiness...' }),
      /Legacy PowerPoint and Keynote decks need/
    );
    assert.equal(
      getDeckUploadBlockMessage({ status: 'unavailable', message: 'Media server is not provisioned on Render.' }),
      'Media server is not provisioned on Render.'
    );
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
          { id: 'slide-1', title: 'Slide 1', lines: [], imageUrl: 'data:image/png;base64,rendered', rendered: true },
        ],
      },
    }), true);

    assert.equal(canPlayMediaAsset({
      id: 'deck-2b',
      name: 'Text-only fallback.pptx',
      url: 'blob:deck',
      type: 'presentation',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'upload',
      createdAt: '2026-07-02T05:56:32.000Z',
      preview: {
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'slide-1', title: 'TRIAD FORMATION', lines: ['Discipleship'] },
        ],
      },
    }), false);

    assert.equal(canPlayMediaAsset({
      id: 'deck-2c',
      name: 'Embedded-image fallback.pptx',
      url: 'blob:deck',
      type: 'presentation',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'upload',
      createdAt: '2026-07-02T05:56:32.000Z',
      preview: {
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'slide-1', title: 'Slide 1', lines: [], imageUrl: 'data:image/png;base64,embedded' },
        ],
      },
    }), false);

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

  it('shows deck rendering status until exact slide images are ready', () => {
    const processingDeck = {
      id: 'deck-4',
      name: 'Preparing deck.pptx',
      url: 'blob:deck',
      type: 'presentation' as const,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      source: 'upload' as const,
      createdAt: '2026-07-02T05:56:32.000Z',
      processingStatus: 'processing' as const,
      processingMessage: 'Rendering PowerPoint design with the media server...',
    };

    assert.equal(canPlayMediaAsset(processingDeck), false);
    assert.equal(
      getMediaAssetStatusLabel(processingDeck),
      'Rendering PowerPoint design with the media server...'
    );
  });
});
