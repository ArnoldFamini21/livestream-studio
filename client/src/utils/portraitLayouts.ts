import type { CSSProperties } from 'react';
import type { LayoutMode } from '@studio/shared';
import { getMediaShareLayoutPlan } from './mediaShareLayouts.ts';
import { DEFAULT_CONTENT_ASPECT, normalizeContentAspect, type PresentationCorner } from './presentationLayout.ts';
import { getStageCanvasSize } from './stageCanvas.ts';

/**
 * Stacked 9:16 layouts for portrait output (Shorts, Reels, TikTok, Instagram).
 * Geometry is authored in the 540x960 portrait stage and rendered as
 * absolutely positioned percentages, so the compositor's DOM-rect mapping
 * lands exactly on the 1080x1920 program.
 */

const { width: W, height: H } = getStageCanvasSize('portrait');
const MARGIN = 16;
const GAP = 8;
const TILE_RADIUS = 16;

export interface PortraitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectStyle(rect: PortraitRect): CSSProperties {
  const percent = (value: number, total: number) => `${Math.round(value / total * 100_000) / 1000}%`;
  return {
    position: 'absolute',
    left: percent(rect.x, W),
    top: percent(rect.y, H),
    width: percent(rect.width, W),
    height: percent(rect.height, H),
    minWidth: 0,
    minHeight: 0,
    flexShrink: 0,
    flexGrow: 0,
    aspectRatio: 'auto',
    boxSizing: 'border-box',
  };
}

/** Rows of `count` cells inside a box; the last row is centred when short. */
function gridRects(count: number, columns: number, box: PortraitRect): PortraitRect[] {
  if (count <= 0) return [];
  const cols = Math.max(1, Math.min(columns, count));
  const rows = Math.ceil(count / cols);
  const cellW = (box.width - (cols - 1) * GAP) / cols;
  const cellH = (box.height - (rows - 1) * GAP) / rows;
  const rects: PortraitRect[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / cols);
    const inRow = row === rows - 1 ? count - row * cols : cols;
    const col = index % cols;
    const rowWidth = inRow * cellW + (inRow - 1) * GAP;
    const left = box.x + (box.width - rowWidth) / 2;
    rects.push({ x: left + col * (cellW + GAP), y: box.y + row * (cellH + GAP), width: cellW, height: cellH });
  }
  return rects;
}

const FULL_BOX: PortraitRect = { x: MARGIN, y: MARGIN, width: W - MARGIN * 2, height: H - MARGIN * 2 };

/** One column up to three people, then two, then three across. */
export function getPortraitGridColumnCount(count: number): number {
  if (count <= 3) return 1;
  if (count <= 8) return 2;
  return 3;
}

/** Tile rectangles (portrait stage pixels) for a camera layout. */
export function getPortraitStageRects(
  layout: LayoutMode,
  count: number,
  pipCorner: PresentationCorner = 'BR'
): PortraitRect[] {
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (n === 0) return [];
  switch (layout) {
    case 'single':
      return gridRects(1, 1, FULL_BOX);
    case 'side-by-side':
      // Two people stacked top and bottom.
      return gridRects(Math.min(n, 2), 1, FULL_BOX);
    case 'pip': {
      const main: PortraitRect = { x: 0, y: 0, width: W, height: H };
      if (n < 2) return [main];
      const width = 184;
      const height = 230;
      const inset = 20;
      const x = pipCorner.endsWith('L') ? inset : W - inset - width;
      const y = pipCorner.startsWith('T') ? inset : H - inset - height;
      return [main, { x, y, width, height }];
    }
    case 'spotlight':
    case 'featured': {
      if (n === 1) return gridRects(1, 1, FULL_BOX);
      const others = n - 1;
      // The others sit in a strip below at about 4:5, capped so the main tile stays dominant.
      const cols = Math.min(3, others);
      const rows = Math.ceil(others / cols);
      const cellW = (FULL_BOX.width - (cols - 1) * GAP) / cols;
      const naturalStrip = rows * cellW * 1.25 + (rows - 1) * GAP;
      const maxStrip = (FULL_BOX.height - GAP) * (layout === 'featured' ? 0.3 : 0.4);
      const stripHeight = Math.round(Math.min(naturalStrip, maxStrip));
      const mainHeight = FULL_BOX.height - GAP - stripHeight;
      const main: PortraitRect = { x: FULL_BOX.x, y: FULL_BOX.y, width: FULL_BOX.width, height: mainHeight };
      const strip: PortraitRect = {
        x: FULL_BOX.x,
        y: FULL_BOX.y + mainHeight + GAP,
        width: FULL_BOX.width,
        height: stripHeight,
      };
      return [main, ...gridRects(others, cols, strip)];
    }
    case 'grid':
    case 'custom':
    default:
      return gridRects(n, getPortraitGridColumnCount(n), FULL_BOX);
  }
}

