import type { CameraShape, LayoutMode, LogoPlacement, LogoSize, NameTagStyle, Scene, StageBackground } from '@studio/shared';
import type { BannerData } from '../components/BannerOverlay.tsx';
import type { LowerThirdData } from '../components/LowerThird.tsx';
import type { TimerData } from '../components/TimerOverlay.tsx';
import type { TickerData } from '../components/TickerOverlay.tsx';
import { buildDuplicatedSceneName } from './sceneOrder.ts';

export const SCENE_PACK_VERSION = 1;
export const SCENE_PACK_SOURCE = 'livestream-studio';
export const MAX_SCENE_PACK_SCENES = 12;
export const MAX_SCENE_PACK_BYTES = 512_000;

export type ScenePackOverlayKind = 'lowerThird' | 'banner' | 'timer' | 'ticker';

export interface ScenePackOverlays {
  lowerThirds: LowerThirdData[];
  banners: BannerData[];
  timers: TimerData[];
  tickers: TickerData[];
}

export interface ScenePack {
  version: typeof SCENE_PACK_VERSION;
  source: typeof SCENE_PACK_SOURCE;
  exportedAt: string;
  scenes: Scene[];
  overlays: ScenePackOverlays;
}

export interface BuildScenePackInput extends ScenePackOverlays {
  scenes: Scene[];
  exportedAt?: string;
}

export interface ImportScenePackOptions {
  existingScenes: Scene[];
  maxScenes?: number;
  sceneIdFactory?: (scene: Scene, index: number) => string;
  overlayIdFactory?: (kind: ScenePackOverlayKind, oldId: string, index: number) => string;
}

export interface ScenePackImportResult extends ScenePackOverlays {
  scenes: Scene[];
  importedScenes: number;
  skippedScenes: number;
}

const LAYOUTS = ['grid', 'spotlight', 'side-by-side', 'pip', 'single', 'featured'] as const;
const BACKGROUND_TYPES = ['color', 'image', 'gradient', 'none'] as const;
const CAMERA_SHAPES = ['rectangle', 'rounded', 'square', 'circle'] as const;
const NAME_TAG_STYLES = ['classic', 'minimal', 'block'] as const;
const LOGO_PLACEMENTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const LOGO_SIZES = ['small', 'medium', 'large'] as const;
const PIP_CORNERS = ['TL', 'TR', 'BL', 'BR'] as const;
const LOWER_THIRD_STYLES = ['minimal', 'bold', 'gradient', 'glass'] as const;
const BANNER_STYLES = ['breaking', 'info', 'alert', 'custom'] as const;
const BANNER_POSITIONS = ['top', 'bottom'] as const;
const TIMER_MODES = ['countdown', 'countup'] as const;
const TIMER_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const TIMER_STYLES = ['minimal', 'bold', 'neon'] as const;
const TICKER_SPEEDS = ['slow', 'normal', 'fast'] as const;

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

function readOptionalString(value: unknown, maxLength: number): string | undefined {
  const text = readString(value, maxLength);
  return text || undefined;
}

function readStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readOptionalDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(24 * 60 * 60, Math.round(value));
}

function sanitizeBackground(input: unknown): StageBackground {
  if (!isRecord(input) || !isAllowed(input.type, BACKGROUND_TYPES)) {
    return { type: 'none', value: '' };
  }
  const value = readString(input.value, 100_000);
  if (input.type === 'image' && value.startsWith('blob:')) {
    return { type: 'none', value: '' };
  }
  return { type: input.type, value };
}

function sanitizeLogoUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const url = readString(value, 100_000);
  if (!url || url.startsWith('blob:')) return null;
  return url;
}

