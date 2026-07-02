import type JSZip from 'jszip';
import type { StudioMediaAssetPreview, PresentationSlidePreview } from '@studio/shared';

const MAX_PRESENTATION_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_SLIDES = 60;
const MAX_PREVIEW_LINES_PER_SLIDE = 10;
const MAX_PREVIEW_TEXT_LENGTH = 180;

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

function buildSlidePreview(path: string, textRuns: string[], index: number): PresentationSlidePreview {
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
      slides.push(buildSlidePreview(path, textRuns, index));
    }

    return slides.length > 0
      ? { kind: 'presentation-slides', sourceFormat: 'pptx', slides }
      : undefined;
  } catch {
    return undefined;
  }
}
