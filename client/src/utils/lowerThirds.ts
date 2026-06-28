import type { ParticipantRole } from '@studio/shared';
import type { CSSProperties } from 'react';
import type { LowerThirdData } from '../components/LowerThird.tsx';

export type LowerThirdDraft = Omit<LowerThirdData, 'id' | 'visible'> & { visible?: boolean };
export type LowerThirdAnimation = 'slide' | 'fade' | 'bounce';

export const AUTO_SPEAKER_LOWER_THIRD_DURATION_SECONDS = 5;
export const AUTO_SPEAKER_LOWER_THIRD_MIN_LEVEL = 12;
export const DEFAULT_LOWER_THIRD_ANIMATION: LowerThirdAnimation = 'slide';
export const LOWER_THIRD_ANIMATION_EXIT_MS = 420;

export const LOWER_THIRD_ANIMATION_PRESETS: Array<{ id: LowerThirdAnimation; label: string }> = [
  { id: 'slide', label: 'Slide' },
  { id: 'fade', label: 'Fade' },
  { id: 'bounce', label: 'Bounce' },
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

export function getLowerThirdAnimationLabel(value: unknown): string {
  const animation = normalizeLowerThirdAnimation(value);
  return LOWER_THIRD_ANIMATION_PRESETS.find((preset) => preset.id === animation)?.label || 'Slide';
}

export function getLowerThirdAnimationStyle(animation: LowerThirdAnimation, visible: boolean): CSSProperties {
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
        transform: visible ? 'translate3d(0, 0, 0) scale(1)' : 'translate3d(0, 22px, 0) scale(0.94)',
        transition: visible
          ? 'opacity 260ms ease-out, transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1)'
          : 'opacity 220ms ease-in, transform 260ms ease-in',
      };
    case 'slide':
    default:
      return {
        opacity: visible ? 1 : 0,
        transform: visible ? 'translate3d(0, 0, 0)' : 'translate3d(-24px, 16px, 0)',
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
