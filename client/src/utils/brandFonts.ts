import {
  BRAND_FONT_PRESET_IDS,
  normalizeBrandFont,
  normalizeBrandFontFamilyName,
  type BrandFont,
  type BrandFontPresetId,
} from '@studio/shared';

/**
 * Brand typefaces for banners, tickers, lower thirds and widget text.
 *
 * Presets are open-licence faces bundled by Vite from @fontsource (same
 * origin, so the CSP's font-src 'self' covers them and no visitor IP goes to a
 * font CDN); each is fetched only when chosen. An uploaded font file is kept
 * in this browser's IndexedDB (brandFontStore.ts) and registered with the
 * FontFace API. Canvas text never waits for fonts by itself, so callers load
 * the face (loadBrandFontFaces) before handing its family to the compositor.
 */

export { BRAND_FONT_PRESET_IDS, normalizeBrandFont, normalizeBrandFontFamilyName };
export type { BrandFont, BrandFontPresetId };

/** The face the studio draws with when no brand font is set. */
export const DEFAULT_CANVAS_FONT_FAMILY = 'Inter, Arial, sans-serif';
/** Weights the program canvas draws text with. */
export const BRAND_FONT_CANVAS_WEIGHTS = [400, 500, 600, 700, 800, 900] as const;
export const MAX_BRAND_FONT_FILE_BYTES = 4 * 1024 * 1024;
export const BRAND_FONT_FILE_ACCEPT = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf';
const BRAND_FONT_EXTENSIONS = ['.woff2', '.woff', '.ttf', '.otf'];

export interface BrandFontPreset {
  id: BrandFontPresetId;
  label: string;
  /** The CSS family name the @fontsource stylesheet registers. */
  family: string;
  /** Generic fallback after Inter. */
  fallback: 'sans-serif' | 'serif';
  weights: readonly number[];
  load: () => Promise<unknown>;
}

// Static import strings so Vite bundles each stylesheet (and its woff2) as a lazy chunk.
export const BRAND_FONT_PRESETS: readonly BrandFontPreset[] = [
  {
    id: 'inter',
    label: 'Inter',
    family: 'Inter',
    fallback: 'sans-serif',
    weights: [400, 500, 600, 700, 800, 900],
    // Bundled eagerly by main.tsx.
    load: () => Promise.resolve(),
  },
  {
    id: 'montserrat',
    label: 'Montserrat',
    family: 'Montserrat',
    fallback: 'sans-serif',
    weights: [500, 600, 700, 800, 900],
    load: () => Promise.all([
      import('@fontsource/montserrat/latin-500.css'),
      import('@fontsource/montserrat/latin-600.css'),
      import('@fontsource/montserrat/latin-700.css'),
      import('@fontsource/montserrat/latin-800.css'),
      import('@fontsource/montserrat/latin-900.css'),
    ]),
  },
  {
    id: 'poppins',
    label: 'Poppins',
    family: 'Poppins',
    fallback: 'sans-serif',
    weights: [500, 600, 700, 800, 900],
    load: () => Promise.all([
      import('@fontsource/poppins/latin-500.css'),
      import('@fontsource/poppins/latin-600.css'),
      import('@fontsource/poppins/latin-700.css'),
      import('@fontsource/poppins/latin-800.css'),
      import('@fontsource/poppins/latin-900.css'),
    ]),
  },
  {
    id: 'oswald',
    label: 'Oswald',
    family: 'Oswald',
    fallback: 'sans-serif',
    weights: [400, 500, 600, 700],
    load: () => Promise.all([
      import('@fontsource/oswald/latin-400.css'),
      import('@fontsource/oswald/latin-500.css'),
      import('@fontsource/oswald/latin-600.css'),
      import('@fontsource/oswald/latin-700.css'),
    ]),
  },
  {
    id: 'playfair-display',
    label: 'Playfair Display',
    family: 'Playfair Display',
    fallback: 'serif',
    weights: [500, 600, 700, 800, 900],
    load: () => Promise.all([
      import('@fontsource/playfair-display/latin-500.css'),
      import('@fontsource/playfair-display/latin-600.css'),
      import('@fontsource/playfair-display/latin-700.css'),
      import('@fontsource/playfair-display/latin-800.css'),
      import('@fontsource/playfair-display/latin-900.css'),
    ]),
  },
  {
    id: 'roboto-slab',
    label: 'Roboto Slab',
    family: 'Roboto Slab',
    fallback: 'serif',
    weights: [500, 600, 700, 800, 900],
    load: () => Promise.all([
      import('@fontsource/roboto-slab/latin-500.css'),
      import('@fontsource/roboto-slab/latin-600.css'),
      import('@fontsource/roboto-slab/latin-700.css'),
      import('@fontsource/roboto-slab/latin-800.css'),
      import('@fontsource/roboto-slab/latin-900.css'),
    ]),
  },
  {
    id: 'bebas-neue',
    label: 'Bebas Neue',
    family: 'Bebas Neue',
    fallback: 'sans-serif',
    weights: [400],
    load: () => import('@fontsource/bebas-neue/latin-400.css'),
  },
];

