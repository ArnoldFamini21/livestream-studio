import type { ActiveMedia, Scene, SceneActiveMedia, StudioMediaAsset } from '@studio/shared';
import { normalizeStageItemOrder } from './stageItemOrder.ts';
import { clampPresentationSlideIndex } from './presentationDeckControls.ts';

export type ScenePipCorner = NonNullable<Scene['pipCorner']>;

export const DEFAULT_SCENE_PIP_CORNER: ScenePipCorner = 'BR';

const SCENE_PIP_CORNERS = new Set<ScenePipCorner>(['TL', 'TR', 'BL', 'BR']);

export function getScenePipCornerForApply(scene: Pick<Partial<Scene>, 'pipCorner'>): ScenePipCorner {
  return SCENE_PIP_CORNERS.has(scene.pipCorner as ScenePipCorner)
    ? scene.pipCorner as ScenePipCorner
    : DEFAULT_SCENE_PIP_CORNER;
}

export function getSceneStageItemOrderForApply(
  scene: Pick<Partial<Scene>, 'stageItemOrder'>,
  availableStageItemIds: string[]
): string[] {
  return Array.isArray(scene.stageItemOrder)
    ? normalizeStageItemOrder(scene.stageItemOrder, availableStageItemIds)
    : [];
}

export function normalizeSceneActiveMediaSnapshot(input: unknown): SceneActiveMedia | null {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as Partial<SceneActiveMedia>;
  const assetId = typeof candidate.assetId === 'string' ? candidate.assetId.trim().slice(0, 128) : '';
  if (!assetId) return null;

  const slideIndex = typeof candidate.slideIndex === 'number' && Number.isFinite(candidate.slideIndex)
    ? Math.max(0, Math.floor(candidate.slideIndex))
    : undefined;

  return {
    assetId,
    ...(slideIndex !== undefined ? { slideIndex } : {}),
  };
}

export function getSceneActiveMediaSnapshot(
  activeMedia: ActiveMedia | null | undefined,
  slideIndex: number
): SceneActiveMedia | null {
  const media = activeMedia;
  const assetId = media?.assetId?.trim();
  if (!media || !assetId) return null;
  const slides = media.preview?.kind === 'presentation-slides' ? media.preview.slides : [];
  const normalizedSlideIndex = slides.length > 0
    ? clampPresentationSlideIndex(slideIndex, slides.length)
    : 0;

  return {
    assetId,
    ...(slides.length > 0 ? { slideIndex: normalizedSlideIndex } : {}),
  };
}

export function getSceneActiveMediaForApply(
  scene: Pick<Partial<Scene>, 'activeMedia'>,
  mediaAssets: StudioMediaAsset[]
): { activeMedia: ActiveMedia | null; slideIndex: number } {
  const snapshot = normalizeSceneActiveMediaSnapshot(scene.activeMedia);
  if (!snapshot) return { activeMedia: null, slideIndex: 0 };

  const asset = mediaAssets.find((item) => item.id === snapshot.assetId);
  if (!asset) return { activeMedia: null, slideIndex: 0 };

  const slides = asset.preview?.kind === 'presentation-slides' ? asset.preview.slides : [];
  const slideIndex = slides.length > 0
    ? clampPresentationSlideIndex(snapshot.slideIndex ?? 0, slides.length)
    : 0;

  return {
    activeMedia: {
      assetId: asset.id,
      type: asset.type,
      url: asset.url,
      name: asset.name,
      preview: asset.preview,
    },
    slideIndex,
  };
}
