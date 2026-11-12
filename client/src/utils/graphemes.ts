/**
 * Splits text into user-perceived characters (a flag, a family emoji, an
 * emoji with its skin tone, a letter with its accents), so cutting and
 * wrapping never tear one apart. Uses Intl.Segmenter when the browser has it
 * and falls back to code points (still correct for plain text).
 */
type GraphemeSegmenter = { segment: (input: string) => Iterable<{ segment: string }> };
type SegmenterConstructor = new (locales?: string | string[], options?: { granularity: 'grapheme' }) => GraphemeSegmenter;

const SegmenterCtor: SegmenterConstructor | undefined = typeof Intl !== 'undefined'
  ? (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter
  : undefined;
// Created once: building a segmenter is far costlier than using it.
const segmenter: GraphemeSegmenter | null = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: 'grapheme' }) : null;

export function splitGraphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

/** The same split with the Array.from fallback forced (tests the old-browser path). */
export function splitCodePoints(text: string): string[] {
  return Array.from(text);
}
