import type { ActiveMedia, PresentationSlidePreview } from '@studio/shared';

export type PresentationSlideDirection = 'previous' | 'next';

export interface PresentationDeckStatus {
  hasDeck: boolean;
  slides: PresentationSlidePreview[];
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

export function getPresentationSlides(media: ActiveMedia | null | undefined): PresentationSlidePreview[] {
  if (media?.type !== 'presentation' || media.preview?.kind !== 'presentation-slides') return [];
  return media.preview.slides;
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

export function getPresentationSlidePickerItems(
  slides: PresentationSlidePreview[],
  currentIndex: number
): PresentationSlidePickerItem[] {
  const normalizedIndex = clampPresentationSlideIndex(currentIndex, slides.length);
  return slides.map((slide, index) => ({
    index,
    label: `Slide ${index + 1}`,
    title: getPresentationSlideDisplayTitle(slide, index),
    imageUrl: slide.imageUrl,
    isCurrent: index === normalizedIndex,
  }));
}

export function getPresentationDeckStatus(
  media: ActiveMedia | null | undefined,
  slideIndex: number
): PresentationDeckStatus {
  const slides = getPresentationSlides(media);
  const total = slides.length;
  const currentIndex = clampPresentationSlideIndex(slideIndex, total);

  return {
    hasDeck: total > 0,
    slides,
    total,
    currentIndex,
    currentSlide: slides[currentIndex] || null,
    previousSlide: currentIndex > 0 ? slides[currentIndex - 1] : null,
    nextSlide: currentIndex < total - 1 ? slides[currentIndex + 1] : null,
    canGoPrevious: currentIndex > 0,
    canGoNext: currentIndex < total - 1,
  };
}