export function getBrandFontPreset(id: BrandFontPresetId): BrandFontPreset {
  return BRAND_FONT_PRESETS.find((preset) => preset.id === id) || BRAND_FONT_PRESETS[0];
}

function quoteFamily(family: string): string {
  return `"${family.replace(/["\\]/g, '')}"`;
}

/**
 * The family name an uploaded font is registered under. Prefixed so an upload
 * named "Inter" or "Arial" never replaces the studio's own faces.
 */
export function getUploadedBrandFontFaceName(font: Extract<BrandFont, { source: 'upload' }>): string {
  return `Brand ${normalizeBrandFontFamilyName(font.family) || 'Font'} ${font.fileId}`.slice(0, 120);
}

/** The CSS/canvas font stack for a brand font (Inter and a generic family behind it). */
export function getBrandFontFamilyStack(font: BrandFont | null | undefined): string {
  if (!font) return DEFAULT_CANVAS_FONT_FAMILY;
  if (font.source === 'preset') {
    const preset = getBrandFontPreset(font.presetId);
    if (preset.id === 'inter') return DEFAULT_CANVAS_FONT_FAMILY;
    return `${quoteFamily(preset.family)}, Inter, Arial, ${preset.fallback}`;
  }
  return `${quoteFamily(getUploadedBrandFontFaceName(font))}, Inter, Arial, sans-serif`;
}

export function getBrandFontLabel(font: BrandFont | null | undefined): string {
  if (!font) return 'Inter (default)';
  if (font.source === 'preset') return getBrandFontPreset(font.presetId).label;
  return font.family;
}

/** document.fonts.load descriptors that make every drawn weight ready. */
export function getBrandFontLoadDescriptors(font: BrandFont | null | undefined): string[] {
  if (!font) return [];
  if (font.source === 'preset') {
    const preset = getBrandFontPreset(font.presetId);
    return preset.weights.map((weight) => `${weight} 32px ${quoteFamily(preset.family)}`);
  }
  return [`400 32px ${quoteFamily(getUploadedBrandFontFaceName(font))}`];
}

export function isSameBrandFont(a: BrandFont | null | undefined, b: BrandFont | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.source === 'preset' && b.source === 'preset') return a.presetId === b.presetId;
  if (a.source === 'upload' && b.source === 'upload') return a.fileId === b.fileId && a.family === b.family;
  return false;
}

export type BrandFontFileCheck = { ok: true; family: string } | { ok: false; reason: string };

/** Checks an uploaded font file before it is stored; the family comes from the file name. */
export function checkBrandFontFile(file: { name: string; size: number }): BrandFontFileCheck {
  const name = file.name || '';
  const lower = name.toLowerCase();
  if (!BRAND_FONT_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return { ok: false, reason: 'Choose a .woff2, .woff, .ttf or .otf font file.' };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, reason: 'That font file is empty.' };
  if (file.size > MAX_BRAND_FONT_FILE_BYTES) return { ok: false, reason: 'Font files can be up to 4 MB.' };
  const base = name.replace(/\.[^.]+$/, '').replace(/[-_]+(regular|bold|black|medium|semibold|variable|vf)$/i, '');
  const family = normalizeBrandFontFamilyName(base.replace(/[-_]+/g, ' ')) || 'Brand Font';
  return { ok: true, family };
}
