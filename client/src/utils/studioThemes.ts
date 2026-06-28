export type StudioThemeId = 'dark' | 'light' | 'colorful';

export interface StudioThemePreset {
  id: StudioThemeId;
  label: string;
  swatches: [string, string, string];
}

export const DEFAULT_STUDIO_THEME_ID: StudioThemeId = 'dark';

export const STUDIO_THEME_PRESETS: StudioThemePreset[] = [
  { id: 'dark', label: 'Dark', swatches: ['#0b1220', '#151e30', '#a78bfa'] },
  { id: 'light', label: 'Light', swatches: ['#f8fafc', '#e2e8f0', '#2563eb'] },
  { id: 'colorful', label: 'Colorful', swatches: ['#111827', '#164e63', '#f97316'] },
];

const STUDIO_THEME_IDS = new Set<StudioThemeId>(STUDIO_THEME_PRESETS.map((theme) => theme.id));

export function normalizeStudioThemeId(value: unknown): StudioThemeId {
  return typeof value === 'string' && STUDIO_THEME_IDS.has(value as StudioThemeId)
    ? value as StudioThemeId
    : DEFAULT_STUDIO_THEME_ID;
}

export function getStudioThemeLabel(value: unknown): string {
  const themeId = normalizeStudioThemeId(value);
  return STUDIO_THEME_PRESETS.find((theme) => theme.id === themeId)?.label || 'Dark';
}
