import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';

import {
  ALLOW_BROWSER_POWERPOINT_VISUAL_FALLBACK,
  applyRenderedSlideImages,
  buildPresentationPreview,
  buildServerRenderedPresentationPreview,
  canBrowserRenderPowerPointFile,
  extractPptxFullSlideImageTarget,
  extractPptxSlideImageTargets,
  extractPptxSlideNotesTarget,
  extractPptxSpeakerNotes,
  extractPptxSlideText,
  hasRenderedPresentationSlides,
  isRecoverablePowerPointServerRenderFailure,
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

  it('keeps approximate browser PowerPoint rendering disabled by default', () => {
    assert.equal(ALLOW_BROWSER_POWERPOINT_VISUAL_FALLBACK, false);
    assert.equal(canBrowserRenderPowerPointFile({ name: 'sermon.pptx', type: '' } as File), true);
    assert.equal(canBrowserRenderPowerPointFile({ name: 'legacy-sermon.ppt', type: 'application/vnd.ms-powerpoint' } as File), false);
    assert.equal(isRecoverablePowerPointServerRenderFailure({
      status: 404,
      code: 'MEDIA_SERVER_NO_SERVER',
      message: 'Media server is not provisioned on Render.',
      renderRouting: 'no-server',
    }), true);
    assert.equal(isRecoverablePowerPointServerRenderFailure({
      status: 503,
      code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      message: 'Presentation renderer is unavailable.',
    }), true);
    assert.equal(isRecoverablePowerPointServerRenderFailure({
      status: 415,
      code: 'PRESENTATION_UNSUPPORTED',
      message: 'Only PDF and PowerPoint files can be rendered.',
    }), false);
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

  it('detects full-slide PPTX image artwork that can preserve deck formatting offline', () => {
    const slideXml = `
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:cSld>
          <p:spTree>
            <p:pic>
              <p:blipFill><a:blip r:embed="rId4"/></p:blipFill>
              <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm></p:spPr>
            </p:pic>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `;
    const relsXml = `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/slide1.png"/>
      </Relationships>
    `;

    assert.equal(extractPptxFullSlideImageTarget(slideXml, relsXml), 'ppt/media/slide1.png');
  });

  it('ignores partial PPTX images because they do not preserve full slide formatting', () => {
    const slideXml = `
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:cSld>
          <p:spTree>
            <p:pic>
              <p:blipFill><a:blip r:embed="rId4"/></p:blipFill>
              <p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="3000000" cy="2000000"/></a:xfrm></p:spPr>
            </p:pic>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `;
    const relsXml = `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/partial.png"/>
      </Relationships>
    `;

    assert.equal(extractPptxFullSlideImageTarget(slideXml, relsXml), null);
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

  it('builds bounded slide metadata from a PPTX zip only when text fallback is explicitly allowed', async () => {
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

    const preview = await buildPresentationPreview(file, {
      allowTextPowerPointFallback: true,
    });

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

  it('does not return text-only PowerPoint previews by default', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>TRIAD FORMATION</a:t><a:t>Discipleship</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'renderer unavailable',
        code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    });

    assert.equal(preview, undefined);
  });

  it('attaches an embedded slide image preview when a PPTX slide references one and text fallback is explicitly allowed', async () => {
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

    const preview = await buildPresentationPreview(file, {
      allowTextPowerPointFallback: true,
    });

    assert.equal(preview?.slides[0].title, 'Slide 1');
    assert.equal(preview?.slides[0].lines.length, 0);
    assert.match(preview?.slides[0].imageUrl || '', /^data:image\/png;base64,/);
    assert.equal(preview?.slides[0].rendered, undefined);
  });

  it('replaces extracted placeholders with rendered slide images when available', () => {
    const slides = [
      { id: 'slide-1', title: 'Opening', lines: ['Point'] },
      { id: 'slide-2', title: 'Second', lines: [] },
    ];

    const renderedSlides = applyRenderedSlideImages(slides, ['data:image/png;base64,one']);

    assert.deepEqual(renderedSlides.map((slide) => slide.imageUrl), ['data:image/png;base64,one', undefined]);
    assert.deepEqual(renderedSlides.map((slide) => slide.rendered), [true, undefined]);
  });

  it('detects whether every deck slide has a rendered visual', () => {
    assert.equal(hasRenderedPresentationSlides({
      kind: 'presentation-slides',
      sourceFormat: 'pptx',
      slides: [
        { id: 'slide-1', title: 'Opening', lines: [], imageUrl: 'data:image/png;base64,one', rendered: true },
        { id: 'slide-2', title: 'Second', lines: [], imageUrl: 'data:image/webp;base64,two', rendered: true },
      ],
    }), true);

    assert.equal(hasRenderedPresentationSlides({
      kind: 'presentation-slides',
      sourceFormat: 'pptx',
      slides: [
        { id: 'slide-1', title: 'Opening', lines: [], imageUrl: 'data:image/png;base64,one' },
      ],
    }), false);

    assert.equal(hasRenderedPresentationSlides({
      kind: 'presentation-slides',
      sourceFormat: 'pptx',
      slides: [
        { id: 'slide-1', title: 'Opening', lines: [], imageUrl: 'data:image/png;base64,one', rendered: true },
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
    assert.equal(preview?.slides[0].rendered, true);
  });

  it('rejects server presentation previews without rendered slide images', async () => {
    const file = new File(
      [Buffer.from('pptx-bytes')],
      'message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );
    const failures: unknown[] = [];

    const preview = await buildServerRenderedPresentationPreview(file, {
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        kind: 'presentation-slides',
        sourceFormat: 'pptx',
        slides: [
          { id: 'slide-1', title: 'TRIAD FORMATION', lines: ['Discipleship'] },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      onServerRenderFailure: (failure) => failures.push(failure),
    });

    assert.equal(preview, undefined);
    assert.deepEqual(failures, [{
      status: 200,
      code: 'PRESENTATION_RENDER_INCOMPLETE',
      message: 'Media server returned a presentation preview without rendered slide artwork.',
    }]);
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
    assert.equal(preview?.slides[0].rendered, true);
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
    assert.equal(preview?.slides[0].rendered, true);
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

  it('does not use approximate browser PowerPoint rendering unless explicitly enabled', async () => {
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
      pptxSlideImageRenderer: async () => ['data:image/png;base64,browser-rendered'],
    });

    assert.equal(preview, undefined);
  });

  it('uses browser-rendered PowerPoint images when fallback is explicitly enabled', async () => {
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
      allowBrowserPowerPointRenderFallback: true,
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'renderer unavailable',
        code: 'PRESENTATION_RENDERER_UNAVAILABLE',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
      pptxSlideImageRenderer: async () => ['data:image/png;base64,browser-rendered'],
    });

    assert.equal(preview?.slides[0].title, 'TRIAD FORMATION');
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,browser-rendered');
    assert.equal(preview?.slides[0].rendered, true);
  });

  it('can use configured browser-rendered PowerPoint fallback only when explicitly enabled', async () => {
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
      allowBrowserPowerPointRenderFallback: true,
      mediaHttpUrl: 'https://media.example.test',
      fetchImpl: async () => new Response('Not Found', {
        status: 404,
        headers: { 'x-render-routing': 'no-server' },
      }),
      pptxSlideImageRenderer: async () => ['data:image/png;base64,browser-rendered'],
    });

    assert.equal(preview?.slides[0].title, 'TRIAD FORMATION');
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,browser-rendered');
    assert.equal(preview?.slides[0].rendered, true);
  });

  it('can skip the server render attempt and go straight to browser-rendered PowerPoint images', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>FAST FALLBACK</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'fast-fallback.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      allowBrowserPowerPointRenderFallback: true,
      skipServerRender: true,
      fetchImpl: async () => {
        throw new Error('server should not be called');
      },
      pptxSlideImageRenderer: async () => ['data:image/png;base64,fast-fallback'],
    });

    assert.equal(preview?.slides[0].title, 'FAST FALLBACK');
    assert.equal(preview?.slides[0].imageUrl, 'data:image/png;base64,fast-fallback');
    assert.equal(preview?.slides[0].rendered, true);
  });

  it('keeps browser-rendered PowerPoint previews visual for every slide', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<a:t>Opening</a:t><a:t>Welcome</a:t>');
    zip.file('ppt/slides/slide2.xml', '<a:t>Closing</a:t><a:t>Next steps</a:t>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'visual-fallback.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      allowBrowserPowerPointRenderFallback: true,
      skipServerRender: true,
      pptxSlideImageRenderer: async () => [
        'data:image/png;base64,opening-artwork',
        'data:image/png;base64,closing-artwork',
      ],
    });

    assert.equal(preview?.slides.length, 2);
    assert.equal(hasRenderedPresentationSlides(preview), true);
    assert.deepEqual(
      preview?.slides.map((slide) => [slide.title, slide.rendered, slide.imageUrl]),
      [
        ['Opening', true, 'data:image/png;base64,opening-artwork'],
        ['Closing', true, 'data:image/png;base64,closing-artwork'],
      ]
    );
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

  it('accepts full-slide image PPTX artwork when exact server rendering is unavailable', async () => {
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
    zip.file('ppt/slides/slide1.xml', `
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <p:cSld>
          <p:spTree>
            <p:pic>
              <p:blipFill><a:blip r:embed="rId1"/></p:blipFill>
              <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm></p:spPr>
            </p:pic>
          </p:spTree>
        </p:cSld>
      </p:sld>
    `);
    zip.file('ppt/slides/_rels/slide1.xml.rels', `
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/full-slide.png"/>
      </Relationships>
    `);
    zip.file('ppt/media/full-slide.png', onePixelPng);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File(
      [bytes],
      'image-backed-message.pptx',
      { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    );

    const preview = await buildPresentationPreview(file, {
      requireRenderedSlides: true,
      requireServerRenderedPowerPoint: true,
      skipServerRender: true,
    });

    assert.equal(preview?.sourceFormat, 'pptx');
    assert.equal(preview?.slides[0].rendered, true);
    assert.match(preview?.slides[0].imageUrl || '', /^data:image\/png;base64,/);
    assert.equal(hasRenderedPresentationSlides(preview), true);
  });

  it('does not use browser-rendered fallback when server-rendered PowerPoint is required', async () => {
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

    assert.equal(preview, undefined);
  });

  it('rejects stale server responses without slide artwork when exact PowerPoint rendering is required', async () => {
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

    assert.equal(preview, undefined);
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
    assert.equal(preview?.slides[0].rendered, true);
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
    assert.equal(preview?.slides[0].rendered, true);
  });
});
