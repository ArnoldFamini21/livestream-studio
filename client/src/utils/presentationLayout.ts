import type { CSSProperties } from 'react';
import type { LayoutMode } from '@studio/shared';
import { getMediaShareLayoutPlan } from './mediaShareLayouts.ts';
import { STAGE_CANVAS_WIDTH as W, STAGE_CANVAS_HEIGHT as H } from './stageCanvas.ts';

export type PresentationCameraSize = 'small' | 'medium' | 'large';
export function normalizePresentationCameraSize(value: unknown): PresentationCameraSize {
  return value === 'small' || value === 'large' ? value : 'medium';
}

export type PresentationCorner = 'TL' | 'TR' | 'BL' | 'BR';
export interface PresentationRect { x: number; y: number; width: number; height: number }

export const DEFAULT_CONTENT_ASPECT = 16 / 9;
const MIN_CONTENT_ASPECT = 0.5;
const MAX_CONTENT_ASPECT = 3.2;
const STAGE_INSET = 20;
const GAP = 14;
const FLOAT_INSET = 20;
const MEDIA_RADIUS = 10;
const SIZE_FACTOR: Record<PresentationCameraSize, number> = { small: 0.75, medium: 1, large: 1.3 };

/**
 * Shared content keeps its own shape. Unknown ratios use 16:9, extremes are
 * bounded, and near-16:9 sources (e.g. 1366x768 screens) snap to an exact
 * full frame so they never leave a hairline of background.
 */
export function normalizeContentAspect(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_CONTENT_ASPECT;
  if (Math.abs(value / DEFAULT_CONTENT_ASPECT - 1) < 0.01) return DEFAULT_CONTENT_ASPECT;
  return Math.min(MAX_CONTENT_ASPECT, Math.max(MIN_CONTENT_ASPECT, value));
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

function centeredFit(aspect: number): PresentationRect {
  const { width, height } = fitAspect(aspect, W, H);
  return { x: (W - width) / 2, y: (H - height) / 2, width, height };
}

/**
 * Geometry is authored in broadcast coordinates, independent of panels or
 * window size. The content frame always matches the content's own shape, so
 * slides and screens never sit inside letterbox bars; content and cameras are
 * centered together as one balanced group.
 */
export function getPresentationGeometry(
  layout: LayoutMode,
  count: number,
  corner: PresentationCorner = 'BR',
  size: PresentationCameraSize = 'medium',
  contentAspect: number = DEFAULT_CONTENT_ASPECT
) {
  const plan = getMediaShareLayoutPlan(layout, count);
  const n = plan.visibleParticipantCount;
  const aspect = normalizeContentAspect(contentAspect);
  const factor = SIZE_FACTOR[normalizePresentationCameraSize(size)];
  const participants: PresentationRect[] = [];
  let media = centeredFit(aspect);
  let mediaRadius = 0;
  if (n === 0) return { ...plan, media, mediaRadius, participants };

  if (plan.placement === 'side-rail' || plan.placement === 'side-by-side') {
    const preferredWidth = (plan.placement === 'side-by-side' ? 320 : 232) * factor;
    const widthThatFitsColumn = ((H - STAGE_INSET * 2 - (n - 1) * GAP) / n) * 16 / 9;
    const width = Math.min(preferredWidth, widthThatFitsColumn);
    const height = width * 9 / 16;
    const content = fitAspect(aspect, W - STAGE_INSET * 2 - GAP - width, H - STAGE_INSET * 2);
    const left = (W - (content.width + GAP + width)) / 2;
    media = { x: left, y: (H - content.height) / 2, width: content.width, height: content.height };
    const columnTop = (H - (n * height + (n - 1) * GAP)) / 2;
    for (let i = 0; i < n; i++) {
      participants.push({ x: left + content.width + GAP, y: columnTop + i * (height + GAP), width, height });
    }
    mediaRadius = MEDIA_RADIUS;
  } else if (plan.placement === 'bottom-strip') {
    const width = Math.min(184 * factor, (W - STAGE_INSET * 2 - (n - 1) * GAP) / n);
    const height = width * 9 / 16;
    const content = fitAspect(aspect, W - STAGE_INSET * 2, H - STAGE_INSET * 2 - GAP - height);
    const top = (H - (content.height + GAP + height)) / 2;
    media = { x: (W - content.width) / 2, y: top, width: content.width, height: content.height };
    const rowLeft = (W - (n * width + (n - 1) * GAP)) / 2;
    for (let i = 0; i < n; i++) {
      participants.push({ x: rowLeft + i * (width + GAP), y: top + content.height + GAP, width, height });
    }
    mediaRadius = MEDIA_RADIUS;
  } else {
    // Floating presenters sit over full-frame content, like a broadcast PiP.
    const rows = plan.placement === 'floating-stack' ? n : n > 2 ? Math.ceil(n / 2) : n;
    const width = Math.min((n > 2 ? 172 : 216) * factor, ((H - FLOAT_INSET * 2 - (rows - 1) * GAP) / rows) * 16 / 9);
    const height = width * 9 / 16;
    for (let i = 0; i < n; i++) {
      const column = plan.placement === 'floating-stack' ? 0 : n > 2 ? i % 2 : 0;
      const row = plan.placement === 'floating-stack' ? i : n > 2 ? Math.floor(i / 2) : i;
      const x = corner.endsWith('L') ? FLOAT_INSET + column * (width + GAP) : W - FLOAT_INSET - width - column * (width + GAP);
      const y = corner.startsWith('T') ? FLOAT_INSET + row * (height + GAP) : H - FLOAT_INSET - height - row * (height + GAP);
      participants.push({ x, y, width, height });
    }
  }
  return { ...plan, media, mediaRadius, participants };
}

function rectStyle(rect: PresentationRect): CSSProperties {
  return { position: 'absolute', left: `${rect.x / W * 100}%`, top: `${rect.y / H * 100}%`, width: `${rect.width / W * 100}%`, height: `${rect.height / H * 100}%`, minWidth: 0, minHeight: 0 };
}

export function getPresentationLayout(
  layout: LayoutMode,
  count: number,
  corner: PresentationCorner,
  size: PresentationCameraSize = 'medium',
  contentAspect: number = DEFAULT_CONTENT_ASPECT
) {
  const geometry = getPresentationGeometry(layout, count, corner, size, contentAspect);
  return {
    ...geometry,
    containerStyle: { position: 'relative', width: '100%', height: '100%', padding: 0, overflow: 'hidden' } as CSSProperties,
    mediaStyle: {
      ...rectStyle(geometry.media),
      borderRadius: geometry.mediaRadius,
      transition: 'left 0.3s ease, top 0.3s ease, width 0.3s ease, height 0.3s ease, border-radius 0.3s ease',
    } as CSSProperties,
    participantStyles: geometry.participants.map(rect => ({ ...rectStyle(rect), zIndex: 6, borderRadius: 10, overflow: 'hidden', boxSizing: 'border-box' } as CSSProperties)),
  };
}
