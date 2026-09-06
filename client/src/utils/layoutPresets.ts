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
  grid: 'Auto-fit grid for 1-12 people',
  spotlight: 'One large tile with others below',
  'side-by-side': 'Two equal tiles',
  featured: 'Main tile with side stack',
  pip: 'Full tile with small overlay',
  single: 'Show one selected tile',
};

export const MEDIA_SHARE_LAYOUT_LABELS: Record<LayoutMode, string> = {
  grid: 'Media Rail',
  spotlight: 'Speaker Strip',
  'side-by-side': 'Split Stage',
  featured: 'Presenter Stack',
  pip: 'Floating PiP',
  single: 'Presenter PiP',
};

export const MEDIA_SHARE_LAYOUT_DESCRIPTIONS: Record<LayoutMode, string> = {
  grid: 'Shared media with up to 4 participants in a side rail',
  spotlight: 'Shared media with up to 6 participants below',
  'side-by-side': 'Shared media beside up to 2 participant videos',
  featured: 'Shared media with up to 4 stacked floating participant videos',
  pip: 'Shared media with up to 4 floating participant videos',
  single: 'Shared media with one floating presenter video',
};

export function getStudioLayoutLabel(layout: LayoutMode): string {
  return STUDIO_LAYOUT_LABELS[layout];
}

export function getStudioLayoutDescription(layout: LayoutMode): string {
  return STUDIO_LAYOUT_DESCRIPTIONS[layout];
}

export function getMediaShareLayoutLabel(layout: LayoutMode): string {
  return MEDIA_SHARE_LAYOUT_LABELS[layout];
}

export function getMediaShareLayoutDescription(layout: LayoutMode): string {
  return MEDIA_SHARE_LAYOUT_DESCRIPTIONS[layout];
}

export function isMultiParticipantLayout(layout: LayoutMode): boolean {
  return layout === 'spotlight' || layout === 'side-by-side' || layout === 'featured' || layout === 'pip';
}

export function getAutoGridColumnCount(count: number): number {
  if (!Number.isFinite(count) || count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  if (count <= 16) return 4;
  return Math.ceil(Math.sqrt(count * 16 / 9));
}
