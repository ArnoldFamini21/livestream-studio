import type { ParticipantRole } from '@studio/shared';
import type { CSSProperties } from 'react';
import type { LowerThirdData } from '../components/LowerThird.tsx';

export type LowerThirdDraft = Omit<LowerThirdData, 'id' | 'visible'> & { visible?: boolean };
export type LowerThirdAnimation = 'slide' | 'fade' | 'bounce';
export type LowerThirdAnimationDirection = 'left' | 'right' | 'up' | 'down';
export type LowerThirdFont = 'inter' | 'serif' | 'mono' | 'display';

export const AUTO_SPEAKER_LOWER_THIRD_DURATION_SECONDS = 5;
export const AUTO_SPEAKER_LOWER_THIRD_MIN_LEVEL = 12;
export const DEFAULT_LOWER_THIRD_ANIMATION: LowerThirdAnimation = 'slide';
export const DEFAULT_LOWER_THIRD_ANIMATION_DIRECTION: LowerThirdAnimationDirection = 'left';
export const DEFAULT_LOWER_THIRD_FONT: LowerThirdFont = 'inter';
export const LOWER_THIRD_ANIMATION_EXIT_MS = 420;

export const LOWER_THIRD_ANIMATION_PRESETS: Array<{ id: LowerThirdAnimation; label: string }> = [
  { id: 'slide', label: 'Slide' },
  { id: 'fade', label: 'Fade' },
  { id: 'bounce', label: 'Bounce' },
];

export const LOWER_THIRD_ANIMATION_DIRECTION_PRESETS: Array<{ id: LowerThirdAnimationDirection; label: string }> = [
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'up', label: 'Up' },
  { id: 'down', label: 'Down' },
];