function sanitizeScene(input: unknown): Scene | null {
  if (!isRecord(input)) return null;
  if (!isAllowed(input.layout, LAYOUTS)) return null;

  const id = readString(input.id, 128);
  const name = readString(input.name, 32, 'Scene');
  if (!id || !name) return null;

  const scene: Scene = {
    id,
    name,
    layout: input.layout as LayoutMode,
    background: sanitizeBackground(input.background),
    brandColor: readString(input.brandColor, 80, '#a78bfa') || '#a78bfa',
    logoUrl: sanitizeLogoUrl(input.logoUrl),
    visibleOverlayIds: readStringArray(input.visibleOverlayIds, 64, 128),
  };

  if (isAllowed(input.cameraShape, CAMERA_SHAPES)) scene.cameraShape = input.cameraShape as CameraShape;
  if (isAllowed(input.nameTagStyle, NAME_TAG_STYLES)) scene.nameTagStyle = input.nameTagStyle as NameTagStyle;
  if (isAllowed(input.logoPlacement, LOGO_PLACEMENTS)) scene.logoPlacement = input.logoPlacement as LogoPlacement;
  if (isAllowed(input.logoSize, LOGO_SIZES)) scene.logoSize = input.logoSize as LogoSize;
  if (isAllowed(input.pipCorner, PIP_CORNERS)) scene.pipCorner = input.pipCorner;
  scene.focusedVideoItemId = typeof input.focusedVideoItemId === 'string'
    ? readString(input.focusedVideoItemId, 128) || null
    : null;
  scene.stageItemOrder = readStringArray(input.stageItemOrder, 64, 128);

  return scene;
}

function sanitizeLowerThird(input: unknown): LowerThirdData | null {
  if (!isRecord(input)) return null;
  const id = readString(input.id, 128);
  const name = readString(input.name, 80);
  if (!id || !name) return null;

  const lowerThird: LowerThirdData = {
    id,
    name,
    title: readString(input.title, 120),
    style: isAllowed(input.style, LOWER_THIRD_STYLES) ? input.style : 'minimal',
    visible: Boolean(input.visible),
  };
  const durationSeconds = readOptionalDuration(input.durationSeconds);
  if (durationSeconds) lowerThird.durationSeconds = durationSeconds;
  const accentColor = readOptionalString(input.accentColor, 40);
  if (accentColor) lowerThird.accentColor = accentColor;
  if (input.source === 'participant') lowerThird.source = 'participant';
  const participantId = readOptionalString(input.participantId, 128);
  if (participantId) lowerThird.participantId = participantId;
  return lowerThird;
}

function sanitizeBanner(input: unknown): BannerData | null {
  if (!isRecord(input)) return null;
  const id = readString(input.id, 128);
  const text = readString(input.text, 1000);
  if (!id || !text) return null;

  const banner: BannerData = {
    id,
    text,
    style: isAllowed(input.style, BANNER_STYLES) ? input.style : 'info',
    isTicker: Boolean(input.isTicker),
    position: isAllowed(input.position, BANNER_POSITIONS) ? input.position : 'bottom',
    visible: Boolean(input.visible),
  };
  const customColor = readOptionalString(input.customColor, 40);
  if (customColor) banner.customColor = customColor;
  const durationSeconds = readOptionalDuration(input.durationSeconds);
  if (durationSeconds) banner.durationSeconds = durationSeconds;
  return banner;
}

function sanitizeTimer(input: unknown): TimerData | null {
  if (!isRecord(input)) return null;
  const id = readString(input.id, 128);
  if (!id) return null;
  const durationSeconds = readNumber(input.durationSeconds, 0, 0, 24 * 60 * 60);
  return {
    id,
    mode: isAllowed(input.mode, TIMER_MODES) ? input.mode : 'countdown',
    durationSeconds,
    remainingSeconds: readNumber(input.remainingSeconds, durationSeconds, -24 * 60 * 60, 24 * 60 * 60),
    isRunning: Boolean(input.isRunning),
    position: isAllowed(input.position, TIMER_POSITIONS) ? input.position : 'top-right',
    style: isAllowed(input.style, TIMER_STYLES) ? input.style : 'minimal',
    visible: Boolean(input.visible),
  };
}

function sanitizeTicker(input: unknown): TickerData | null {
  if (!isRecord(input)) return null;
  const id = readString(input.id, 128);
  const text = readString(input.text, 1000);
  if (!id || !text) return null;
  return {
    id,
    text,
    speed: isAllowed(input.speed, TICKER_SPEEDS) ? input.speed : 'normal',
    backgroundColor: readString(input.backgroundColor, 40, '#1e1e2e') || '#1e1e2e',
    textColor: readString(input.textColor, 40, '#ffffff') || '#ffffff',
    visible: Boolean(input.visible),
    separator: readString(input.separator, 8, '•') || '•',
  };
}

