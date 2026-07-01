import type { Scene } from '@studio/shared';
import { normalizeStageItemOrder } from './stageItemOrder.ts';

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
