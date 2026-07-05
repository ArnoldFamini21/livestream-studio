import type JSZip from 'jszip';
import type { StudioMediaAssetPreview, PresentationSlidePreview } from '@studio/shared';
import { resolveMediaHttpUrl } from './apiClient.ts';

const MAX_PRESENTATION_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_SLIDES = 60;
const MAX_PREVIEW_LINES_PER_SLIDE = 10;
const MAX_PREVIEW_NOTES_PER_SLIDE = 8;
const MAX_PREVIEW_TEXT_LENGTH = 180;
const MAX_SLIDE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SLIDE_IMAGE_CANDIDATES = 12;
const RENDERED_SLIDE_WIDTH = 1280;
const RENDERED_SLIDE_HEIGHT = 720;
const DEFAULT_PPTX_SLIDE_WIDTH_EMU = 12192000;
const DEFAULT_PPTX_SLIDE_HEIGHT_EMU = 6858000;
const FULL_SLIDE_IMAGE_TOLERANCE_EMU = 90_000;
const RENDER_SETTLE_FRAMES = 3;
const RENDER_SETTLE_TIMEOUT_MS = 320;
const PDF_RENDER_SCALE_LIMIT = 2;
const SERVER_RENDER_TIMEOUT_MS = 120_000;

// The media-server renderer is the exact path because it uses LibreOffice and
// Poppler. Browser-rendered PPTX output remains opt-in so callers can use it as
// a visual fallback without ever accepting text-only slide reconstruction.
export const ALLOW_BROWSER_POWERPOINT_VISUAL_FALLBACK = false;

const PPTX_IMAGE_MIME_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

let pdfWorkerConfigured = false;

interface PresentationPreviewOptions {
  mediaHttpUrl?: string;
  fetchImpl?: typeof fetch;
  serverRenderTimeoutMs?: number;
  skipServerRender?: boolean;
  requireRenderedSlides?: boolean;
  requireServerRenderedPowerPoint?: boolean;
  allowBrowserPowerPointRenderFallback?: boolean;
  allowTextPowerPointFallback?: boolean;
  pptxSlideImageRenderer?: (arrayBuffer: ArrayBuffer, expectedSlideCount: number) => Promise<string[]>;
  onServerRenderFailure?: (failure: PresentationServerRenderFailure) => void;
}

interface ServerPresentationPreviewResponse {
  kind?: unknown;
  sourceFormat?: unknown;
  slides?: unknown;
}

interface PptxSlideSize {
  cx: number;
  cy: number;
}

export interface PresentationServerRenderFailure {
  status?: number;
  code?: string;
  message: string;
  renderRouting?: string;
  timedOut?: boolean;
}

