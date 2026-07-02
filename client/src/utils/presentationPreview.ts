import type JSZip from 'jszip';
import type { StudioMediaAssetPreview, PresentationSlidePreview } from '@studio/shared';

const MAX_PRESENTATION_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_SLIDES = 60;
const MAX_PREVIEW_LINES_PER_SLIDE = 10;
const MAX_PREVIEW_TEXT_LENGTH = 180;
const MAX_SLIDE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SLIDE_IMAGE_CANDIDATES = 12;

const PPTX_IMAGE_MIME_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

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
  return lower.endsWith('.pptx') || file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
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

function buildSlidePreview(path: string, textRuns: string[], index: number, imageUrl?: string): PresentationSlidePreview {
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
  };
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

export async function buildPresentationPreview(file: File): Promise<StudioMediaAssetPreview | undefined> {
  if (!isPptxFile(file) || file.size > MAX_PRESENTATION_PREVIEW_BYTES) return undefined;

  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slidePaths = getSortedSlidePaths(zip);
    const slides: PresentationSlidePreview[] = [];

    for (const [index, path] of slidePaths.entries()) {
      const entry = zip.file(path);
      if (!entry) continue;
      const xml = await entry.async('text');
      const textRuns = extractPptxSlideText(xml);
      const relsXml = await zip.file(getSlideRelationshipPath(path))?.async('text');
      const imageUrl = relsXml
        ? await buildBestSlideImageDataUrl(zip, extractPptxSlideImageTargets(relsXml))
        : undefined;
      slides.push(buildSlidePreview(path, textRuns, index, imageUrl));
    }

    return slides.length > 0
      ? { kind: 'presentation-slides', sourceFormat: 'pptx', slides }
      : undefined;
  } catch {
    return undefined;
  }
}
