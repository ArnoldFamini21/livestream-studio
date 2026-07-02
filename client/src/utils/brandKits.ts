import type {
  BrandKitCatalogEntry,
  BrandKitCatalogStudioTheme,
  CameraShape,
  LogoPlacement,
  LogoPosition,
  LogoSize,
  NameTagStyle,
  StageBackground,
} from '@studio/shared';
import {
  DEFAULT_STUDIO_THEME_ID,
  normalizeStudioThemeId,
  type StudioThemeId,
} from './studioThemes.ts';
import { normalizeLogoOpacity } from './logoWatermark.ts';
import { normalizeLogoPosition } from './logoPosition.ts';

export const BRAND_KIT_STORAGE_KEY = 'livestream-studio:saved-brand-kits';
export const MAX_SAVED_BRAND_KITS = 8;

export interface BrandKitVisuals {
  studioTheme: StudioThemeId & BrandKitCatalogStudioTheme;
  brandColor: string;
  stageBackground: StageBackground;
  logoUrl: string | null;
  logoPlacement: LogoPlacement;
  logoPosition: LogoPosition | null;
  logoSize: LogoSize;
  logoOpacity: number;
  cameraShape: CameraShape;
  nameTagStyle: NameTagStyle;
}

export interface SavedBrandKit extends Omit<BrandKitCatalogEntry, 'roomId' | 'updatedAt'> {}

const BACKGROUND_TYPES = ['color', 'image', 'video', 'gradient', 'none'] as const;
const LOGO_PLACEMENTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const LOGO_SIZES = ['small', 'medium', 'large'] as const;
const CAMERA_SHAPES = ['rectangle', 'rounded', 'square', 'circle'] as const;
const NAME_TAG_STYLES = ['classic', 'minimal', 'block'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAllowed<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value as T[number]);
}

function readString(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength);
}

export function getPersistableBrandStageBackground(background: StageBackground): StageBackground {
  if ((background.type === 'image' || background.type === 'video') && background.value.startsWith('blob:')) {
    return { type: 'none', value: '' };
  }
  return background;
}

export function getPersistableBrandLogoUrl(url: string | null): string | null {
  if (!url || url.startsWith('blob:')) return null;
  return url;
}

function sanitizeBackground(value: unknown): StageBackground {
  if (!isRecord(value) || !isAllowed(value.type, BACKGROUND_TYPES)) {
    return { type: 'none', value: '' };
  }
  return getPersistableBrandStageBackground({
    type: value.type,
    value: readString(value.value, 100_000),
  });
}

function sanitizeSavedBrandKit(value: unknown): SavedBrandKit | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id, 128);
  const name = readString(value.name, 32);
  if (!id || !name) return null;

  return {
    id,
    name,
    createdAt: readString(value.createdAt, 64, new Date().toISOString()),
    studioTheme: normalizeStudioThemeId(value.studioTheme || DEFAULT_STUDIO_THEME_ID),
    brandColor: readString(value.brandColor, 80, '#a78bfa') || '#a78bfa',
    stageBackground: sanitizeBackground(value.stageBackground),
    logoUrl: getPersistableBrandLogoUrl(readString(value.logoUrl, 100_000) || null),
    logoPlacement: isAllowed(value.logoPlacement, LOGO_PLACEMENTS) ? value.logoPlacement : 'top-right',
    logoPosition: normalizeLogoPosition(value.logoPosition),
    logoSize: isAllowed(value.logoSize, LOGO_SIZES) ? value.logoSize : 'medium',
    logoOpacity: normalizeLogoOpacity(value.logoOpacity),
    cameraShape: isAllowed(value.cameraShape, CAMERA_SHAPES) ? value.cameraShape : 'rectangle',
    nameTagStyle: isAllowed(value.nameTagStyle, NAME_TAG_STYLES) ? value.nameTagStyle : 'classic',
  };
}

export function parseSavedBrandKits(json: string | null): SavedBrandKit[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeSavedBrandKit)
      .filter((kit): kit is SavedBrandKit => Boolean(kit))
      .slice(0, MAX_SAVED_BRAND_KITS);
  } catch {
    return [];
  }
}

export function serializeSavedBrandKits(kits: SavedBrandKit[]): string {
  return JSON.stringify(kits.map(sanitizeSavedBrandKit).filter(Boolean).slice(0, MAX_SAVED_BRAND_KITS));
}

export function buildBrandKitName(sourceName: string, existingNames: string[], maxLength = 32): string {
  const base = sourceName.trim().slice(0, maxLength) || 'Brand Kit';
  if (!existingNames.includes(base)) return base;

  for (let copyNumber = 2; copyNumber < 100; copyNumber += 1) {
    const suffix = ` ${copyNumber}`;
    const candidate = `${base.slice(0, Math.max(1, maxLength - suffix.length)).trimEnd()}${suffix}`;
    if (!existingNames.includes(candidate)) return candidate;
  }

  return `Brand Kit ${Date.now().toString(36)}`.slice(0, maxLength);
}

export function createSavedBrandKit(
  name: string,
  visuals: BrandKitVisuals,
  existingNames: string[] = [],
  id = `brand-kit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  createdAt = new Date().toISOString()
): SavedBrandKit {
  return {
    id,
    name: buildBrandKitName(name, existingNames),
    createdAt,
    studioTheme: normalizeStudioThemeId(visuals.studioTheme),
    brandColor: visuals.brandColor || '#a78bfa',
    stageBackground: getPersistableBrandStageBackground(visuals.stageBackground),
    logoUrl: getPersistableBrandLogoUrl(visuals.logoUrl),
    logoPlacement: visuals.logoPlacement,
    logoPosition: normalizeLogoPosition(visuals.logoPosition),
    logoSize: visuals.logoSize,
    logoOpacity: normalizeLogoOpacity(visuals.logoOpacity),
    cameraShape: visuals.cameraShape,
    nameTagStyle: visuals.nameTagStyle,
  };
}