export const LOWER_THIRD_FONT_PRESETS: Array<{ id: LowerThirdFont; label: string; cssFamily: string; canvasFamily: string }> = [
  {
    id: 'inter',
    label: 'Sans',
    cssFamily: 'Inter, Arial, sans-serif',
    canvasFamily: 'Inter, Arial, sans-serif',
  },
  {
    id: 'serif',
    label: 'Serif',
    cssFamily: 'Georgia, "Times New Roman", serif',
    canvasFamily: 'Georgia, "Times New Roman", serif',
  },
  {
    id: 'mono',
    label: 'Mono',
    cssFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    canvasFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
  {
    id: 'display',
    label: 'Display',
    cssFamily: '"Arial Black", Inter, Arial, sans-serif',
    canvasFamily: '"Arial Black", Inter, Arial, sans-serif',
  },
];

export interface AutoSpeakerLowerThirdCandidate {
  participantId: string;
  name: string;
  title: string;
  audioLevel: number;
  eligible?: boolean;
}

const LOWER_THIRD_HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const LOWER_THIRD_ANIMATION_IDS = new Set<LowerThirdAnimation>(
  LOWER_THIRD_ANIMATION_PRESETS.map((preset) => preset.id)
);
const LOWER_THIRD_ANIMATION_DIRECTION_IDS = new Set<LowerThirdAnimationDirection>(
  LOWER_THIRD_ANIMATION_DIRECTION_PRESETS.map((preset) => preset.id)
);
const LOWER_THIRD_FONT_IDS = new Set<LowerThirdFont>(
  LOWER_THIRD_FONT_PRESETS.map((preset) => preset.id)
);

export function getParticipantLowerThirdTitle(role: ParticipantRole): string {
  switch (role) {
    case 'host':
      return 'Host';
    case 'co-host':
      return 'Co-host';
    case 'guest':
      return 'Guest';
  }
}

export function normalizeLowerThirdAccentColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return LOWER_THIRD_HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function normalizeLowerThirdAnimation(value: unknown): LowerThirdAnimation {
  return typeof value === 'string' && LOWER_THIRD_ANIMATION_IDS.has(value as LowerThirdAnimation)
    ? value as LowerThirdAnimation
    : DEFAULT_LOWER_THIRD_ANIMATION;
}

export function normalizeLowerThirdAnimationDirection(value: unknown): LowerThirdAnimationDirection {
  return typeof value === 'string' && LOWER_THIRD_ANIMATION_DIRECTION_IDS.has(value as LowerThirdAnimationDirection)
    ? value as LowerThirdAnimationDirection
    : DEFAULT_LOWER_THIRD_ANIMATION_DIRECTION;
}

export function normalizeLowerThirdFont(value: unknown): LowerThirdFont {
  return typeof value === 'string' && LOWER_THIRD_FONT_IDS.has(value as LowerThirdFont)
    ? value as LowerThirdFont
    : DEFAULT_LOWER_THIRD_FONT;
}

export function getLowerThirdAnimationLabel(value: unknown): string {
  const animation = normalizeLowerThirdAnimation(value);
  return LOWER_THIRD_ANIMATION_PRESETS.find((preset) => preset.id === animation)?.label || 'Slide';
}

export function getLowerThirdAnimationDirectionLabel(value: unknown): string {
  const direction = normalizeLowerThirdAnimationDirection(value);
  return LOWER_THIRD_ANIMATION_DIRECTION_PRESETS.find((preset) => preset.id === direction)?.label || 'Left';
}

export function getLowerThirdFontLabel(value: unknown): string {
  const font = normalizeLowerThirdFont(value);
  return LOWER_THIRD_FONT_PRESETS.find((preset) => preset.id === font)?.label || 'Sans';
}

export function getLowerThirdFontCssFamily(value: unknown): string {
  const font = normalizeLowerThirdFont(value);
  return LOWER_THIRD_FONT_PRESETS.find((preset) => preset.id === font)?.cssFamily
    || LOWER_THIRD_FONT_PRESETS[0].cssFamily;
}

export function buildLowerThirdCanvasFont(weight: number, sizePx: number, value: unknown): string {
  const font = normalizeLowerThirdFont(value);
  const family = LOWER_THIRD_FONT_PRESETS.find((preset) => preset.id === font)?.canvasFamily
    || LOWER_THIRD_FONT_PRESETS[0].canvasFamily;
  return `${weight} ${sizePx}px ${family}`;
}

function getLowerThirdHiddenOffset(direction: LowerThirdAnimationDirection): string {
  switch (direction) {
    case 'right':
      return '24px, 16px';
    case 'up':
      return '0, 24px';
    case 'down':
      return '0, -24px';
    case 'left':
    default:
      return '-24px, 16px';
  }
}

export function getLowerThirdAnimationStyle(
  animation: LowerThirdAnimation,
  visible: boolean,
  direction: LowerThirdAnimationDirection = DEFAULT_LOWER_THIRD_ANIMATION_DIRECTION
): CSSProperties {
  const normalizedDirection = normalizeLowerThirdAnimationDirection(direction);
  const hiddenOffset = getLowerThirdHiddenOffset(normalizedDirection);

  switch (animation) {
    case 'fade':
      return {
        opacity: visible ? 1 : 0,
        transform: 'translate3d(0, 0, 0)',
        transition: 'opacity 320ms cubic-bezier(0.16, 1, 0.3, 1)',
      };
    case 'bounce':
      return {
        opacity: visible ? 1 : 0,
        transform: visible ? 'translate3d(0, 0, 0) scale(1)' : `translate3d(${hiddenOffset}, 0) scale(0.94)`,
        transition: visible
          ? 'opacity 260ms ease-out, transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)'
          : 'opacity 220ms ease-in, transform 260ms ease-in',
      };
    case 'slide':
    default:
      return {
        opacity: visible ? 1 : 0,
        transform: visible ? 'translate3d(0, 0, 0)' : `translate3d(${hiddenOffset}, 0)`,
        transition: 'opacity 360ms cubic-bezier(0.16, 1, 0.3, 1), transform 400ms cubic-bezier(0.16, 1, 0.3, 1)',
      };
  }
}

export function normalizeLowerThirdDurationSeconds(value: unknown): number | null {
  const durationSeconds = Number(value);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.min(3600, Math.max(1, Math.round(durationSeconds)));
}

export function selectAutoSpeakerLowerThirdCandidate(
  candidates: AutoSpeakerLowerThirdCandidate[],
  minLevel = AUTO_SPEAKER_LOWER_THIRD_MIN_LEVEL,
): AutoSpeakerLowerThirdCandidate | null {
  return candidates
    .filter((candidate) => (
      candidate.eligible !== false
      && candidate.name.trim()
      && Number.isFinite(candidate.audioLevel)
      && candidate.audioLevel >= minLevel
    ))
    .sort((a, b) => b.audioLevel - a.audioLevel || a.name.localeCompare(b.name))[0] || null;
}

export function upsertAutoSpeakerLowerThird(
  current: LowerThirdData[],
  speaker: Pick<AutoSpeakerLowerThirdCandidate, 'participantId' | 'name' | 'title'>,
  id: string,
): LowerThirdData[] {
  const existing = current.find((item) => item.source === 'auto-speaker');
  const nextAutoLowerThird: LowerThirdData = {
    id: existing?.id || id,
    name: speaker.name,
    title: speaker.title,
    style: existing?.style || 'bold',
    visible: true,
    durationSeconds: AUTO_SPEAKER_LOWER_THIRD_DURATION_SECONDS,
    accentColor: existing?.accentColor,
    animation: existing?.animation || DEFAULT_LOWER_THIRD_ANIMATION,
    animationDirection: existing?.animationDirection,
    fontFamily: existing?.fontFamily,
    source: 'auto-speaker',
    participantId: speaker.participantId,
  };

  if (existing) {
    return current.map((item) => (
      item.id === existing.id
        ? nextAutoLowerThird
        : { ...item, visible: false }
    ));
  }

  return [
    ...current.map((item) => ({ ...item, visible: false })),
    nextAutoLowerThird,
  ];
}

export function addLowerThird(
  current: LowerThirdData[],
  draft: LowerThirdDraft,
  id: string,
): LowerThirdData[] {
  const nextVisible = draft.visible ?? false;
  const lowerThird: LowerThirdData = {
    ...draft,
    id,
    visible: nextVisible,
  };

  if (!nextVisible) return [...current, lowerThird];

  return [
    ...current.map((item) => ({ ...item, visible: false })),
    lowerThird,
  ];
}

export function toggleLowerThirdVisibility(
  current: LowerThirdData[],
  id: string,
): LowerThirdData[] {
  const target = current.find((item) => item.id === id);
  if (!target) return current;

  if (target.visible) {
    return current.map((item) => (
      item.id === id ? { ...item, visible: false } : item
    ));
  }

  return current.map((item) => ({
    ...item,
    visible: item.id === id,
  }));
}
