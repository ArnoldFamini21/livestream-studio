import type { CSSProperties } from 'react';
import type { LayoutMode } from '@studio/shared';
import { getMediaShareLayoutPlan } from './mediaShareLayouts.ts';
import { STAGE_CANVAS_WIDTH as W, STAGE_CANVAS_HEIGHT as H } from './stageCanvas.ts';

export type PresentationCorner = 'TL' | 'TR' | 'BL' | 'BR';
export interface PresentationRect { x: number; y: number; width: number; height: number }

// Geometry is authored in broadcast coordinates, independent of panels or window size.
export function getPresentationGeometry(layout: LayoutMode, count: number, corner: PresentationCorner = 'BR') {
  const plan = getMediaShareLayoutPlan(layout, count);
  const n = plan.visibleParticipantCount;
  const inset = 12, gap = 12;
  let media: PresentationRect = { x: 0, y: 0, width: W, height: H };
  const participants: PresentationRect[] = [];
  if (n === 0) return { ...plan, media, participants };
  if (plan.placement === 'side-rail' || plan.placement === 'side-by-side') {
    const width = plan.placement === 'side-by-side' ? 288 : 200;
    const height = width * 9 / 16;
    media = { x: inset, y: inset, width: W - width - gap - inset * 2, height: H - inset * 2 };
    const top = (H - (n * height + (n - 1) * gap)) / 2;
    for (let i = 0; i < n; i++) participants.push({ x: W - inset - width, y: top + i * (height + gap), width, height });
  } else if (plan.placement === 'bottom-strip') {
    const width = Math.min(176, (W - inset * 2 - (n - 1) * gap) / n);
    const height = width * 9 / 16;
    media = { x: inset, y: inset, width: W - inset * 2, height: H - inset * 3 - height };
    const left = (W - (n * width + (n - 1) * gap)) / 2;
    for (let i = 0; i < n; i++) participants.push({ x: left + i * (width + gap), y: H - inset - height, width, height });
  } else {
    const width = n > 2 ? 172 : 216;
    const height = width * 9 / 16;
    for (let i = 0; i < n; i++) {
      const column = plan.placement === 'floating-stack' ? 0 : n > 2 ? i % 2 : 0;
      const row = plan.placement === 'floating-stack' ? i : n > 2 ? Math.floor(i / 2) : i;
      const x = corner.endsWith('L') ? 20 + column * (width + gap) : W - 20 - width - column * (width + gap);
      const y = corner.startsWith('T') ? 20 + row * (height + gap) : H - 20 - height - row * (height + gap);
      participants.push({ x, y, width, height });
    }
  }
  return { ...plan, media, participants };
}
function rectStyle(rect: PresentationRect): CSSProperties {
  return { position: 'absolute', left: `${rect.x / W * 100}%`, top: `${rect.y / H * 100}%`, width: `${rect.width / W * 100}%`, height: `${rect.height / H * 100}%`, minWidth: 0, minHeight: 0 };
}
export function getPresentationLayout(layout: LayoutMode, count: number, corner: PresentationCorner) {
  const geometry = getPresentationGeometry(layout, count, corner);
  return {
    ...geometry,
    containerStyle: { position: 'relative', width: '100%', height: '100%', padding: 0, overflow: 'hidden' } as CSSProperties,
    mediaStyle: rectStyle(geometry.media),
    participantStyles: geometry.participants.map(rect => ({ ...rectStyle(rect), zIndex: 6, borderRadius: 10, overflow: 'hidden', boxSizing: 'border-box' } as CSSProperties)),
  };
}
