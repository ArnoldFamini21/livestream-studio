export const DEFAULT_LOGO_OPACITY = 0.85;
export const MIN_LOGO_OPACITY = 0.2;
export const MAX_LOGO_OPACITY = 1;

export function normalizeLogoOpacity(value: unknown, fallback = DEFAULT_LOGO_OPACITY): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.min(MAX_LOGO_OPACITY, Math.max(MIN_LOGO_OPACITY, numeric));
  return Math.round(clamped * 100) / 100;
}
