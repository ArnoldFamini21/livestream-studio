import type {
  BrandKitCatalogEntry,
  BrandKitCatalogListResponse,
  BrandKitCatalogUpsertRequest,
} from '@studio/shared';
import type { SavedBrandKit } from './brandKits.ts';
import { ApiRequestError, buildApiUrl, getJson, postJson } from './apiClient.ts';

export interface SyncBrandKitCatalogInput {
  roomId: string;
  hostToken: string;
  brandKit: SavedBrandKit;
}

function catalogHeaders(hostToken: string): Headers {
  const headers = new Headers();
  headers.set('x-host-token', hostToken);
  return headers;
}

export function buildBrandKitCatalogUpsertRequest(
  brandKit: SavedBrandKit
): BrandKitCatalogUpsertRequest {
  return {
    id: brandKit.id,
    name: brandKit.name,
    createdAt: brandKit.createdAt,
    studioTheme: brandKit.studioTheme,
    brandColor: brandKit.brandColor,
    stageBackground: brandKit.stageBackground,
    logoUrl: brandKit.logoUrl,
    logoPlacement: brandKit.logoPlacement,
    logoPosition: brandKit.logoPosition,
    logoSize: brandKit.logoSize,
    logoOpacity: brandKit.logoOpacity,
    cameraShape: brandKit.cameraShape,
    nameTagStyle: brandKit.nameTagStyle,
  };
}

export function catalogEntryToSavedBrandKit(entry: BrandKitCatalogEntry): SavedBrandKit {
  return {
    id: entry.id,
    name: entry.name,
    createdAt: entry.createdAt,
    studioTheme: entry.studioTheme,
    brandColor: entry.brandColor,
    stageBackground: entry.stageBackground,
    logoUrl: entry.logoUrl,
    logoPlacement: entry.logoPlacement,
    logoPosition: entry.logoPosition,
    logoSize: entry.logoSize,
    logoOpacity: entry.logoOpacity,
    cameraShape: entry.cameraShape,
    nameTagStyle: entry.nameTagStyle,
  };
}

export function fetchBrandKitCatalog(
  roomId: string,
  hostToken: string
): Promise<BrandKitCatalogListResponse> {
  return getJson<BrandKitCatalogListResponse>(
    `/api/brand-kits/rooms/${encodeURIComponent(roomId)}/catalog`,
    { headers: catalogHeaders(hostToken) }
  );
}

export function syncBrandKitCatalogEntry({
  roomId,
  hostToken,
  brandKit,
}: SyncBrandKitCatalogInput): Promise<BrandKitCatalogEntry> {
  return postJson<BrandKitCatalogEntry>(
    `/api/brand-kits/rooms/${encodeURIComponent(roomId)}/catalog`,
    buildBrandKitCatalogUpsertRequest(brandKit),
    { headers: catalogHeaders(hostToken) }
  );
}

export async function deleteBrandKitCatalogEntry(
  roomId: string,
  hostToken: string,
  brandKitId: string
): Promise<void> {
  const response = await fetch(buildApiUrl(
    `/api/brand-kits/rooms/${encodeURIComponent(roomId)}/catalog/${encodeURIComponent(brandKitId)}`
  ), {
    method: 'DELETE',
    headers: catalogHeaders(hostToken),
  });

  if (!response.ok) {
    throw new ApiRequestError(
      `Studio server returned ${response.status}. Please try again.`,
      { status: response.status, responseText: await response.text().catch(() => '') }
    );
  }
}