export function isRecoverablePowerPointServerRenderFailure(failure: PresentationServerRenderFailure | undefined): boolean {
  const code = failure?.code?.toUpperCase();
  const routing = failure?.renderRouting?.toLowerCase();
  return Boolean(
    routing === 'no-server' ||
    failure?.timedOut ||
    code === 'MEDIA_SERVER_NO_SERVER' ||
    code === 'PRESENTATION_RENDER_TIMEOUT' ||
    code === 'PRESENTATION_RENDER_UNAVAILABLE' ||
    code === 'PRESENTATION_RENDERER_UNAVAILABLE' ||
    code === 'PRESENTATION_RENDER_INCOMPLETE' ||
    code === 'PRESENTATION_RENDER_FAILED' ||
    code === 'PRESENTATION_RENDER_EMPTY'
  );
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cleanPreviewText(value: string): string {
  return decodeXmlText(value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREVIEW_TEXT_LENGTH);
}

function getXmlAttribute(tag: string, attributeName: string): string | null {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\s${escapedName}=(["'])([\\s\\S]*?)\\1`, 'i'));
  return match?.[2] ? decodeXmlText(match[2]) : null;
}

function getXmlNumberAttribute(tag: string, attributeName: string): number | null {
  const value = getXmlAttribute(tag, attributeName);
  if (!value || !/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeZipPath(path: string): string {
  const normalizedParts: string[] = [];

  path.replace(/\\/g, '/').split('/').forEach((part) => {
    if (!part || part === '.') return;
    if (part === '..') {
      normalizedParts.pop();
      return;
    }
    normalizedParts.push(part);
  });

  return normalizedParts.join('/');
}

function getSlideRelationshipPath(slidePath: string): string {
  const fileName = slidePath.split('/').pop() || slidePath;
  return `ppt/slides/_rels/${fileName}.rels`;
}

function resolveSlideRelationshipTarget(target: string): string | null {
  const cleanTarget = decodeXmlText(target).trim().replace(/\\/g, '/');
  if (!cleanTarget || /^[a-z][a-z\d+.-]*:/i.test(cleanTarget)) return null;

  if (cleanTarget.startsWith('/')) {
    return normalizeZipPath(cleanTarget.slice(1));
  }

  return normalizeZipPath(`ppt/slides/${cleanTarget}`);
}

function getImageMimeType(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase() || '';
  return PPTX_IMAGE_MIME_TYPES[extension] || null;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function isPptxFile(file: Pick<File, 'name' | 'type'>): boolean {
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith('.pptx') ||
    lower.endsWith('.ppsx') ||
    lower.endsWith('.potx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.template'
  );
}

export function canBrowserRenderPowerPointFile(file: Pick<File, 'name' | 'type'>): boolean {
  return isPptxFile(file);
}

export interface PowerPointRenderStrategy {
  allowBrowserPowerPointRenderFallback: boolean;
  requireServerRenderedPowerPoint: boolean;
}

export function getPowerPointRenderStrategy(
  file: Pick<File, 'name' | 'type'>
): PowerPointRenderStrategy {
  const allowBrowserPowerPointRenderFallback = canBrowserRenderPowerPointFile(file);
  return {
    allowBrowserPowerPointRenderFallback,
    requireServerRenderedPowerPoint: !allowBrowserPowerPointRenderFallback,
  };
}

export function isLegacyPowerPointFile(file: Pick<File, 'name' | 'type'>): boolean {
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith('.ppt') ||
    lower.endsWith('.pps') ||
    lower.endsWith('.pot') ||
    file.type === 'application/vnd.ms-powerpoint'
  );
}

export function isPowerPointFile(file: Pick<File, 'name' | 'type'>): boolean {
  return isPptxFile(file) || isLegacyPowerPointFile(file);
}

export function isPdfFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export function extractPptxSlideText(xml: string): string[] {
  const matches = xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g);
  const values: string[] = [];

  for (const match of matches) {
    const value = cleanPreviewText(match[1] || '');
    if (value) values.push(value);
  }

  return values;
}

export function extractPptxSlideImageTargets(relsXml: string): string[] {
  const targets: string[] = [];
  const relationships = relsXml.matchAll(/<Relationship\b[^>]*>/gi);

  for (const relationship of relationships) {
    const tag = relationship[0];
    const type = getXmlAttribute(tag, 'Type');
    const target = getXmlAttribute(tag, 'Target');
    const targetMode = getXmlAttribute(tag, 'TargetMode');
    if (!type?.toLowerCase().endsWith('/image') || !target || targetMode?.toLowerCase() === 'external') continue;

    const resolvedTarget = resolveSlideRelationshipTarget(target);
    if (resolvedTarget && getImageMimeType(resolvedTarget) && !targets.includes(resolvedTarget)) {
      targets.push(resolvedTarget);
    }
  }

  return targets;
}

function getPptxImageRelationshipTargetsById(relsXml: string): Map<string, string> {
  const targets = new Map<string, string>();
  const relationships = relsXml.matchAll(/<Relationship\b[^>]*>/gi);

  for (const relationship of relationships) {
    const tag = relationship[0];
    const id = getXmlAttribute(tag, 'Id');
    const type = getXmlAttribute(tag, 'Type');
    const target = getXmlAttribute(tag, 'Target');
    const targetMode = getXmlAttribute(tag, 'TargetMode');
    if (!id || !type?.toLowerCase().endsWith('/image') || !target || targetMode?.toLowerCase() === 'external') continue;

    const resolvedTarget = resolveSlideRelationshipTarget(target);
    if (resolvedTarget && getImageMimeType(resolvedTarget)) {
      targets.set(id, resolvedTarget);
    }
  }

  return targets;
}

function extractImageEmbedId(picXml: string): string | null {
  const blipMatch = picXml.match(/<(?:\w+:)?blip\b[^>]*(?:\br:embed|\bembed)=(["'])([\s\S]*?)\1[^>]*>/i);
  return blipMatch?.[2] ? decodeXmlText(blipMatch[2]).trim() : null;
}

function extractXfrmTag(picXml: string, tagName: 'off' | 'ext'): string | null {
  const match = picXml.match(new RegExp(`<(?:\\w+:)?${tagName}\\b[^>]*>`, 'i'));
  return match?.[0] || null;
}

function isFullSlideImageTransform(picXml: string, slideSize: PptxSlideSize): boolean {
  const offTag = extractXfrmTag(picXml, 'off');
  const extTag = extractXfrmTag(picXml, 'ext');
  if (!offTag || !extTag) return false;

  const x = getXmlNumberAttribute(offTag, 'x');
  const y = getXmlNumberAttribute(offTag, 'y');
  const cx = getXmlNumberAttribute(extTag, 'cx');
  const cy = getXmlNumberAttribute(extTag, 'cy');
  if (x === null || y === null || cx === null || cy === null) return false;

  return (
    Math.abs(x) <= FULL_SLIDE_IMAGE_TOLERANCE_EMU &&
    Math.abs(y) <= FULL_SLIDE_IMAGE_TOLERANCE_EMU &&
    Math.abs(cx - slideSize.cx) <= Math.max(FULL_SLIDE_IMAGE_TOLERANCE_EMU, slideSize.cx * 0.02) &&
    Math.abs(cy - slideSize.cy) <= Math.max(FULL_SLIDE_IMAGE_TOLERANCE_EMU, slideSize.cy * 0.02)
  );
}

function extractPptxPictureBlocks(slideXml: string): string[] {
  const prefixedBlocks = Array.from(slideXml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/gi), (match) => match[0]);
  if (prefixedBlocks.length > 0) return prefixedBlocks;
  return Array.from(slideXml.matchAll(/<pic\b[\s\S]*?<\/pic>/gi), (match) => match[0]);
}

export function extractPptxFullSlideImageTarget(
  slideXml: string,
  relsXml: string,
  slideSize: PptxSlideSize = { cx: DEFAULT_PPTX_SLIDE_WIDTH_EMU, cy: DEFAULT_PPTX_SLIDE_HEIGHT_EMU }
): string | null {
  const targetsById = getPptxImageRelationshipTargetsById(relsXml);
  if (targetsById.size === 0) return null;

  for (const picXml of extractPptxPictureBlocks(slideXml)) {
    const embedId = extractImageEmbedId(picXml);
    const target = embedId ? targetsById.get(embedId) : undefined;
    if (target && isFullSlideImageTransform(picXml, slideSize)) return target;
  }

  return null;
}

export function extractPptxSlideNotesTarget(relsXml: string): string | null {
  const relationships = relsXml.matchAll(/<Relationship\b[^>]*>/gi);

  for (const relationship of relationships) {
    const tag = relationship[0];
    const type = getXmlAttribute(tag, 'Type');
    const target = getXmlAttribute(tag, 'Target');
    const targetMode = getXmlAttribute(tag, 'TargetMode');
    if (!type?.toLowerCase().endsWith('/notesslide') || !target || targetMode?.toLowerCase() === 'external') continue;
    const resolvedTarget = resolveSlideRelationshipTarget(target);
    if (resolvedTarget && /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(resolvedTarget)) return resolvedTarget;
  }

  return null;
}

export function extractPptxSpeakerNotes(notesXml: string, slideTextRuns: string[] = []): string[] {
  const slideText = new Set(slideTextRuns.map((line) => line.toLowerCase()));
  const placeholderText = new Set([
    'click to add notes',
    'click to add text',
    'notes',
  ]);
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const value of extractPptxSlideText(notesXml)) {
    const key = value.toLowerCase();
    if (slideText.has(key) || placeholderText.has(key) || seen.has(key)) continue;
    notes.push(value);
    seen.add(key);
    if (notes.length >= MAX_PREVIEW_NOTES_PER_SLIDE) break;
  }

  return notes;
}

async function buildSlideImageDataUrl(zip: JSZip, imageTarget: string): Promise<string | undefined> {
  const mimeType = getImageMimeType(imageTarget);
  const entry = zip.file(imageTarget);
  if (!mimeType || !entry) return undefined;

  const bytes = await entry.async('uint8array');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SLIDE_IMAGE_BYTES) return undefined;
  return `data:${mimeType};base64,${uint8ArrayToBase64(bytes)}`;
}

async function buildBestSlideImageDataUrl(zip: JSZip, imageTargets: string[]): Promise<string | undefined> {
  let bestImage: { bytes: Uint8Array; mimeType: string } | null = null;

  for (const target of imageTargets.slice(0, MAX_SLIDE_IMAGE_CANDIDATES)) {
    const mimeType = getImageMimeType(target);
    const entry = zip.file(target);
    if (!mimeType || !entry) continue;

    const bytes = await entry.async('uint8array');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SLIDE_IMAGE_BYTES) continue;
    if (!bestImage || bytes.byteLength > bestImage.bytes.byteLength) {
      bestImage = { bytes, mimeType };
    }
  }

  if (!bestImage) return undefined;
  return `data:${bestImage.mimeType};base64,${uint8ArrayToBase64(bestImage.bytes)}`;
}

function buildSlidePreview(
  path: string,
  textRuns: string[],
  index: number,
  imageUrl?: string,
  notes: string[] = [],
  rendered = false
): PresentationSlidePreview {
  const fallbackTitle = `Slide ${index + 1}`;
  const title = textRuns[0] || fallbackTitle;
  const lines = textRuns
    .slice(textRuns[0] ? 1 : 0)
    .filter((line, lineIndex, allLines) => allLines.indexOf(line) === lineIndex)
    .slice(0, MAX_PREVIEW_LINES_PER_SLIDE);

  return {
    id: path,
    title,
    lines,
    ...(imageUrl ? { imageUrl } : {}),
    ...(rendered && imageUrl ? { rendered: true } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

async function getPptxSlideSize(zip: JSZip): Promise<PptxSlideSize> {
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('text');
  const sldSzTag = presentationXml?.match(/<(?:\w+:)?sldSz\b[^>]*>/i)?.[0];
  const cx = sldSzTag ? getXmlNumberAttribute(sldSzTag, 'cx') : null;
  const cy = sldSzTag ? getXmlNumberAttribute(sldSzTag, 'cy') : null;

  return {
    cx: cx && cx > 0 ? cx : DEFAULT_PPTX_SLIDE_WIDTH_EMU,
    cy: cy && cy > 0 ? cy : DEFAULT_PPTX_SLIDE_HEIGHT_EMU,
  };
}

export function applyRenderedSlideImages(
  slides: PresentationSlidePreview[],
  renderedImageUrls: Array<string | undefined>
): PresentationSlidePreview[] {
  return slides.map((slide, index) => (
    renderedImageUrls[index]
      ? { ...slide, imageUrl: renderedImageUrls[index], rendered: true }
      : slide
  ));
}

function isRenderedSlideImageUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^data:image\/(?:png|jpeg|jpg|webp);base64,/i.test(value)
  );
}

export function hasRenderedPresentationSlides(preview: StudioMediaAssetPreview | undefined): boolean {
  return Boolean(
    preview?.slides.length &&
    preview.slides.every((slide) => slide.rendered === true && isRenderedSlideImageUrl(slide.imageUrl))
  );
}

function isValidRenderedSlide(value: unknown): value is PresentationSlidePreview {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PresentationSlidePreview>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    Array.isArray(candidate.lines) &&
    candidate.lines.every((line) => typeof line === 'string') &&
    (candidate.notes === undefined || (
      Array.isArray(candidate.notes) &&
      candidate.notes.every((note) => typeof note === 'string')
    )) &&
    typeof candidate.imageUrl === 'string' &&
    isRenderedSlideImageUrl(candidate.imageUrl)
  );
}

function normalizeServerPreview(value: ServerPresentationPreviewResponse): StudioMediaAssetPreview | undefined {
  if (
    value.kind !== 'presentation-slides' ||
    (value.sourceFormat !== 'pptx' && value.sourceFormat !== 'pdf') ||
    !Array.isArray(value.slides)
  ) {
    return undefined;
  }

  const slides = value.slides
    .filter(isValidRenderedSlide)
    .map((slide) => ({ ...slide, rendered: true }))
    .slice(0, MAX_PREVIEW_SLIDES);

  return slides.length > 0
    ? { kind: 'presentation-slides', sourceFormat: value.sourceFormat, slides }
    : undefined;
}

function getSafeFileNameHeader(fileName: string): string {
  return fileName
    .replace(/[\r\n]/g, ' ')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim()
    .slice(0, 180) || 'presentation';
}

function buildMediaServerUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function canTryServerRender(options: PresentationPreviewOptions): boolean {
  if (options.mediaHttpUrl) return true;
  return typeof window !== 'undefined' && typeof fetch === 'function';
}

async function readServerRenderFailure(response: Response): Promise<PresentationServerRenderFailure> {
  const renderRouting = response.headers.get('x-render-routing') || undefined;
  const text = await response.text().catch(() => '');
  let code: string | undefined;
  let message = text.trim();

  if (text) {
    try {
      const json = JSON.parse(text) as { error?: unknown; code?: unknown; message?: unknown };
      if (typeof json.code === 'string') code = json.code;
      if (typeof json.error === 'string') message = json.error;
      else if (typeof json.message === 'string') message = json.message;
    } catch {
      // Keep the plain text body.
    }
  }

  if (renderRouting?.toLowerCase() === 'no-server') {
    message = 'Media server is not provisioned on Render.';
    code = code || 'MEDIA_SERVER_NO_SERVER';
  } else if (!message) {
    message = `Media server returned HTTP ${response.status}.`;
  }

  return {
    status: response.status,
    ...(code ? { code } : {}),
    message,
    ...(renderRouting ? { renderRouting } : {}),
  };
}

export async function buildServerRenderedPresentationPreview(
  file: File,
  options: PresentationPreviewOptions = {}
): Promise<StudioMediaAssetPreview | undefined> {
  if (options.skipServerRender) return undefined;
  if (!canTryServerRender(options) || file.size > MAX_PRESENTATION_PREVIEW_BYTES) return undefined;

  const mediaHttpUrl = (options.mediaHttpUrl || resolveMediaHttpUrl()).trim();
  const fetchImpl = options.fetchImpl || fetch;
  if (!mediaHttpUrl || typeof fetchImpl !== 'function') return undefined;

  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(),
    Math.max(1_000, options.serverRenderTimeoutMs || SERVER_RENDER_TIMEOUT_MS)
  );

  try {
    const response = await fetchImpl(buildMediaServerUrl(mediaHttpUrl, '/presentation-preview'), {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': getSafeFileNameHeader(file.name),
      },
      body: file,
      signal: controller.signal,
    });

    if (!response.ok) {
      options.onServerRenderFailure?.(await readServerRenderFailure(response));
      return undefined;
    }
    const preview = normalizeServerPreview(await response.json() as ServerPresentationPreviewResponse);
    if (!preview) {
      options.onServerRenderFailure?.({
        status: response.status,
        code: 'PRESENTATION_RENDER_INCOMPLETE',
        message: 'Media server returned a presentation preview without rendered slide artwork.',
      });
    }
    return preview;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      options.onServerRenderFailure?.({
        message: 'Media server presentation rendering timed out.',
        code: 'PRESENTATION_RENDER_TIMEOUT',
        timedOut: true,
      });
    } else {
      console.warn('Media server presentation render unavailable:', err);
      options.onServerRenderFailure?.({
        message: err instanceof Error ? err.message : 'Media server presentation render is unavailable.',
        code: 'PRESENTATION_RENDER_UNAVAILABLE',
      });
    }
    return undefined;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

export function mergeRenderedPresentationPreview(
  slides: PresentationSlidePreview[],
  renderedPreview: StudioMediaAssetPreview | undefined,
  sourceFormat: StudioMediaAssetPreview['sourceFormat']
): StudioMediaAssetPreview | undefined {
  if (!renderedPreview?.slides.length) {
    return slides.length > 0
      ? { kind: 'presentation-slides', sourceFormat, slides }
      : undefined;
  }

  const total = Math.max(slides.length, renderedPreview.slides.length);
  const mergedSlides = Array.from({ length: total }, (_, index) => {
    const extractedSlide = slides[index];
    const renderedSlide = renderedPreview.slides[index];
    const fallbackTitle = sourceFormat === 'pdf' ? `Page ${index + 1}` : `Slide ${index + 1}`;
    return {
      id: extractedSlide?.id || renderedSlide?.id || `${sourceFormat}-slide-${index + 1}`,
      title: extractedSlide?.title || renderedSlide?.title || fallbackTitle,
      lines: extractedSlide?.lines || renderedSlide?.lines || [],
      ...((extractedSlide?.notes || renderedSlide?.notes)?.length ? { notes: extractedSlide?.notes || renderedSlide?.notes } : {}),
      ...(renderedSlide?.imageUrl ? { imageUrl: renderedSlide.imageUrl, rendered: true } : {}),
    };
  });

  return {
    kind: 'presentation-slides',
    sourceFormat,
    slides: mergedSlides,
  };
}

function canUseDomPresentationRenderer(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function' &&
    typeof document.body?.appendChild === 'function' &&
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function'
  );
}

function canUseCanvasPdfRenderer(): boolean {
  if (
    typeof document === 'undefined' ||
    typeof document.createElement !== 'function' ||
    typeof window === 'undefined'
  ) {
    return false;
  }

  const canvas = document.createElement('canvas');
  return typeof canvas.getContext === 'function' && typeof canvas.toDataURL === 'function';
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function waitForPresentationTimeout(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(), RENDER_SETTLE_TIMEOUT_MS);
  });
}

