import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';

import {
  buildPresentationPreview,
  extractPptxSlideText,
  isPptxFile,
} from '../src/utils/presentationPreview.ts';

describe('PowerPoint preview extraction', () => {
  it('detects modern PowerPoint files', () => {
    assert.equal(isPptxFile({ name: 'sermon.pptx', type: '' } as File), true);
    assert.equal(
      isPptxFile({
        name: 'upload.bin',
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      } as File),
      true
    );
    assert.equal(isPptxFile({ name: 'legacy.ppt', type: 'application/vnd.ms-powerpoint' } as File), false);
  });

  it('extracts readable slide text from PPTX XML', () => {
    const runs = extractPptxSlideText(`
      <p:sld>
        <p:cSld>
          <p:spTree>
            <a:t>Distinct &amp; Not Distant</a:t>
            <a:t>God is present</a:t>
            <a:t>Mission &lt; Distraction</a:t>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);

    assert.deepEqual(runs, [
      'Distinct & Not Distant',
      'God is present',
      'Mission < Distraction',
    ]);
  });

  it('builds bounded slide previews from a PPTX zip', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide2.xml', '<a:t>Second</a:t><a:t>Another point</a:t>');
    zip.file('ppt/slides/slide1.xml', '<a:t>First</a:t><a:t>Main point</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file);

    assert.equal(preview?.kind, 'presentation-slides');
    assert.equal(preview?.sourceFormat, 'pptx');
    assert.deepEqual(preview?.slides.map((slide) => slide.title), ['First', 'Second']);
    assert.deepEqual(preview?.slides[0].lines, ['Main point']);
  });
});
