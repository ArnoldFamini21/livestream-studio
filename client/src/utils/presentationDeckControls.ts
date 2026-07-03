import type { ActiveMedia, PresentationSlidePreview, StudioMediaAssetPreview } from '@studio/shared';
import { hasRenderedPresentationSlides } from './presentationPreview.ts';

export type PresentationSlideDirection = 'previous' | 'next';
export type PresentationDeckSourceFormat = StudioMediaAssetPreview['sourceFormat'];

export interface PresentationDeckStatus {
  hasDeck: boolean;
  slides: PresentationSlidePreview[];
  sourceFormat: PresentationDeckSourceFormat | null;
  unitLabel: string;
  total: number;
  currentIndex: number;
  currentSlide: PresentationSlidePreview | null;
  previousSlide: PresentationSlidePreview | null;
  nextSlide: PresentationSlidePreview | null;
  canGoPrevious: boolean;
  canGoNext: boolean;
}

export interface PresentationSlidePickerItem {
  index: number;
  label: string;
  title: string;
  imageUrl?: string;
  isCurrent: boolean;
}

export interface PresentationPresenterCard {
  kind: 'current' | 'next';
  label: string;
  index: number | null;
  title: string;
  imageUrl?: string;
  notes: string[];
  isEnd: boolean;
}

export function getPresentationSlides(media: ActiveMedia | null | undefined): PresentationSlidePreview[] {
  if (media?.type !== 'presentation' && media?.type !== 'pdf') return [];
  if (media?.preview?.kind !== 'presentation-slides') return [];
  if (!hasRenderedPresentationSlides(media.preview)) return [];
  return media.preview.slides;
}

export function getPresentationSourceFormat(media: ActiveMedia | null | undefined): PresentationDeckSourceFormat | null {
  if (media?.type !== 'presentation' && media?.type !== 'pdf') return null;
  if (!hasRenderedPresentationSlides(media?.preview)) return null;
  return media?.preview?.kind === 'presentation-slides' ? media.preview.sourceFormat : null;
}

export function getPresentationDeckUnitLabel(sourceFormat: PresentationDeckSourceFormat | null | undefined): string {
  return sourceFormat === 'pdf' ? 'Page' : 'Slide';
}

export function clampPresentationSlideIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, Math.floor(Number.isFinite(index) ? index : 0)));
}

export function getNextPresentationSlideIndex(
  currentIndex: number,
  total: number,
  direction: PresentationSlideDirection
): number {
  const normalized = clampPresentationSlideIndex(currentIndex, total);
  if (direction === 'previous') return clampPresentationSlideIndex(normalized - 1, total);
  return clampPresentationSlideIndex(normalized + 1, total);
}

export function getPresentationSlideDisplayTitle(slide: PresentationSlidePreview | null | undefined, index: number): string {
  const title = slide?.title?.trim();
  return title || `Slide ${Math.max(0, index) + 1}`;
}

export function getPresentationItemDisplayTitle(
  slide: PresentationSlidePreview | null | undefined,
  index: number,
  unitLabel = 'Slide'
): string {
  const title = slide?.title?.trim();
  return title || `${unitLabel} ${Math.max(0, index) + 1}`;
}

export function getPresentationSlidePickerItems(
  slides: PresentationSlidePreview[],
  currentIndex: number,
  unitLabel = 'Slide'
): PresentationSlidePickerItem[] {
  const normalizedIndex = clampPresentationSlideIndex(currentIndex, slides.length);
  return slides.map((slide, index) => ({
    index,
    label: `${unitLabel} ${index + 1}`,
    title: getPresentationItemDisplayTitle(slide, index, unitLabel),
    imageUrl: slide.imageUrl,
    isCurrent: index === normalizedIndex,
  }));
}

export function getPresentationDeckStatus(
  media: ActiveMedia | null | undefined,
  slideIndex: number
): PresentationDeckStatus {
  const slides = getPresentationSlides(media);
  const sourceFormat = getPresentationSourceFormat(media);
  const unitLabel = getPresentationDeckUnitLabel(sourceFormat);
  const total = slides.length;
  const currentIndex = clampPresentationSlideIndex(slideIndex, total);

  return {
    hasDeck: total > 0,
    slides,
    sourceFormat,
    unitLabel,
    total,
    currentIndex,
    currentSlide: slides[currentIndex] || null,
    previousSlide: currentIndex > 0 ? slides[currentIndex - 1] : null,
    nextSlide: currentIndex < total - 1 ? slides[currentIndex + 1] : null,
    canGoPrevious: currentIndex > 0,
    canGoNext: currentIndex < total - 1,
  };
}

export function getPresentationPresenterCards(status: PresentationDeckStatus): PresentationPresenterCard[] {
  const currentTitle = status.currentSlide
    ? getPresentationItemDisplayTitle(status.currentSlide, status.currentIndex, status.unitLabel)
    : `No ${status.unitLabel.toLowerCase()}`;
  const nextIndex = status.currentIndex + 1;

  return [
    {
      kind: 'current',
      label: `Current ${status.unitLabel}`,
      index: status.currentSlide ? status.currentIndex : null,
      title: currentTitle,
      imageUrl: status.currentSlide?.imageUrl,
      notes: status.currentSlide?.notes || [],
      isEnd: false,
    },
    status.nextSlide
      ? {
          kind: 'next',
          label: `Next ${status.unitLabel}`,
          index: nextIndex,
          title: getPresentationItemDisplayTitle(status.nextSlide, nextIndex, status.unitLabel),
          imageUrl: status.nextSlide.imageUrl,
          notes: status.nextSlide.notes || [],
          isEnd: false,
        }
      : {
          kind: 'next',
          label: 'Up Next',
          index: null,
          title: 'End of deck',
          notes: [],
          isEnd: true,
        },
  ];
}
