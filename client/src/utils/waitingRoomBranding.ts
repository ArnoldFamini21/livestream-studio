import { MAX_INLINE_BRANDING_DATA_URL_LENGTH, type StageBackground, type StudioBrandingPayload, type WaitingRoomBranding } from '@studio/shared';

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

/**
 * Local persistence (saved studio state, scenes) may keep a whole data-URL logo.
 * Studio branding does not: see getSharableLogoUrl.
 */
export function getPersistableWaitingRoomLogoUrl(url: string | null): string | null {
  if (!url || url.startsWith('blob:')) return null;
  if (url.length > MAX_WAITING_ROOM_LOGO_URL_LENGTH) return null;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return null;
}

/**
 * The only logo address that may ride the signaling socket: an https address,
 * or a tiny inline picture. Anything larger goes through the image store and is
 * named by `logoImageId`, never sent inline.
 */
export function getSharableLogoUrl(url: string | null): string | null {
  if (!url || url.startsWith('blob:')) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(url) && url.length <= MAX_INLINE_BRANDING_DATA_URL_LENGTH) return url;
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

/** A background as branding sends it: never an inline picture above the small cap (uploaded ones are named by `imageId`). */
export function getSharableStageBackground(background: StageBackground): StageBackground {
  const persistable = getPersistableWaitingRoomStageBackground(background);
  if (/^data:/i.test(persistable.value) && persistable.value.length > MAX_INLINE_BRANDING_DATA_URL_LENGTH) {
    return { type: 'none', value: '' };
  }
  return persistable;
}

export function buildStudioBrandingPayload(input: {
  brandColor: string;
  logoUrl: string | null;
  /** A logo already uploaded to the image store; it replaces `logoUrl`. */
  logoImageId?: string | null;
  stageBackground: StageBackground;
  waitingRoom: WaitingRoomBranding;
  updatedBy?: string;
}): StudioBrandingPayload {
  return {
    brandColor: input.brandColor || '#a78bfa',
    ...(input.logoImageId ? { logoUrl: null, logoImageId: input.logoImageId } : { logoUrl: getSharableLogoUrl(input.logoUrl) }),
    stageBackground: getSharableStageBackground(input.stageBackground),
    waitingRoom: normalizeWaitingRoomBranding(input.waitingRoom),
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  };
}
