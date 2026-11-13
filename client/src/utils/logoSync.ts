/**
 * Shares the studio logo with everyone: the host uploads it once to the studio
 * image store (kind `logo`) and studio branding only names it by id, so no
 * picture ever rides the 64 KiB signaling socket. Everyone, the green room
 * included, loads it with their branding read token. An https:// address is
 * sent as it is.
 */
import type { StudioBrandingPayload } from '@studio/shared';
import { prepareLogoImage } from './logoImage.ts';
import { getStageImageUrl, getStageMirrorSourceKey, postStageImage, type StageImageUploadAuth } from './stageMirror.ts';
import { runWithRetry, type RetryOptions } from './pictureUpload.ts';

/** A logo only this browser can read (an inline data URL or an object URL) must be uploaded first. */
export function needsLogoUpload(logoUrl: string | null | undefined): logoUrl is string {
  return Boolean(logoUrl) && /^(data|blob):/i.test(logoUrl as string);
}

export function getLogoUploadKey(logoUrl: string): string {
  return getStageMirrorSourceKey('studio-logo', logoUrl);
}

/** The logo fields studio branding carries: its uploaded id, or an https address, never picture bytes. */
export function toSharedLogo(logoUrl: string | null, imageId?: string | null): { logoUrl: string | null; logoImageId?: string } {
  if (!logoUrl) return { logoUrl: null };
  if (needsLogoUpload(logoUrl)) return imageId ? { logoUrl: null, logoImageId: imageId } : { logoUrl: null };
  return { logoUrl };
}

/** Where to load a shared logo picture, or null when the logo is not an uploaded one. */
export function getSharedLogoImageUrl(branding: Pick<StudioBrandingPayload, 'logoImageId'> | null | undefined, roomId: string): string | null {
  return branding?.logoImageId ? getStageImageUrl(roomId, branding.logoImageId) : null;
}

/**
 * The logo a participant paints for the host's branding. An uploaded logo is
 * the object URL it was loaded into (the previous one stays until the next has
 * loaded); an https address is used directly; a stray inline one is ignored.
 */
export function resolveSharedLogo(branding: StudioBrandingPayload | null | undefined, loadedImageUrl: string | null): string | null {
  if (!branding) return null;
  if (branding.logoImageId) return loadedImageUrl;
  const url = branding.logoUrl;
  return url && /^(https?:|data:image\/)/i.test(url) ? url : null;
}

/** The picture as uploaded: scaled to the logo limits unless it already fits. */
export async function prepareLogoUpload(source: string, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  const blob = await (await fetchImpl(source)).blob();
  return prepareLogoImage(blob);
}

export async function uploadLogo(
  logoUrl: string,
  auth: StageImageUploadAuth,
  options: { fetchImpl?: typeof fetch; retry?: RetryOptions; prepare?: (source: string) => Promise<Blob> } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Prepared once; only the network part is retried.
  const body = await (options.prepare ?? ((source) => prepareLogoUpload(source, fetchImpl)))(logoUrl);
  return runWithRetry((signal) => postStageImage(body, auth, fetchImpl, { kind: 'logo', signal }), options.retry);
}
