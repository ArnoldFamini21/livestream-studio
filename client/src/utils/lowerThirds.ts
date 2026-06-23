import type { LowerThirdData } from '../components/LowerThird.tsx';

export type LowerThirdDraft = Omit<LowerThirdData, 'id' | 'visible'> & { visible?: boolean };

const LOWER_THIRD_HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

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
