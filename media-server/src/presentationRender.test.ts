import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  createLibreOfficePdfArgs,
  createPdfToPngArgs,
  getPresentationRenderSourceFormat,
  PresentationRenderError,
  renderPresentationPreview,
} from './presentationRender.js';

describe('presentation rendering', () => {
  it('detects PDF, modern PowerPoint, and legacy PowerPoint inputs', () => {
    assert.equal(getPresentationRenderSourceFormat('lesson.pdf', ''), 'pdf');
    assert.equal(getPresentationRenderSourceFormat('slides.pptx', ''), 'pptx');
    assert.equal(getPresentationRenderSourceFormat('sermon.ppt', 'application/vnd.ms-powerpoint'), 'pptx');
    assert.equal(getPresentationRenderSourceFormat('notes.txt', 'text/plain'), null);
  });

  it('constructs bounded LibreOffice and Poppler commands', () => {
    assert.deepEqual(createLibreOfficePdfArgs('/tmp/source.pptx', '/tmp/out'), [
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--nodefault',
      '--nolockcheck',
      '--norestore',
      '--convert-to',
      'pdf',
      '--outdir',
      '/tmp/out',
      '/tmp/source.pptx',
    ]);

    assert.deepEqual(createPdfToPngArgs('/tmp/source.pdf', '/tmp/slide'), [
      '-png',
      '-f',
      '1',
      '-l',
      '60',
      '-scale-to-x',
      '1280',
      '-scale-to-y',
      '-1',
      '/tmp/source.pdf',
      '/tmp/slide',
    ]);
  });

  it('renders PowerPoint previews through LibreOffice and PDF rasterization', async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const preview = await renderPresentationPreview({
      fileName: 'message.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      data: Buffer.from('pptx-bytes'),
    }, {
      sofficePath: 'soffice-test',
      pdftoppmPath: 'pdftoppm-test',
      commandRunner: async (command, args) => {
        commands.push({ command, args });
        if (command === 'soffice-test') {
          const outDir = args[args.indexOf('--outdir') + 1];
          await writeFile(path.join(outDir, 'source.pdf'), Buffer.from('%PDF-1.7'));
        }
        if (command === 'pdftoppm-test') {
          const outputPrefix = args[args.length - 1];
          await writeFile(`${outputPrefix}-1.png`, Buffer.from('png-one'));
          await writeFile(`${outputPrefix}-2.png`, Buffer.from('png-two'));
        }
      },
    });

    assert.equal(commands[0].command, 'soffice-test');
    assert.equal(commands[1].command, 'pdftoppm-test');
    assert.equal(preview.kind, 'presentation-slides');
    assert.equal(preview.sourceFormat, 'pptx');
    assert.equal(preview.slides.length, 2);
    assert.equal(preview.slides[0].title, 'Slide 1');
    assert.equal(preview.slides[0].imageUrl, `data:image/png;base64,${Buffer.from('png-one').toString('base64')}`);
  });

  it('rejects unsupported files before invoking render commands', async () => {
    await assert.rejects(
      () => renderPresentationPreview({
        fileName: 'notes.txt',
        contentType: 'text/plain',
        data: Buffer.from('notes'),
      }, {
        commandRunner: async () => {
          throw new Error('should not run');
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PresentationRenderError);
        assert.equal(err.statusCode, 415);
        assert.equal(err.code, 'PRESENTATION_UNSUPPORTED');
        return true;
      }
    );
  });
});