function sanitizeArray<T>(value: unknown, sanitizer: (input: unknown) => T | null, maxItems = 100): T[] | null {
  if (!Array.isArray(value)) return null;
  const sanitized: T[] = [];
  for (const item of value.slice(0, maxItems)) {
    const next = sanitizer(item);
    if (!next) return null;
    sanitized.push(next);
  }
  return sanitized;
}

function getReferencedOverlayIds(scenes: Scene[]): Set<string> {
  return new Set(scenes.flatMap((scene) => scene.visibleOverlayIds));
}

function getIncludedOverlayIds(overlays: ScenePackOverlays): Set<string> {
  return new Set([
    ...overlays.lowerThirds.map((item) => item.id),
    ...overlays.banners.map((item) => item.id),
    ...overlays.timers.map((item) => item.id),
    ...overlays.tickers.map((item) => item.id),
  ]);
}

function defaultSceneIdFactory(_scene: Scene, index: number): string {
  return `scene-import-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultOverlayIdFactory(kind: ScenePackOverlayKind, _oldId: string, index: number): string {
  const prefixByKind: Record<ScenePackOverlayKind, string> = {
    lowerThird: 'lt',
    banner: 'banner',
    timer: 'timer',
    ticker: 'ticker',
  };
  return `${prefixByKind[kind]}-import-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
}

function remapOverlayIds<T extends { id: string }>(
  overlays: T[],
  referencedIds: Set<string>,
  kind: ScenePackOverlayKind,
  idMap: Map<string, string>,
  overlayIdFactory: NonNullable<ImportScenePackOptions['overlayIdFactory']>,
  mapOverlay: (overlay: T, newId: string) => T
): T[] {
  return overlays
    .filter((overlay) => referencedIds.has(overlay.id))
    .map((overlay, index) => {
      const newId = overlayIdFactory(kind, overlay.id, index);
      idMap.set(overlay.id, newId);
      return mapOverlay(overlay, newId);
    });
}

export function buildScenePack(input: BuildScenePackInput): ScenePack {
  const scenes = input.scenes.map((scene) => sanitizeScene(scene)).filter((scene): scene is Scene => Boolean(scene)).slice(0, MAX_SCENE_PACK_SCENES);
  const referencedIds = getReferencedOverlayIds(scenes);
  const overlays: ScenePackOverlays = {
    lowerThirds: input.lowerThirds
      .filter((lowerThird) => referencedIds.has(lowerThird.id) && lowerThird.source !== 'auto-speaker')
      .map((lowerThird) => ({ ...lowerThird, visible: false })),
    banners: input.banners
      .filter((banner) => referencedIds.has(banner.id))
      .map((banner) => ({ ...banner, visible: false })),
    timers: input.timers
      .filter((timer) => referencedIds.has(timer.id))
      .map((timer) => ({ ...timer, visible: false, isRunning: false })),
    tickers: input.tickers
      .filter((ticker) => referencedIds.has(ticker.id))
      .map((ticker) => ({ ...ticker, visible: false })),
  };
  const includedOverlayIds = getIncludedOverlayIds(overlays);

  return {
    version: SCENE_PACK_VERSION,
    source: SCENE_PACK_SOURCE,
    exportedAt: input.exportedAt || new Date().toISOString(),
    scenes: scenes.map((scene) => ({
      ...scene,
      visibleOverlayIds: scene.visibleOverlayIds.filter((id) => includedOverlayIds.has(id)),
    })),
    overlays,
  };
}

