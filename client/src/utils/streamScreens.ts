import type { StageBackground } from '@studio/shared';
import {
  getPersistableWaitingRoomLogoUrl,
  getPersistableWaitingRoomStageBackground,
} from './waitingRoomBranding.ts';

export type StreamScreenKind = 'starting' | 'ending';
export type StreamScreenBackgroundMode = 'brand' | 'stage';

export interface StreamScreenDraft {
  headline: string;
  message: string;
  backgroundMode: StreamScreenBackgroundMode;
  showLogo: boolean;
  countdownSeconds?: number;
}

export interface StreamScreenConfig {
  starting: StreamScreenDraft;
  ending: StreamScreenDraft;
}

export interface ActiveStreamScreen {
  kind: StreamScreenKind;
  headline: string;
  message: string;
  background: StageBackground;
  brandColor: string;
  logoUrl: string | null;
  countdownSeconds?: number;
  activatedAtMs: number;
}

export const MAX_STREAM_SCREEN_HEADLINE_LENGTH = 90;
export const MAX_STREAM_SCREEN_MESSAGE_LENGTH = 240;
export const MIN_STREAM_SCREEN_COUNTDOWN_SECONDS = 0;
export const MAX_STREAM_SCREEN_COUNTDOWN_SECONDS = 3600;

export const DEFAULT_STREAM_SCREEN_CONFIG: StreamScreenConfig = {
  starting: {
    headline: 'Starting Soon',
    message: 'The live broadcast will begin shortly.',
    backgroundMode: 'brand',
    showLogo: true,
    countdownSeconds: 300,
  },
  ending: {
    headline: 'Thanks for watching',
    message: 'See you next time.',
    backgroundMode: 'brand',
    showLogo: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLength) || fallback;
}

function normalizeCountdownSeconds(value: unknown, fallback: number | undefined): number | undefined {
  if (value === undefined && fallback === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  if (safe === undefined) return undefined;
  return Math.min(
    MAX_STREAM_SCREEN_COUNTDOWN_SECONDS,
    Math.max(MIN_STREAM_SCREEN_COUNTDOWN_SECONDS, Math.round(safe))
  );
}

export function normalizeStreamScreenDraft(kind: StreamScreenKind, value: unknown): StreamScreenDraft {
  const fallback = DEFAULT_STREAM_SCREEN_CONFIG[kind];
  if (!isRecord(value)) return fallback;

  return {
    headline: normalizeText(value.headline, MAX_STREAM_SCREEN_HEADLINE_LENGTH, fallback.headline),
    message: normalizeText(value.message, MAX_STREAM_SCREEN_MESSAGE_LENGTH, fallback.message),
    backgroundMode: value.backgroundMode === 'stage' ? 'stage' : 'brand',
    showLogo: typeof value.showLogo === 'boolean' ? value.showLogo : fallback.showLogo,
    countdownSeconds: kind === 'starting'
      ? normalizeCountdownSeconds(value.countdownSeconds, fallback.countdownSeconds)
      : undefined,
  };
}

export function normalizeStreamScreenConfig(value: unknown): StreamScreenConfig {
  if (!isRecord(value)) return DEFAULT_STREAM_SCREEN_CONFIG;
  return {
    starting: normalizeStreamScreenDraft('starting', value.starting),
    ending: normalizeStreamScreenDraft('ending', value.ending),
  };
}

function normalizeBrandColor(value: string): string {
  return /^#[\da-f]{6}$/i.test(value) ? value : '#a78bfa';
}

function buildBrandBackground(brandColor: string): StageBackground {
  const safeBrandColor = normalizeBrandColor(brandColor);
  return {
    type: 'gradient',
    value: `linear-gradient(135deg, #020617 0%, ${safeBrandColor} 54%, #0f172a 100%)`,
  };
}

export function buildActiveStreamScreen(
  kind: StreamScreenKind,
  config: StreamScreenConfig,
  visuals: {
    brandColor: string;
    logoUrl: string | null;
    stageBackground: StageBackground;
  },
  activatedAtMs = Date.now()
): ActiveStreamScreen {
  const normalizedConfig = normalizeStreamScreenConfig(config);
  const draft = normalizedConfig[kind];
  const stageBackground = getPersistableWaitingRoomStageBackground(visuals.stageBackground);

  return {
    kind,
    headline: draft.headline,
    message: draft.message,
    background: draft.backgroundMode === 'stage' && stageBackground.type !== 'none'
      ? stageBackground
      : buildBrandBackground(visuals.brandColor),
    brandColor: normalizeBrandColor(visuals.brandColor),
    logoUrl: draft.showLogo ? getPersistableWaitingRoomLogoUrl(visuals.logoUrl) : null,
    countdownSeconds: kind === 'starting' ? draft.countdownSeconds : undefined,
    activatedAtMs,
  };
}