async function waitForDocumentFonts(): Promise<void> {
  await document.fonts?.ready.catch(() => undefined);
}

async function waitForPresentationRender(node: HTMLElement): Promise<void> {
  for (let index = 0; index < RENDER_SETTLE_FRAMES; index += 1) {
    await waitForAnimationFrame();
  }
  await waitForDocumentFonts();
  await waitForPresentationTimeout();

  const images = Array.from(node.querySelectorAll('img'));
  await Promise.all(images.map(async (image) => {
    if (image.complete) return;
    if (typeof image.decode === 'function') {
      await image.decode().catch(() => undefined);
      return;
    }
    await new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
  }));

  await waitForAnimationFrame();
}

function createHiddenPresentationRenderHost(): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.left = '-20000px';
  host.style.top = '0';
  host.style.width = `${RENDERED_SLIDE_WIDTH}px`;
  host.style.height = `${RENDERED_SLIDE_HEIGHT}px`;
  host.style.overflow = 'hidden';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '0';
  host.style.contain = 'layout paint style';
  host.style.background = '#ffffff';
  document.body.appendChild(host);
  return host;
}

function getVisibleSlideNode(host: HTMLElement, slideIndex: number): HTMLElement | null {
  const indexedSlide = host.querySelector(`.pptx-preview-slide-wrapper-${slideIndex}`);
  if (indexedSlide instanceof HTMLElement) return indexedSlide;

  const renderedSlides = Array.from(host.querySelectorAll('.pptx-preview-slide-wrapper'))
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  return renderedSlides[renderedSlides.length - 1] || null;
}

