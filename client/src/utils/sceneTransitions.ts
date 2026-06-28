import type { CSSProperties } from 'react';

export type SceneTransitionPresetId = 'fade' | 'wipe' | 'slide' | 'zoom' | 'stinger';

export interface SceneTransitionPreset {
  id: SceneTransitionPresetId;
  label: string;
}

export interface SceneStingerClip {
  name: string;
  url: string;
  source: 'upload' | 'url';
  mimeType?: string;
}

export const DEFAULT_SCENE_TRANSITION_PRESET_ID: SceneTransitionPresetId = 'fade';
export const MAX_SCENE_STINGER_FILE_BYTES = 40 * 1024 * 1024;

export const SCENE_TRANSITION_PRESETS: SceneTransitionPreset[] = [
  { id: 'fade', label: 'Crossfade' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'slide', label: 'Slide' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'stinger', label: 'Stinger' },
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

function readBoundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function validateSceneStingerFile(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  if (file.size > MAX_SCENE_STINGER_FILE_BYTES) return 'Stinger video must be 40 MB or smaller.';
  const name = file.name.toLowerCase();
  const mimeType = file.type.toLowerCase();
  const looksLikeVideo = mimeType.startsWith('video/') || /\.(webm|mp4|mov|m4v)$/i.test(name);
  return looksLikeVideo ? null : 'Choose a video file for the stinger transition.';
}

export function normalizeSceneStingerClip(value: unknown): SceneStingerClip | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const name = readBoundedString(input.name, 120);
  const url = readBoundedString(input.url, 4096);
  const source = input.source === 'upload' || input.source === 'url' ? input.source : null;
  const mimeType = readBoundedString(input.mimeType, 120);

  if (!name || !url || !source) return null;
  return {
    name,
    url,
    source,
    ...(mimeType ? { mimeType } : {}),
  };
}

export function isPersistableSceneStingerClip(clip: SceneStingerClip | null): clip is SceneStingerClip {
  if (!clip || clip.source !== 'url') return false;
  if (clip.url.startsWith('blob:')) return false;

  try {
    const parsed = new URL(clip.url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
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
    case 'stinger':
      return {
        opacity: input.visible ? 1 : 0,
        background: 'rgba(2, 6, 23, 0.72)',
        transition: `opacity ${Math.min(durationMs, 260)}ms ${easing}`,
        willChange: 'opacity',
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
