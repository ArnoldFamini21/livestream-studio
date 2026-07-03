import type { CSSProperties } from 'react';
import type { LayoutMode, LogoPlacement, LogoPosition, Scene } from '@studio/shared';
import { getMediaShareLayoutPlan } from './mediaShareLayouts.ts';
import { getCustomLogoPositionStyle, normalizeLogoPosition } from './logoPosition.ts';

export interface ScenePreviewTile {
  left: string;
  top: string;
  width: string;
  height: string;
  primary?: boolean;
  floating?: boolean;
  media?: boolean;
}

export interface ScenePreviewOverlays {
  lowerThird: boolean;
  banner: boolean;
  ticker: boolean;
  timer: boolean;
  widget: boolean;
  logo: boolean;
  media: boolean;
}

export function getScenePreviewTiles(
  layout: LayoutMode,
  options: { pipCorner?: Scene['pipCorner']; mediaActive?: boolean; mediaParticipantCount?: number } = {}
): ScenePreviewTile[] {
  if (options.mediaActive) return getSharedMediaPreviewTiles(layout, options);

  switch (layout) {
    case 'single':
      return [{ left: '18%', top: '16%', width: '64%', height: '58%', primary: true }];
    case 'side-by-side':
      return [
        { left: '8%', top: '18%', width: '39%', height: '55%', primary: true },
        { left: '53%', top: '18%', width: '39%', height: '55%' },
      ];
    case 'spotlight':
      return [
        { left: '8%', top: '8%', width: '84%', height: '55%', primary: true },
        { left: '10%', top: '70%', width: '22%', height: '17%' },
        { left: '39%', top: '70%', width: '22%', height: '17%' },
        { left: '68%', top: '70%', width: '22%', height: '17%' },
      ];
    case 'pip':
      return [
        { left: '7%', top: '8%', width: '86%', height: '72%', primary: true },
        { ...getScenePreviewPipTilePosition(options.pipCorner), width: '27%', height: '22%', floating: true },
      ];
    case 'featured':
      return [
        { left: '7%', top: '10%', width: '61%', height: '66%', primary: true },
        { left: '73%', top: '11%', width: '20%', height: '28%' },
        { left: '73%', top: '47%', width: '20%', height: '28%' },
      ];
    case 'grid':
      return [
        { left: '9%', top: '13%', width: '37%', height: '27%' },
        { left: '54%', top: '13%', width: '37%', height: '27%' },
        { left: '9%', top: '49%', width: '37%', height: '27%' },
        { left: '54%', top: '49%', width: '37%', height: '27%' },
      ];
    default:
      return assertNever(layout);
  }
}

function getSharedMediaPreviewTiles(
  layout: LayoutMode,
  options: { pipCorner?: Scene['pipCorner']; mediaParticipantCount?: number } = {}
): ScenePreviewTile[] {
  const plan = getMediaShareLayoutPlan(layout, getPreviewParticipantCount(layout, options.mediaParticipantCount));
  const visibleCount = plan.visibleParticipantCount;
  const mediaTile: ScenePreviewTile = { left: '7%', top: '8%', width: '86%', height: '72%', primary: true, media: true };

  if (visibleCount <= 0) return [mediaTile];

  switch (plan.placement) {
    case 'side-rail':
      return [
        { left: '7%', top: '10%', width: '65%', height: '70%', primary: true, media: true },
        ...buildStackedPreviewTiles(visibleCount, {
          left: '77%',
          width: '17%',
          top: 12,
          height: visibleCount >= 4 ? 14 : 17,
          availableHeight: 66,
        }),
      ];
    case 'bottom-strip':
      return [
        { left: '7%', top: '8%', width: '86%', height: '55%', primary: true, media: true },
        ...buildInlinePreviewTiles(visibleCount, {
          left: 9,
          top: '70%',
          width: Math.min(22, 80 / Math.max(1, visibleCount)),
          height: '17%',
          availableWidth: 82,
        }),
      ];
    case 'side-by-side':
      return [
        { left: '7%', top: '11%', width: '57%', height: '66%', primary: true, media: true },
        ...buildStackedPreviewTiles(visibleCount, {
          left: '70%',
          width: '23%',
          top: visibleCount === 1 ? 27 : 16,
          height: visibleCount === 1 ? 33 : 27,
          availableHeight: visibleCount === 1 ? 33 : 54,
        }),
      ];
    case 'floating-stack':
      return [
        mediaTile,
        ...buildStackedPreviewTiles(visibleCount, {
          left: '72%',
          width: '18%',
          top: 18,
          height: visibleCount >= 3 ? 15 : 18,
          availableHeight: 48,
          floating: true,
        }),
      ];
    case 'pip':
      return [
        mediaTile,
        ...Array.from({ length: visibleCount }, (_, index) => ({
          ...getSharedMediaPreviewPipTilePosition(index, visibleCount, options.pipCorner),
          width: visibleCount >= 3 ? '20%' : '24%',
          height: visibleCount >= 3 ? '16%' : '20%',
          floating: true,
        })),
      ];
  }
}