function prepareSlideNodeForCapture(slideNode: HTMLElement): { width: number; height: number } | null {
  slideNode.style.margin = '0';
  slideNode.style.boxSizing = 'border-box';

  const bounds = slideNode.getBoundingClientRect();
  const width = Math.round(bounds.width);
  const height = Math.round(bounds.height);
  if (width <= 0 || height <= 0 || slideNode.childElementCount === 0) return null;
  return { width, height };
}

async function renderPptxSlidesToImages(arrayBuffer: ArrayBuffer, expectedSlideCount: number): Promise<string[]> {
  if (!canUseDomPresentationRenderer() || expectedSlideCount <= 0) return [];

  const host = createHiddenPresentationRenderHost();
  let previewer: { load: (file: ArrayBuffer) => Promise<unknown>; renderSingleSlide: (slideIndex: number) => void; destroy: () => void; slideCount?: number } | null = null;

  try {
    const [{ init }, { toJpeg, toPng }] = await Promise.all([
      import('pptx-preview'),
      import('html-to-image'),
    ]);
    previewer = init(host, {
      width: RENDERED_SLIDE_WIDTH,
      height: RENDERED_SLIDE_HEIGHT,
      mode: 'slide',
    });
    const previewCapable = previewer as typeof previewer & { preview?: (file: ArrayBuffer) => Promise<unknown> };
    if (typeof previewCapable?.preview === 'function') {
      await previewCapable.preview(arrayBuffer.slice(0));
    } else {
      await previewer.load(arrayBuffer.slice(0));
    }

    const slideCount = Math.min(
      expectedSlideCount,
      Number.isFinite(previewer.slideCount) ? Math.max(0, Math.floor(previewer.slideCount || 0)) : expectedSlideCount,
      MAX_PREVIEW_SLIDES
    );
    const imageUrls: string[] = [];

    for (let index = 0; index < slideCount; index += 1) {
      if (index > 0) {
        previewer.renderSingleSlide(index);
        await waitForAnimationFrame();
      }
      const slideNode = getVisibleSlideNode(host, index);
      if (!slideNode) {
        imageUrls.push('');
        continue;
      }

      const dimensions = prepareSlideNodeForCapture(slideNode);
      if (!dimensions) {
        imageUrls.push('');
        continue;
      }

      await waitForPresentationRender(slideNode);
      const captureOptions = {
        width: dimensions.width,
        height: dimensions.height,
        pixelRatio: 1,
        backgroundColor: '#ffffff',
      };
      const imageUrl = await toPng(slideNode, captureOptions)
        .catch(() => toJpeg(slideNode, { ...captureOptions, quality: 0.94 }));
      imageUrls.push(isRenderedSlideImageUrl(imageUrl) ? imageUrl : '');
    }

    return imageUrls;
  } catch (err) {
    console.warn('Failed to render PowerPoint slide visuals:', err);
    return [];
  } finally {
    previewer?.destroy();
    host.remove();
  }
}