export function parseScenePackJson(json: string): ScenePack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Scene pack is not valid JSON.');
  }

  if (!isRecord(parsed) || parsed.version !== SCENE_PACK_VERSION || parsed.source !== SCENE_PACK_SOURCE) {
    throw new Error('Scene pack is not compatible with this studio.');
  }

  const scenes = sanitizeArray(parsed.scenes, sanitizeScene, MAX_SCENE_PACK_SCENES);
  const overlaysInput = parsed.overlays;
  if (!scenes || !isRecord(overlaysInput)) {
    throw new Error('Scene pack is missing required scenes or overlays.');
  }

  const lowerThirds = sanitizeArray(overlaysInput.lowerThirds, sanitizeLowerThird);
  const banners = sanitizeArray(overlaysInput.banners, sanitizeBanner);
  const timers = sanitizeArray(overlaysInput.timers, sanitizeTimer);
  const tickers = sanitizeArray(overlaysInput.tickers, sanitizeTicker);
  if (!lowerThirds || !banners || !timers || !tickers) {
    throw new Error('Scene pack overlays are malformed.');
  }

  if (scenes.length === 0) {
    throw new Error('Scene pack does not contain any scenes.');
  }

  const overlays: ScenePackOverlays = { lowerThirds, banners, timers, tickers };
  const includedOverlayIds = getIncludedOverlayIds(overlays);

  return {
    version: SCENE_PACK_VERSION,
    source: SCENE_PACK_SOURCE,
    exportedAt: readString(parsed.exportedAt, 64, new Date().toISOString()),
    scenes: scenes.map((scene) => ({
      ...scene,
      visibleOverlayIds: scene.visibleOverlayIds.filter((id) => includedOverlayIds.has(id)),
    })),
    overlays,
  };
}

export function importScenePack(pack: ScenePack, options: ImportScenePackOptions): ScenePackImportResult {
  const maxScenes = options.maxScenes ?? MAX_SCENE_PACK_SCENES;
  const availableSlots = Math.max(0, maxScenes - options.existingScenes.length);
  const selectedScenes = pack.scenes.slice(0, availableSlots);
  const skippedScenes = Math.max(0, pack.scenes.length - selectedScenes.length);
  const referencedIds = getReferencedOverlayIds(selectedScenes);
  const idMap = new Map<string, string>();
  const overlayIdFactory = options.overlayIdFactory || defaultOverlayIdFactory;
  const sceneIdFactory = options.sceneIdFactory || defaultSceneIdFactory;

  const lowerThirds = remapOverlayIds(
    pack.overlays.lowerThirds.filter((lowerThird) => lowerThird.source !== 'auto-speaker'),
    referencedIds,
    'lowerThird',
    idMap,
    overlayIdFactory,
    (lowerThird, id) => ({ ...lowerThird, id, visible: false })
  );
  const banners = remapOverlayIds(
    pack.overlays.banners,
    referencedIds,
    'banner',
    idMap,
    overlayIdFactory,
    (banner, id) => ({ ...banner, id, visible: false })
  );
  const timers = remapOverlayIds(
    pack.overlays.timers,
    referencedIds,
    'timer',
    idMap,
    overlayIdFactory,
    (timer, id) => ({ ...timer, id, visible: false, isRunning: false })
  );
  const tickers = remapOverlayIds(
    pack.overlays.tickers,
    referencedIds,
    'ticker',
    idMap,
    overlayIdFactory,
    (ticker, id) => ({ ...ticker, id, visible: false })
  );

  const usedNames = options.existingScenes.map((scene) => scene.name);
  const scenes = selectedScenes.map((scene, index) => {
    const name = usedNames.includes(scene.name)
      ? buildDuplicatedSceneName(scene.name, usedNames, 32)
      : scene.name;
    usedNames.push(name);
    return {
      ...scene,
      id: sceneIdFactory(scene, index),
      name,
      visibleOverlayIds: scene.visibleOverlayIds
        .map((id) => idMap.get(id))
        .filter((id): id is string => Boolean(id)),
    };
  });

  return {
    scenes,
    lowerThirds,
    banners,
    timers,
    tickers,
    importedScenes: scenes.length,
    skippedScenes,
  };
}

export function buildScenePackFilename(studioName: string, date = new Date()): string {
  const slug = studioName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'studio';
  return `scene-pack-${slug}-${date.toISOString().slice(0, 10)}.json`;
}