export interface PortraitStageLayout {
  containerStyle: CSSProperties;
  tileStyles: CSSProperties[];
  mode: 'custom';
}

export const PORTRAIT_CONTAINER_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  padding: 0,
  overflow: 'hidden',
  boxSizing: 'border-box',
};

export function getPortraitStageLayout(layout: LayoutMode, count: number, pipCorner: PresentationCorner = 'BR'): PortraitStageLayout {
  const rects = getPortraitStageRects(layout, count, pipCorner);
  return {
    containerStyle: PORTRAIT_CONTAINER_STYLE,
    tileStyles: rects.map((rect, index) => ({
      ...rectStyle(rect),
      borderRadius: layout === 'pip' && index === 0 ? 0 : TILE_RADIUS,
      zIndex: layout === 'pip' && index === 1 ? 5 : 2,
      overflow: 'hidden',
      ...(layout === 'pip' && index === 1
        ? { boxShadow: '0 4px 24px rgba(0, 0, 0, 0.5)', border: '2px solid rgba(255, 255, 255, 0.15)', cursor: 'pointer' }
        : {}),
    })),
    mode: 'custom',
  };
}

function fitAspect(aspect: number, maxWidth: number, maxHeight: number) {
  let width = Math.max(0, maxWidth);
  let height = width / aspect;
  if (height > maxHeight) {
    height = Math.max(0, maxHeight);
    width = height * aspect;
  }
  return { width, height };
}

/**
 * Presenting in portrait: the content across the top at its own shape, the
 * cameras stacked below it, centred together as one group.
 */
export function getPortraitPresentationGeometry(layout: LayoutMode, count: number, contentAspect: number = DEFAULT_CONTENT_ASPECT) {
  const plan = getMediaShareLayoutPlan(layout, count);
  const n = plan.visibleParticipantCount;
  const aspect = normalizeContentAspect(contentAspect);
  if (n === 0) {
    const fit = fitAspect(aspect, FULL_BOX.width, FULL_BOX.height);
    return {
      ...plan,
      usesFloatingParticipant: false,
      media: { x: (W - fit.width) / 2, y: (H - fit.height) / 2, width: fit.width, height: fit.height },
      participants: [] as PortraitRect[],
    };
  }
  const cols = n === 1 ? 1 : 2;
  const rows = Math.ceil(n / cols);
  const cellW = (FULL_BOX.width - (cols - 1) * GAP) / cols;
  const cellH = cols === 1 ? Math.round(cellW * 9 / 16) : Math.round(Math.min(cellW, 260));
  const camerasHeight = rows * cellH + (rows - 1) * GAP;
  const content = fitAspect(aspect, FULL_BOX.width, FULL_BOX.height - GAP - camerasHeight);
  const top = (H - (content.height + GAP + camerasHeight)) / 2;
  const media: PortraitRect = { x: (W - content.width) / 2, y: top, width: content.width, height: content.height };
  const participants = gridRects(n, cols, { x: FULL_BOX.x, y: top + content.height + GAP, width: FULL_BOX.width, height: camerasHeight });
  return { ...plan, usesFloatingParticipant: false, media, participants };
}

/** Same shape as getPresentationLayout, for the portrait stage. */
export function getPortraitPresentationLayout(layout: LayoutMode, count: number, contentAspect: number = DEFAULT_CONTENT_ASPECT) {
  const geometry = getPortraitPresentationGeometry(layout, count, contentAspect);
  return {
    ...geometry,
    containerStyle: PORTRAIT_CONTAINER_STYLE,
    mediaStyle: {
      ...rectStyle(geometry.media),
      borderRadius: geometry.participants.length > 0 ? 10 : 0,
      transition: 'left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease, border-radius 0.3s ease',
    } as CSSProperties,
    participantStyles: geometry.participants.map((rect) => ({
      ...rectStyle(rect),
      zIndex: 6,
      borderRadius: 10,
      overflow: 'hidden',
    } as CSSProperties)),
  };
}
