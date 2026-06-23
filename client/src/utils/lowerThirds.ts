import type { ParticipantRole } from '@studio/shared';
import type { LowerThirdData } from '../components/LowerThird.tsx';

export type LowerThirdDraft = Omit<LowerThirdData, 'id' | 'visible'> & { visible?: boolean };

export const AUTO_SPEAKER_LOWER_THIRD_DURATION_SECONDS = 5;
export const AUTO_SPEAKER_LOWER_THIRD_MIN_LEVEL = 12;

export interface AutoSpeakerLowerThirdCandidate {
  participantId: string;
  name: string;
  title: string;
  audioLevel: number;
  eligible?: boolean;
}

const LOWER_THIRD_HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

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
