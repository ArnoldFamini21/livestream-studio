import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';

import {
  buildPresentationPreview,
  extractPptxSlideImageTargets,
  extractPptxSlideText,
  isPptxFile,
} from '../src/utils/presentationPreview.ts';

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=',
  'base64'
);

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

  it('resolves embedded slide image relationships from PPTX XML', () => {
    const targets = extractPptxSlideImageTargets(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
        <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
        <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="https://example.com/image.png"/>
      </Relationships>
    `);

    assert.deepEqual(targets, ['ppt/media/image1.png']);
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

  it('attaches an embedded slide image preview when a PPTX slide references one', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld><p:cSld><p:spTree /></p:cSld></p:sld>');
    zip.file('ppt/slides/_rels/slide1.xml.rels', `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
      </Relationships>
    `);
    zip.file('ppt/media/image1.png', onePixelPng);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'image-based-message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file);

    assert.equal(preview?.slides[0].title, 'Slide 1');
    assert.equal(preview?.slides[0].lines.length, 0);
    assert.match(preview?.slides[0].imageUrl || '', /^data:image\/png;base64,/);
  });
});
