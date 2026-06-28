import type { CSSProperties } from 'react';

export type SceneTransitionPresetId = 'fade' | 'wipe' | 'slide' | 'zoom';

export interface SceneTransitionPreset {
  id: SceneTransitionPresetId;
  label: string;
}

export const DEFAULT_SCENE_TRANSITION_PRESET_ID: SceneTransitionPresetId = 'fade';

export const SCENE_TRANSITION_PRESETS: SceneTransitionPreset[] = [
  { id: 'fade', label: 'Crossfade' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'slide', label: 'Slide' },
  { id: 'zoom', label: 'Zoom' },
];

const SCENE_TRANSITION_PRESET_IDS = new Set<SceneTransitionPresetId>(
  SCENE_TRANSITION_PRESETS.map((preset) => preset.id)
);

export function normalizeSceneTransitionPresetId(value: unknown): SceneTransitionPresetId {
  return typeof value === 'string' && SCENE_TRANSITION_PRESET_IDS.has(value as SceneTransitionPresetId)
    ? value as SceneTransitionPresetId
    : DEFAULT_SCENE_TRANSITION_PRESET_ID;
}

export function getSceneTransitionPresetLabel(presetId: SceneTransitionPresetId): string {
  return SCENE_TRANSITION_PRESETS.find((preset) => preset.id === presetId)?.label || 'Crossfade';
}

export function getSceneTransitionOverlayStyle(input: {
  presetId: SceneTransitionPresetId;
  visible: boolean;
  durationMs: number;
  brandColor?: string;
}): CSSProperties {
  const durationMs = Math.max(120, Math.min(1500, Math.round(input.durationMs)));
  const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const brand = input.brandColor || '#8b5cf6';

  switch (input.presetId) {
    case 'wipe':
      return {
        opacity: 1,
        clipPath: input.visible ? 'inset(0 0 0 0)' : 'inset(0 0 0 100%)',
        background: `linear-gradient(90deg, rgba(2, 6, 23, 0.92), ${brand}66)`,
        transition: `clip-path ${durationMs}ms ${easing}`,
        willChange: 'clip-path',
      };
    case 'slide':
      return {
        opacity: 1,
        transform: input.visible ? 'translateX(0)' : 'translateX(105%)',
        background: `linear-gradient(90deg, rgba(15, 23, 42, 0.94), ${brand}55)`,
        transition: `transform ${durationMs}ms ${easing}`,
        willChange: 'transform',
      };
    case 'zoom':
      return {
        opacity: input.visible ? 1 : 0,
        transform: input.visible ? 'scale(1)' : 'scale(1.08)',
        background: 'rgba(2, 6, 23, 0.42)',
        transition: `opacity ${durationMs}ms ${easing}, transform ${durationMs}ms ${easing}`,
        willChange: 'opacity, transform',
      };
    case 'fade':
    default:
      return {
        opacity: input.visible ? 1 : 0,
        background: 'rgba(2, 6, 23, 0.38)',
        transition: `opacity ${durationMs}ms ${easing}`,
        willChange: 'opacity',
      };
  }
}
