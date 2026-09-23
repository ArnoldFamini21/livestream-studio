import type { LayoutMode } from '@studio/shared';

export const STUDIO_LAYOUT_PRESET_ORDER: LayoutMode[] = [
  'grid',
  'spotlight',
  'side-by-side',
  'pip',
  'single',
  'featured',
];

/** The order of the layout bar while media or a screen share is on stage. */
export const MEDIA_SHARE_LAYOUT_ORDER: LayoutMode[] = ['single', 'grid', 'spotlight', 'pip', 'side-by-side', 'featured'];

export const MEDIA_SHARE_LAYOUT_SHORT_LABELS: Record<LayoutMode, string> = {
  single: 'Content',
  grid: 'Beside',
  spotlight: 'Below',
  pip: 'PiP',
  'side-by-side': 'Split',
  featured: 'Stack',
};

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
  grid: 'Beside',
  spotlight: 'Below',
  'side-by-side': 'Split',
  featured: 'Stack',
  pip: 'Picture in picture',
  single: 'Content only',
};

export const MEDIA_SHARE_LAYOUT_DESCRIPTIONS: Record<LayoutMode, string> = {
  grid: 'Shared media with up to 4 participants in a side rail',
  spotlight: 'Shared media with up to 6 participants below',
  'side-by-side': 'Shared media beside up to 2 participant videos',
  featured: 'Shared media with up to 4 stacked floating participant videos',
  pip: 'Shared media with up to 4 floating participant videos',
  single: 'Full canvas for shared content, with cameras hidden',
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

/** The layouts on the layout bar, in the order shown; keys 1-6 follow it. */
export function getLayoutBarOrder(isMediaActive: boolean): LayoutMode[] {
  return isMediaActive ? MEDIA_SHARE_LAYOUT_ORDER : STUDIO_LAYOUT_PRESET_ORDER;
}

export function getLayoutBarLabel(layout: LayoutMode, isMediaActive: boolean): string {
  return isMediaActive ? MEDIA_SHARE_LAYOUT_SHORT_LABELS[layout] : STUDIO_LAYOUT_LABELS[layout];
}

export function isLayoutBarOptionDisabled(
  layout: LayoutMode,
  options: { isMediaActive: boolean; participantCount: number; mediaParticipantCount?: number }
): boolean {
  if (options.isMediaActive) {
    const presenters = options.mediaParticipantCount ?? Math.max(0, options.participantCount - 1);
    return layout !== 'single' && presenters <= 0;
  }
  return options.participantCount < 2 && isMultiParticipantLayout(layout);
}
