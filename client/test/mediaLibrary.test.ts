import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SUPPORTED_MEDIA_ACCEPT,
  detectMediaType,
  getMediaTabForType,
} from '../src/components/MediaLibrary.tsx';

describe('media library upload support', () => {
  it('allows presentation and document files from the shared upload picker', () => {
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.pdf/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.ppt/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.pptx/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /\.ppsx/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /video\/\*/);
    assert.match(SUPPORTED_MEDIA_ACCEPT, /image\/\*/);
  });

  it('detects PowerPoint and PDF files by extension and MIME type', () => {
    assert.equal(detectMediaType({ name: 'Distinct But Not Distant.pdf', type: '' } as File), 'pdf');
    assert.equal(detectMediaType({ name: 'Discipleship-Via-Triads.pptx', type: '' } as File), 'presentation');
    assert.equal(detectMediaType({ name: 'legacy-sermon.ppt', type: 'application/vnd.ms-powerpoint' } as File), 'presentation');
    assert.equal(detectMediaType({ name: 'slides.ppsx', type: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' } as File), 'presentation');
  });

  it('routes PDF and PowerPoint uploads to the Slides tab', () => {
    assert.equal(getMediaTabForType('pdf'), 'slides');
    assert.equal(getMediaTabForType('presentation'), 'slides');
    assert.equal(getMediaTabForType('video'), 'videos');
    assert.equal(getMediaTabForType('image'), 'images');
    assert.equal(getMediaTabForType('file'), 'files');
  });
});