async function renderPptxSlidesWithConfiguredRenderer(
  arrayBuffer: ArrayBuffer,
  expectedSlideCount: number,
  options: PresentationPreviewOptions
): Promise<string[]> {
  const renderer = options.pptxSlideImageRenderer || renderPptxSlidesToImages;
  return renderer(arrayBuffer.slice(0), expectedSlideCount);
}

function buildPdfPagePreview(pageNumber: number, imageUrl: string): PresentationSlidePreview {
  return {
    id: `pdf-page-${pageNumber}`,
    title: `Page ${pageNumber}`,
    lines: [],
    imageUrl,
    rendered: true,
  };
}

function configurePdfWorker(pdfjs: typeof import('pdfjs-dist')) {
  if (pdfWorkerConfigured || typeof window === 'undefined') return;
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
  pdfWorkerConfigured = true;
}

async function renderPdfPagesToImages(arrayBuffer: ArrayBuffer): Promise<PresentationSlidePreview[]> {
  if (!canUseCanvasPdfRenderer()) return [];

  try {
    const pdfjs = await import('pdfjs-dist');
    configurePdfWorker(pdfjs);
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer.slice(0)),
      disableAutoFetch: true,
      disableStream: true,
    });
    try {
      const pdf = await loadingTask.promise;
      const pageCount = Math.min(pdf.numPages, MAX_PREVIEW_SLIDES);
      const slides: PresentationSlidePreview[] = [];

      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const scale = Math.min(
          PDF_RENDER_SCALE_LIMIT,
          RENDERED_SLIDE_WIDTH / viewport.width,
          RENDERED_SLIDE_HEIGHT / viewport.height
        );
        const renderViewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          page.cleanup();
          continue;
        }

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
          canvas,
          viewport: renderViewport,
          background: '#ffffff',
        }).promise;
        slides.push(buildPdfPagePreview(pageNumber, canvas.toDataURL('image/png')));
        page.cleanup();
      }

      return slides;
    } finally {
      await loadingTask.destroy().catch(() => undefined);
    }
  } catch (err) {
    console.warn('Failed to render PDF page visuals:', err);
    return [];
  }
}

