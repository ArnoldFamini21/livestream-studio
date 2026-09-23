import type { LayoutMode } from '@studio/shared';

export const STUDIO_LAYOUT_PRESET_ORDER: LayoutMode[] = [
  'grid',
  'spotlight',
  'side-by-side',
  'pip',
  'single',
  'featured',
];

/** The content layouts used while media or a screen share is on stage. */
export const MEDIA_SHARE_LAYOUT_ORDER: LayoutMode[] = ['single', 'grid'];

/**
 * Presenting uses only Content (full) and Content + Me (beside). Studios and
 * scenes saved with a retired layout (Below, PiP, Split, Stack) open beside.
 */
export function normalizeMediaShareLayout(layout: LayoutMode | undefined | null): LayoutMode {
  return layout && MEDIA_SHARE_LAYOUT_ORDER.includes(layout) ? layout : 'grid';
}

/**
 * What the stage shows while something is shared. "Me" hides the content
 * without unloading it, so switching back is instant.
 */
export type PresentingView = 'me' | 'content' | 'content-me';

export const PRESENTING_VIEWS: PresentingView[] = ['me', 'content', 'content-me'];

export const PRESENTING_VIEW_LABELS: Record<PresentingView, string> = {
  me: 'Me',
  content: 'Content',
  'content-me': 'Content + Me',
};

export const PRESENTING_VIEW_DESCRIPTIONS: Record<PresentingView, string> = {
  me: 'Cameras full screen; the shared content stays ready',
  content: 'The shared content full screen',
  'content-me': 'The shared content with cameras beside it',
};

export function getPresentingView(contentHidden: boolean, layout: LayoutMode): PresentingView {
  if (contentHidden) return 'me';
  return normalizeMediaShareLayout(layout) === 'single' ? 'content' : 'content-me';
}

/** The content layout a view uses; "me" keeps the current one for when content returns. */
export function getPresentingViewLayout(view: PresentingView): LayoutMode | null {
  if (view === 'content') return 'single';
  if (view === 'content-me') return 'grid';
  return null;
}

/** Views with cameras need someone on camera. */
export function isPresentingViewDisabled(view: PresentingView, presenterCount: number): boolean {
  return view !== 'content' && presenterCount <= 0;
}

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

/** Whether the studio (not presenting) layout bar disables this layout. */
export function isStudioLayoutDisabled(layout: LayoutMode, participantCount: number): boolean {
  return participantCount < 2 && isMultiParticipantLayout(layout);
}
