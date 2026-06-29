import type { LayoutMode } from '@studio/shared';

export const STUDIO_LAYOUT_PRESET_ORDER: LayoutMode[] = [
  'grid',
  'spotlight',
  'side-by-side',
  'pip',
  'single',
  'featured',
];

export const STUDIO_LAYOUT_LABELS: Record<LayoutMode, string> = {
  grid: 'Grid',
  spotlight: 'Spotlight',
  'side-by-side': 'Side by Side',
  featured: 'Featured',
  pip: 'PiP',
  single: 'Solo',
};

export const STUDIO_LAYOUT_DESCRIPTIONS: Record<LayoutMode, string> = {
  grid: 'Auto-fit grid for 1-7 people',
  spotlight: 'One large tile with others below',
  'side-by-side': 'Two equal tiles',
  featured: 'Main tile with side stack',
  pip: 'Full tile with small overlay',
  single: 'Show one selected tile',
};

export function getStudioLayoutLabel(layout: LayoutMode): string {
  return STUDIO_LAYOUT_LABELS[layout];
}

export function getStudioLayoutDescription(layout: LayoutMode): string {
  return STUDIO_LAYOUT_DESCRIPTIONS[layout];
}

export function isMultiParticipantLayout(layout: LayoutMode): boolean {
  return layout === 'spotlight' || layout === 'side-by-side' || layout === 'featured' || layout === 'pip';
}
