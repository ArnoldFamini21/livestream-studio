import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StudioMediaAssetPreview } from '@studio/shared';

export const MAX_PRESENTATION_RENDER_BYTES = 50 * 1024 * 1024;
export const MAX_PRESENTATION_RENDER_SLIDES = 60;
export const PRESENTATION_RENDER_WIDTH = 1920;
const COMMAND_TIMEOUT_MS = 45_000;

export class PresentationRenderError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'PresentationRenderError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type PresentationRenderSourceFormat = StudioMediaAssetPreview['sourceFormat'];

interface PresentationRenderInput {
  fileName: string;
  contentType: string;
  data: Buffer;
}

interface CommandRunner {
  (command: string, args: string[], options?: { timeoutMs?: number }): Promise<void>;
}

interface RenderOptions {
  commandRunner?: CommandRunner;
  sofficePath?: string;
  pdftoppmPath?: string;
}

export function getPresentationRenderSourceFormat(fileName: string, contentType: string): PresentationRenderSourceFormat | null {
  const lowerName = fileName.toLowerCase();
  const lowerType = contentType.toLowerCase();
  if (lowerName.endsWith('.pdf') || lowerType.includes('application/pdf')) return 'pdf';
  if (
    lowerName.endsWith('.ppt') ||
    lowerName.endsWith('.pptx') ||
    lowerName.endsWith('.pps') ||
    lowerName.endsWith('.ppsx') ||
    lowerName.endsWith('.pot') ||
    lowerName.endsWith('.potx') ||
    lowerType.includes('application/vnd.ms-powerpoint') ||
    lowerType.includes('application/vnd.openxmlformats-officedocument.presentationml')
  ) {
    return 'pptx';
  }
  return null;
}

function getInputExtension(fileName: string, sourceFormat: PresentationRenderSourceFormat): string {
  const extension = path.extname(fileName).toLowerCase();
  if (sourceFormat === 'pdf') return '.pdf';
  if (['.ppt', '.pptx', '.pps', '.ppsx', '.pot', '.potx'].includes(extension)) return extension;
  return '.pptx';
}

export function createLibreOfficePdfArgs(
  inputPath: string,
  outputDir: string,
  userInstallationUrl?: string
): string[] {
  return [
    ...(userInstallationUrl ? [`-env:UserInstallation=${userInstallationUrl}`] : []),
    '--headless',
    '--nologo',
    '--nofirststartwizard',
    '--nodefault',
    '--nolockcheck',
    '--norestore',
    '--convert-to',
    'pdf:impress_pdf_Export',
    '--outdir',
    outputDir,
    inputPath,
  ];
}

export function createPdfToPngArgs(pdfPath: string, outputPrefix: string): string[] {
  return [
    '-png',
    '-f',
    '1',
    '-l',
    String(MAX_PRESENTATION_RENDER_SLIDES),
    '-scale-to-x',
    String(PRESENTATION_RENDER_WIDTH),
    '-scale-to-y',
    '-1',
    pdfPath,
    outputPrefix,
  ];
}

function getLibreOfficePath(): string {
  return process.env.SOFFICE_PATH || process.env.LIBREOFFICE_PATH || 'soffice';
}

function getPdftoppmPath(): string {
  return process.env.PDFTOPPM_PATH || 'pdftoppm';
}

async function defaultCommandRunner(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs || COMMAND_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new PresentationRenderError(504, 'PRESENTATION_RENDER_TIMEOUT', 'Presentation rendering timed out'));
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new PresentationRenderError(
        503,
        'PRESENTATION_RENDERER_UNAVAILABLE',
        `Presentation renderer is unavailable: ${err.message}`
      ));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new PresentationRenderError(
        422,
        'PRESENTATION_RENDER_FAILED',
        stderr.trim() || `Presentation renderer exited with code ${code ?? 'unknown'}`
      ));
    });
  });
}

function getRenderedSlideNumber(fileName: string): number {
  return Number(fileName.match(/-(\d+)\.png$/i)?.[1] || 0);
}

async function getRenderedPngPaths(outputDir: string): Promise<string[]> {
  const fileNames = await readdir(outputDir);
  return fileNames
    .filter((fileName) => /^slide-\d+\.png$/i.test(fileName))
    .sort((a, b) => getRenderedSlideNumber(a) - getRenderedSlideNumber(b))
    .slice(0, MAX_PRESENTATION_RENDER_SLIDES)
    .map((fileName) => path.join(outputDir, fileName));
}

async function buildPreviewFromPngs(pngPaths: string[], sourceFormat: PresentationRenderSourceFormat): Promise<StudioMediaAssetPreview> {
  const slides = await Promise.all(pngPaths.map(async (pngPath, index) => ({
    id: `${sourceFormat}-rendered-slide-${index + 1}`,
    title: sourceFormat === 'pdf' ? `Page ${index + 1}` : `Slide ${index + 1}`,
    lines: [],
    imageUrl: `data:image/png;base64,${(await readFile(pngPath)).toString('base64')}`,
    rendered: true,
  })));

  return {
    kind: 'presentation-slides',
    sourceFormat,
    slides,
  };
}

export async function renderPresentationPreview(
  input: PresentationRenderInput,
  options: RenderOptions = {}
): Promise<StudioMediaAssetPreview> {
  if (input.data.byteLength === 0) {
    throw new PresentationRenderError(400, 'PRESENTATION_EMPTY', 'Presentation file is empty');
  }
  if (input.data.byteLength > MAX_PRESENTATION_RENDER_BYTES) {
    throw new PresentationRenderError(413, 'PRESENTATION_TOO_LARGE', 'Presentation file is too large');
  }

  const sourceFormat = getPresentationRenderSourceFormat(input.fileName, input.contentType);
  if (!sourceFormat) {
    throw new PresentationRenderError(415, 'PRESENTATION_UNSUPPORTED', 'Only PDF and PowerPoint files can be rendered');
  }

  const workspace = await mkdtemp(path.join(tmpdir(), 'studio-presentation-'));
  const outputDir = path.join(workspace, 'output');
  const commandRunner = options.commandRunner || defaultCommandRunner;

  try {
    await mkdir(outputDir, { recursive: true });
    const inputPath = path.join(workspace, `source${getInputExtension(input.fileName, sourceFormat)}`);
    await writeFile(inputPath, input.data);

    let pdfPath = inputPath;
    if (sourceFormat === 'pptx') {
      const sofficePath = options.sofficePath || getLibreOfficePath();
      const libreOfficeProfileDir = path.join(workspace, 'lo-profile');
      await mkdir(libreOfficeProfileDir, { recursive: true });
      await commandRunner(
        sofficePath,
        createLibreOfficePdfArgs(inputPath, outputDir, pathToFileURL(libreOfficeProfileDir).href),
        { timeoutMs: COMMAND_TIMEOUT_MS }
      );
      pdfPath = path.join(outputDir, 'source.pdf');
    }

    const pdftoppmPath = options.pdftoppmPath || getPdftoppmPath();
    await commandRunner(pdftoppmPath, createPdfToPngArgs(pdfPath, path.join(outputDir, 'slide')), { timeoutMs: COMMAND_TIMEOUT_MS });
    const pngPaths = await getRenderedPngPaths(outputDir);

    if (pngPaths.length === 0) {
      throw new PresentationRenderError(422, 'PRESENTATION_RENDER_EMPTY', 'No slides were rendered from this file');
    }

    return buildPreviewFromPngs(pngPaths, sourceFormat);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}
