import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';

import {
  applyRenderedSlideImages,
  buildPresentationPreview,
  buildServerRenderedPresentationPreview,
  extractPptxSlideImageTargets,
  extractPptxSlideNotesTarget,
  extractPptxSpeakerNotes,
  extractPptxSlideText,
  hasRenderedPresentationSlides,
  isLegacyPowerPointFile,
  isPdfFile,
  isPowerPointFile,
  isPptxFile,
  mergeRenderedPresentationPreview,
} from '../src/utils/presentationPreview.ts';

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=',
  'base64'
);

describe('PowerPoint preview extraction', () => {
  it('detects PDF deck files', () => {
    assert.equal(isPdfFile({ name: 'lesson.pdf', type: '' } as File), true);
    assert.equal(isPdfFile({ name: 'upload.bin', type: 'application/pdf' } as File), true);
    assert.equal(isPdfFile({ name: 'lesson.pptx', type: '' } as File), false);
  });

  it('detects modern PowerPoint files', () => {
    assert.equal(isPptxFile({ name: 'sermon.pptx', type: '' } as File), true);
    assert.equal(
      isPptxFile({
        name: 'upload.bin',
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      } as File),
      true
    );
    assert.equal(
      isPptxFile({
        name: 'talk.ppsx',
        type: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
      } as File),
      true
    );
    assert.equal(isPptxFile({ name: 'legacy.ppt', type: 'application/vnd.ms-powerpoint' } as File), false);
    assert.equal(isLegacyPowerPointFile({ name: 'legacy.ppt', type: 'application/vnd.ms-powerpoint' } as File), true);
    assert.equal(isPowerPointFile({ name: 'legacy.ppt', type: 'application/vnd.ms-powerpoint' } as File), true);
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

  it('resolves and cleans speaker notes from PPTX note relationships', () => {
    const relsXml = `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
      </Relationships>
    `;

    assert.equal(extractPptxSlideNotesTarget(relsXml), 'ppt/notesSlides/notesSlide1.xml');
    assert.deepEqual(
      extractPptxSpeakerNotes(
        '<a:t>Opening</a:t><a:t>Click to add notes</a:t><a:t>Ask audience a question</a:t><a:t>Ask audience a question</a:t>',
        ['Opening']
      ),
      ['Ask audience a question']
    );
  });

  it('builds bounded slide previews from a PPTX zip', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide2.xml', '<a:t>Second</a:t><a:t>Another point</a:t>');
    zip.file('ppt/slides/slide1.xml', '<a:t>First</a:t><a:t>Main point</a:t>');
    zip.file('ppt/slides/_rels/slide1.xml.rels', `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
      </Relationships>
    `);
    zip.file('ppt/notesSlides/notesSlide1.xml', '<a:t>First</a:t><a:t>Prayer transition</a:t><a:t>Invite response</a:t>');
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
    assert.deepEqual(preview?.slides[0].notes, ['Prayer transition', 'Invite response']);
  });

  it('does not fail PDF uploads when browser canvas rendering is unavailable', async () => {
    const file = new File(
      [Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')],
      'handout.pdf',
      { type: 'application/pdf' }
    );

    const preview = await buildPresentationPreview(file);

    assert.equal(preview, undefined);
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

  it('replaces extracted placeholders with rendered slide images when available', () => {
    const slides = [
      { id: 'slide-1', title: 'Opening', lines: ['Point'] },
      { id: 'slide-2', title: 'Second', lines: [] },
    ];

    assert.deepEqual(
      applyRenderedSlideImages(slides, ['data:image/png;base64,one']).map((slide) => slide.imageUrl),
      ['data:image/png;base64,one', undefined]
    );
  });

  it('detects whether every deck slide has a rendered visual', () => {
    assert.equal(hasRenderedPresentationSlides({
      kind: 'presentation-slides',
      sourceFormat: 'pptx',
      slides: [
        { id: 'slide-1', title: 'Opening', lines: [], imageUrl: 'data:image/png;base64,one' },
        { id: 'slide-2', title: 'Second', lines: [], imageUrl: 'data:image/webp;base64,two' },
      ],
    }), true);

    assert.equal(hasRenderedPresentationSlides({
      kind: 'presentation-slides',
      sourceFormat: 'pptx',
      slides: [
        { id: 'slide-1', title: 'Opening', lines: [], imageUrl: 'data:image/png;base64,one' },
        { id: 'slide-2', title: 'Second', lines: [] },
      ],
    }), false);
  });

  it('normalizes server-rendered slide previews', async () => {
    const file = new File(
      [Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')],
      'handout.pdf',
      { type: 'application/pdf' }
    );
    const preview = await buildServerRenderedPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async (url, init) => {
        assert.equal(String(url), 'https://media.example.test/presentation-preview');
        assert.equal(init?.method, 'POST');
        assert.equal((init?.headers as Record<string, string>)['X-File-Name'], 'handout.pdf');
        return new Response(JSON.stringify({
          kind: 'presentation-slides',
          sourceFormat: 'pdf',
          slides: [
            { id: 'page-1', title: 'Page 1', lines: [], imageUrl: 'data:image/png;base64,page' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });

    assert.equal(preview?.sourceFormat, 'pdf');
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,page');
  });

  it('rejects server presentation previews without rendered slide images', async () => {
    const file = new File(
      [Buffer.from('pptx-bytes')],
      'message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildServerRenderedPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'slide-1', title: 'TRIAD FORMATION', lines: ['Discipleship'] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    assert.equal(preview, undefined);
  });

  it('reports Render no-server presentation render failures', async () => {
    const file = new File(
      [Buffer.from('pptx-bytes')],
      'message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );
    const failures: unknown[] = [];

    const preview = await buildServerRenderedPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response('Not Found', {
        status: 404,
        headers: {
          'x-render-routing': 'no-server',
        },
      }),
      onServerRenderFailure: (failure) => failures.push(failure),
    });

    assert.equal(preview, undefined);
    assert.deepEqual(failures, [{
      status: 404,
      code: 'MEDIA_SERVER_NO_SERVER',
      message: 'Media server is not provisioned on Render.',
      renderRouting: 'no-server',
    }]);
  });

  it('reports media-server presentation renderer error codes', async () => {
    const file = new File(
      [Buffer.from('pptx-bytes')],
      'message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );
    const failures: unknown[] = [];

    const preview = await buildServerRenderedPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'Presentation renderer is unavailable',
        code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
      onServerRenderFailure: (failure) => failures.push(failure),
    });

    assert.equal(preview, undefined);
    assert.deepEqual(failures, [{
      status: 503,
      code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      message: 'Presentation renderer is unavailable',
    }]);
  });

  it('merges server-rendered PowerPoint images with extracted slide text', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>TRIAD FORMATION</a:t><a:t>Discipleship</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'Discipleship-Via-Triads.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'rendered-1', title: 'Slide 1', lines: [], imageUrl: 'data:image/png;base64,rendered' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    assert.equal(preview?.sourceFormat, 'pptx');
    assert.equal(preview?.slides[0].title, 'TRIAD FORMATION');
    assert.deepEqual(preview?.slides[0].lines, ['Discipleship']);
    assert.deepEqual(preview?.slides[0].notes, undefined);
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,rendered');
  });

  it('preserves extracted speaker notes when server-rendered images are merged', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>TRIAD FORMATION</a:t><a:t>Discipleship</a:t>');
    zip.file('ppt/slides/_rels/slide1.xml.rels', `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
      </Relationships>
    `);
    zip.file('ppt/notesSlides/notesSlide1.xml', '<a:t>TRIAD FORMATION</a:t><a:t>Mention covenant story</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'Discipleship-Via-Triads.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'rendered-1', title: 'Slide 1', lines: [], imageUrl: 'data:image/png;base64,rendered' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    assert.deepEqual(preview?.slides[0].notes, ['Mention covenant story']);
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,rendered');
  });

  it('does not accept text-only PowerPoint extraction when rendered slides are required', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>TRIAD FORMATION</a:t><a:t>Discipleship</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'Discipleship-Via-Triads.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'renderer unavailable',
        code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    });

    assert.equal(preview, undefined);
  });

  it('requires server-rendered PowerPoint images when exact deck visuals are required', async () => {
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
      'designed-message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'renderer unavailable',
        code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    });

    assert.equal(preview, undefined);
  });

  it('uses a browser-rendered visual fallback when the media server cannot render PowerPoint', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>TRIAD FORMATION</a:t><a:t>Discipleship</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'Discipleship-Via-Triads.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      requireServerRenderedPowerPoint: true,
      allowBrowserPowerPointRenderFallback: true,
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'renderer unavailable',
        code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
      pptxSlideImageRenderer: async () => ['data:image/png;base64,browser-rendered'],
    });

    assert.equal(preview?.sourceFormat, 'pptx');
    assert.equal(preview?.slides[0].title, 'TRIAD FORMATION');
    assert.deepEqual(preview?.slides[0].lines, ['Discipleship']);
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,browser-rendered');
  });

  it('uses browser-rendered PowerPoint images when a stale server response has no slide artwork', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>TRIAD FORMATION</a:t><a:t>Discipleship</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'Discipleship-Via-Triads.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      requireServerRenderedPowerPoint: true,
      allowBrowserPowerPointRenderFallback: true,
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'text-only-1', title: 'TRIAD FORMATION', lines: ['Discipleship'] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      pptxSlideImageRenderer: async () => ['data:image/png;base64,browser-rendered'],
    });

    assert.equal(preview?.sourceFormat, 'pptx');
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,browser-rendered');
  });

  it('rejects browser-rendered PowerPoint fallback when exact server visuals are required', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>TRIAD FORMATION</a:t><a:t>Discipleship</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'Discipleship-Via-Triads.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      requireServerRenderedPowerPoint: true,
      allowBrowserPowerPointRenderFallback: false,
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'renderer unavailable',
        code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
      pptxSlideImageRenderer: async () => ['data:image/png;base64,browser-rendered'],
    });

    assert.equal(preview, undefined);
  });

  it('rejects incomplete browser-rendered PowerPoint fallbacks', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>First</a:t>');
    zip.file('ppt/slides/slide2.xml', '<a:t>Second</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'partial-render.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      requireServerRenderedPowerPoint: true,
      allowBrowserPowerPointRenderFallback: true,
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'renderer unavailable',
        code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
      pptxSlideImageRenderer: async () => ['data:image/png;base64,first-only'],
    });

    assert.equal(preview, undefined);
  });

  it('builds legacy PowerPoint previews from the media server renderer', async () => {
    const file = new File(
      [Buffer.from('legacy-binary-powerpoint')],
      'legacy-sermon.ppt',
      { type: 'application/vnd.ms-powerpoint' }
    );

    const preview = await buildPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'rendered-1', title: 'Slide 1', lines: [], imageUrl: 'data:image/png;base64,legacy' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,legacy');
  });

  it('merges rendered previews when extracted slide data is missing', () => {
    const preview = mergeRenderedPresentationPreview([], {
      kind: 'presentation-slides',
      sourceFormat: 'pptx',
      slides: [
        { id: 'rendered-1', title: 'Rendered', lines: [], imageUrl: 'data:image/png;base64,rendered' },
      ],
    }, 'pptx');

    assert.equal(preview?.slides[0].title, 'Rendered');
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,rendered');
  });
});
