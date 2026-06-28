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
  const solid = rgbToHex(mixRgb(rgb, { r: 0, g: 0, b: 0 }, theme === 'light' ? 0.06 : 0.12));

  return [
    ['--accent', accent],
    ['--accent-hover', hover],
    ['--accent-solid', solid],
    ['--accent-subtle', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`],
    ['--accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`],
  ];
}
