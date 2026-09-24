import { DEFAULT_STUDIO_THEME_ID, normalizeStudioThemeId } from './studioThemes.ts';

const HEX_COLOR_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function expandHex(value: string): string {
  return value.length === 3
    ? value.split('').map((char) => `${char}${char}`).join('')
    : value;
}

function hexToRgb(hex: string): RgbColor {
  const value = expandHex(hex.replace('#', '').toLowerCase());
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: RgbColor): string {
  return `#${[r, g, b].map((channel) => clampChannel(channel).toString(16).padStart(2, '0')).join('')}`;
}

function mixRgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

function relativeLuminance({ r, g, b }: RgbColor): number {
  const channel = (value: number) => {
    const c = clampChannel(value) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of white text on this color. */
export function contrastWithWhite(color: RgbColor | string): number {
  const rgb = typeof color === 'string' ? hexToRgb(color) : color;
  return 1.05 / (relativeLuminance(rgb) + 0.05);
}

const MIN_TEXT_CONTRAST = 4.5;

export function normalizeBrandColor(value: unknown, fallback = '#a78bfa'): string {
  if (typeof value !== 'string') return fallback;
  const match = value.trim().match(HEX_COLOR_PATTERN);
  if (!match) return fallback;
  return `#${expandHex(match[1]).toLowerCase()}`;
}

export function buildBrandThemeVariables(
  brandColor: unknown,
  studioTheme: unknown = DEFAULT_STUDIO_THEME_ID
): Array<[string, string]> {
  const accent = normalizeBrandColor(brandColor);
  const theme = normalizeStudioThemeId(studioTheme);
  const rgb = hexToRgb(accent);
  const hover = theme === 'light'
    ? rgbToHex(mixRgb(rgb, { r: 0, g: 0, b: 0 }, 0.16))
    : rgbToHex(mixRgb(rgb, { r: 255, g: 255, b: 255 }, 0.28));
  // Solid fills carry white text (Go Live, Send), so darken light brand
  // colors just enough for readable text (WCAG AA, 4.5:1).
  let darken = theme === 'light' ? 0.06 : 0.12;
  let solidRgb = mixRgb(rgb, { r: 0, g: 0, b: 0 }, darken);
  while (contrastWithWhite(solidRgb) < MIN_TEXT_CONTRAST && darken < 0.9) {
    darken += 0.02;
    solidRgb = mixRgb(rgb, { r: 0, g: 0, b: 0 }, darken);
  }
  const solid = rgbToHex(solidRgb);

  return [
    ['--accent', accent],
    ['--accent-hover', hover],
    ['--accent-solid', solid],
    ['--accent-subtle', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`],
    ['--accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`],
  ];
}