async function buildPdfPresentationPreview(
  file: File,
  options: PresentationPreviewOptions = {}
): Promise<StudioMediaAssetPreview | undefined> {
  if (!isPdfFile(file) || file.size > MAX_PRESENTATION_PREVIEW_BYTES) return undefined;

  const serverPreview = await buildServerRenderedPresentationPreview(file, options);
  if (serverPreview && (!options.requireRenderedSlides || hasRenderedPresentationSlides(serverPreview))) return serverPreview;

  const slides = await renderPdfPagesToImages(await file.arrayBuffer());
  const preview: StudioMediaAssetPreview | undefined = slides.length > 0
    ? { kind: 'presentation-slides', sourceFormat: 'pdf', slides }
    : undefined;
  return options.requireRenderedSlides && !hasRenderedPresentationSlides(preview) ? undefined : preview;
}

function getSortedSlidePaths(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => {
      const aIndex = Number(a.match(/slide(\d+)\.xml$/i)?.[1] || 0);
      const bIndex = Number(b.match(/slide(\d+)\.xml$/i)?.[1] || 0);
      return aIndex - bIndex;
    })
    .slice(0, MAX_PREVIEW_SLIDES);
}

export async function buildPresentationPreview(
  file: File,
  options: PresentationPreviewOptions = {}
): Promise<StudioMediaAssetPreview | undefined> {
  if (isPdfFile(file)) {
    return buildPdfPresentationPreview(file, options);
  }

  if (!isPowerPointFile(file) || file.size > MAX_PRESENTATION_PREVIEW_BYTES) return undefined;

  const allowBrowserPowerPointRenderFallback = options.allowBrowserPowerPointRenderFallback === true;
  const requireRenderedSlides = options.requireRenderedSlides === true;
  const requireServerRenderedPowerPoint = options.requireServerRenderedPowerPoint === true ||
    (requireRenderedSlides && !allowBrowserPowerPointRenderFallback);
  const serverPreviewPromise = buildServerRenderedPresentationPreview(file, options).catch(() => undefined);

  if (isLegacyPowerPointFile(file)) {
    const serverPreview = await serverPreviewPromise;
    return requireServerRenderedPowerPoint && !hasRenderedPresentationSlides(serverPreview) ? undefined : serverPreview;
  }

  try {
    const { default: JSZip } = await import('jszip');
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const slideSize = await getPptxSlideSize(zip);
    const slidePaths = getSortedSlidePaths(zip);
    const slides: PresentationSlidePreview[] = [];

    for (const [index, path] of slidePaths.entries()) {
      const entry = zip.file(path);
      if (!entry) continue;
      const xml = await entry.async('text');
      const textRuns = extractPptxSlideText(xml);
      const relsXml = await zip.file(getSlideRelationshipPath(path))?.async('text');
      const fullSlideImageTarget = relsXml ? extractPptxFullSlideImageTarget(xml, relsXml, slideSize) : null;
      const imageUrl = fullSlideImageTarget
        ? await buildSlideImageDataUrl(zip, fullSlideImageTarget)
        : (relsXml
            ? await buildBestSlideImageDataUrl(zip, extractPptxSlideImageTargets(relsXml))
            : undefined);
      const notesPath = relsXml ? extractPptxSlideNotesTarget(relsXml) : null;
      const notesXml = notesPath ? await zip.file(notesPath)?.async('text') : undefined;
      const notes = notesXml ? extractPptxSpeakerNotes(notesXml, textRuns) : [];
      slides.push(buildSlidePreview(path, textRuns, index, imageUrl, notes, Boolean(fullSlideImageTarget && imageUrl)));
    }

    const extractedRenderedPreview: StudioMediaAssetPreview | undefined = slides.length > 0
      ? { kind: 'presentation-slides', sourceFormat: 'pptx', slides }
      : undefined;
    if (hasRenderedPresentationSlides(extractedRenderedPreview)) return extractedRenderedPreview;

    const serverPreview = await serverPreviewPromise;
    if (serverPreview) {
      const mergedServerPreview = mergeRenderedPresentationPreview(slides, serverPreview, 'pptx');
      if (!requireServerRenderedPowerPoint || hasRenderedPresentationSlides(mergedServerPreview)) {
        return mergedServerPreview;
      }
    }

    if (requireServerRenderedPowerPoint) return undefined;

    if (allowBrowserPowerPointRenderFallback) {
      const renderedImageUrls = await renderPptxSlidesWithConfiguredRenderer(arrayBuffer, slides.length, options);
      const browserRenderedSlides = applyRenderedSlideImages(slides, renderedImageUrls);
      const browserRenderedPreview: StudioMediaAssetPreview | undefined = browserRenderedSlides.length > 0
        ? { kind: 'presentation-slides', sourceFormat: 'pptx', slides: browserRenderedSlides }
        : undefined;
      if (hasRenderedPresentationSlides(browserRenderedPreview)) return browserRenderedPreview;
      if (options.requireRenderedSlides) return undefined;
    }

    const preview: StudioMediaAssetPreview | undefined = options.allowTextPowerPointFallback && slides.length > 0
      ? { kind: 'presentation-slides', sourceFormat: 'pptx', slides }
      : undefined;
    return (options.requireRenderedSlides || requireServerRenderedPowerPoint) && !hasRenderedPresentationSlides(preview)
      ? undefined
      : preview;
  } catch {
    const serverPreview = await serverPreviewPromise;
    return requireServerRenderedPowerPoint && !hasRenderedPresentationSlides(serverPreview) ? undefined : serverPreview;
  }
}
