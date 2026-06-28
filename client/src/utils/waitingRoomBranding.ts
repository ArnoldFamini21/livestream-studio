import type { StageBackground, StudioBrandingPayload, WaitingRoomBranding } from '@studio/shared';

export const DEFAULT_WAITING_ROOM_BRANDING: WaitingRoomBranding = {
  headline: "You're in the green room",
  message: 'The host can see that you arrived and will bring you on stage when ready.',
  backgroundMode: 'brand',
  showLogo: true,
};

export const MAX_WAITING_ROOM_HEADLINE_LENGTH = 80;
export const MAX_WAITING_ROOM_MESSAGE_LENGTH = 220;
export const MAX_WAITING_ROOM_LOGO_URL_LENGTH = 600_000;
export const MAX_WAITING_ROOM_BACKGROUND_VALUE_LENGTH = 600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, maxLength) || fallback;
}

export function normalizeWaitingRoomBranding(value: unknown): WaitingRoomBranding {
  if (!isRecord(value)) return DEFAULT_WAITING_ROOM_BRANDING;
  return {
    headline: normalizeText(value.headline, MAX_WAITING_ROOM_HEADLINE_LENGTH, DEFAULT_WAITING_ROOM_BRANDING.headline),
    message: normalizeText(value.message, MAX_WAITING_ROOM_MESSAGE_LENGTH, DEFAULT_WAITING_ROOM_BRANDING.message),
    backgroundMode: value.backgroundMode === 'studio' ? 'studio' : 'brand',
    showLogo: typeof value.showLogo === 'boolean' ? value.showLogo : DEFAULT_WAITING_ROOM_BRANDING.showLogo,
  };
}

export function getPersistableWaitingRoomLogoUrl(url: string | null): string | null {
  if (!url || url.startsWith('blob:')) return null;
  if (url.length > MAX_WAITING_ROOM_LOGO_URL_LENGTH) return null;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

export function getPersistableWaitingRoomStageBackground(background: StageBackground): StageBackground {
  if ((background.type === 'image' || background.type === 'video') && (
    background.value.startsWith('blob:') ||
    background.value.length > MAX_WAITING_ROOM_BACKGROUND_VALUE_LENGTH
  )) {
    return { type: 'none', value: '' };
  }
  if (background.value.length > MAX_WAITING_ROOM_BACKGROUND_VALUE_LENGTH) {
    return { type: 'none', value: '' };
  }
  return background;
}

export function buildStudioBrandingPayload(input: {
  brandColor: string;
  logoUrl: string | null;
  stageBackground: StageBackground;
  waitingRoom: WaitingRoomBranding;
  updatedBy?: string;
}): StudioBrandingPayload {
  return {
    brandColor: input.brandColor || '#a78bfa',
    logoUrl: getPersistableWaitingRoomLogoUrl(input.logoUrl),
    stageBackground: getPersistableWaitingRoomStageBackground(input.stageBackground),
    waitingRoom: normalizeWaitingRoomBranding(input.waitingRoom),
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  };
}