function getPreviewParticipantCount(layout: LayoutMode, providedCount?: number): number {
  if (typeof providedCount === 'number' && Number.isFinite(providedCount)) {
    return Math.max(0, Math.floor(providedCount));
  }

  switch (layout) {
    case 'single':
      return 1;
    case 'pip':
    case 'side-by-side':
      return 2;
    case 'grid':
    case 'spotlight':
    case 'featured':
      return 3;
  }
}

function buildStackedPreviewTiles(
  count: number,
  options: {
    left: string;
    width: string;
    top: number;
    height: number;
    availableHeight: number;
    floating?: boolean;
  }
): ScenePreviewTile[] {
  const gap = count <= 1 ? 0 : Math.max(3, (options.availableHeight - options.height * count) / (count - 1));
  return Array.from({ length: count }, (_, index) => ({
    left: options.left,
    top: `${options.top + index * (options.height + gap)}%`,
    width: options.width,
    height: `${options.height}%`,
    floating: options.floating,
  }));
}

function buildInlinePreviewTiles(
  count: number,
  options: {
    left: number;
    top: string;
    width: number;
    height: string;
    availableWidth: number;
  }
): ScenePreviewTile[] {
  const gap = count <= 1 ? 0 : Math.max(3, (options.availableWidth - options.width * count) / (count - 1));
  return Array.from({ length: count }, (_, index) => ({
    left: `${options.left + index * (options.width + gap)}%`,
    top: options.top,
    width: `${options.width}%`,
    height: options.height,
  }));
}

function getSharedMediaPreviewPipTilePosition(
  index: number,
  count: number,
  corner: Scene['pipCorner'] = 'BR'
): Pick<ScenePreviewTile, 'left' | 'top'> {
  const twoColumn = count >= 3;
  const column = twoColumn ? index % 2 : 0;
  const row = twoColumn ? Math.floor(index / 2) : index;
  const leftColumn = column === 0 ? 10 : 33;
  const rightColumn = column === 0 ? 66 : 43;
  const topRow = 14 + row * 19;
  const bottomRow = count >= 3 ? 58 - row * 19 : 54 - row * 24;

  switch (corner) {
    case 'TL':
      return { left: `${leftColumn}%`, top: `${topRow}%` };
    case 'TR':
      return { left: `${rightColumn}%`, top: `${topRow}%` };
    case 'BL':
      return { left: `${leftColumn}%`, top: `${bottomRow}%` };
    case 'BR':
    default:
      return { left: `${rightColumn}%`, top: `${bottomRow}%` };
  }
}

export function getScenePreviewPipTilePosition(corner: Scene['pipCorner'] = 'BR'): Pick<ScenePreviewTile, 'left' | 'top'> {
  switch (corner) {
    case 'TL':
      return { left: '10%', top: '14%' };
    case 'TR':
      return { left: '63%', top: '14%' };
    case 'BL':
      return { left: '10%', top: '54%' };
    case 'BR':
    default:
      return { left: '63%', top: '54%' };
  }
}

export function getScenePreviewOverlays(scene: Pick<Scene, 'visibleOverlayIds' | 'logoUrl' | 'activeMedia'>): ScenePreviewOverlays {
  return {
    lowerThird: scene.visibleOverlayIds.some((id) => id.startsWith('lt-')),
    banner: scene.visibleOverlayIds.some((id) => id.startsWith('banner-')),
    ticker: scene.visibleOverlayIds.some((id) => id.startsWith('ticker-')),
    timer: scene.visibleOverlayIds.some((id) => id.startsWith('timer-')),
    widget: scene.visibleOverlayIds.some((id) => id.startsWith('widget-')),
    logo: Boolean(scene.logoUrl),
    media: Boolean(scene.activeMedia?.assetId),
  };
}

export function getScenePreviewLogoPosition(placement: LogoPlacement | undefined, position?: LogoPosition | null): CSSProperties {
  const normalizedPosition = normalizeLogoPosition(position);
  if (normalizedPosition) return getCustomLogoPositionStyle(normalizedPosition);

  switch (placement) {
    case 'top-left':
      return { top: '8%', left: '8%' };
    case 'bottom-left':
      return { bottom: '14%', left: '8%' };
    case 'bottom-right':
      return { bottom: '14%', right: '8%' };
    case 'top-right':
    default:
      return { top: '8%', right: '8%' };
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled layout: ${value}`);
}
