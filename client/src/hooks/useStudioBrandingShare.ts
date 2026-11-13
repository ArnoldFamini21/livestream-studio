import { useEffect, useMemo } from 'react';
import type { SignalMessage, StageBackground, StudioBrandingPayload, WaitingRoomBranding } from '@studio/shared';
import {
  getCanvasBackgroundUploadKey,
  needsCanvasBackgroundUpload,
  toSharedStageBackground,
  uploadCanvasBackground,
} from '../utils/canvasBackgroundSync.ts';
import { getLogoUploadKey, needsLogoUpload, toSharedLogo, uploadLogo } from '../utils/logoSync.ts';
import { createPictureUploadCache } from '../utils/pictureUpload.ts';
import { buildStudioBrandingPayload } from '../utils/waitingRoomBranding.ts';
import { useSharedPictureUpload, type PictureShareState } from './useSharedPictureUpload.ts';

export interface StudioBrandingShare {
  logo: { state: PictureShareState; retry: () => void };
  background: { state: PictureShareState; retry: () => void };
}

/**
 * The host shares the studio branding (colour, waiting-room text, logo, canvas
 * background). Pictures are uploaded once to the studio's image store and the
 * branding message names them by id, so it stays far below the signaling size
 * cap. While a picture uploads, the message waits for it (a few seconds at
 * most); if the upload fails after its attempts, the branding goes out without
 * the picture so nothing else is held back.
 */
export function useStudioBrandingShare(options: {
  isHost: boolean;
  roomId: string | undefined;
  participantId: string | undefined;
  admitted: boolean;
  /** Reads the host's current upload token (set when the join completes). */
  getUploadToken: () => string | null;
  /** Changes on every join: uploaded pictures do not survive a server restart. */
  epoch: number;
  brandColor: string;
  logoUrl: string | null;
  stageBackground: StageBackground;
  waitingRoom: WaitingRoomBranding;
  connected: boolean;
  joined: boolean;
  canSend: boolean;
  send: (message: SignalMessage) => void;
}): StudioBrandingShare {
  const { epoch, roomId, participantId, getUploadToken } = options;
  const uploadToken = options.isHost && options.admitted ? getUploadToken() : null;
  const enabled = Boolean(options.isHost && options.admitted && roomId && participantId && uploadToken);
  // A fresh cache per join: ids from before it may name pictures the server lost.
  const cache = useMemo(() => createPictureUploadCache(), [epoch]);

  const logoNeedsUpload = needsLogoUpload(options.logoUrl);
  const logo = useSharedPictureUpload({
    needsUpload: logoNeedsUpload,
    uploadKey: logoNeedsUpload && options.logoUrl ? getLogoUploadKey(options.logoUrl) : null,
    enabled,
    cache,
    upload: () => uploadLogo(options.logoUrl as string, { roomId: roomId as string, participantId: participantId as string, token: getUploadToken() as string }),
  });
  const backgroundNeedsUpload = needsCanvasBackgroundUpload(options.stageBackground);
  const background = useSharedPictureUpload({
    needsUpload: backgroundNeedsUpload,
    uploadKey: backgroundNeedsUpload ? getCanvasBackgroundUploadKey(options.stageBackground) : null,
    enabled,
    cache,
    upload: () => uploadCanvasBackground(options.stageBackground, { roomId: roomId as string, participantId: participantId as string, token: getUploadToken() as string }),
  });

  const holdBack = logo.state === 'sharing' || background.state === 'sharing';
  const { brandColor, logoUrl, stageBackground, waitingRoom } = options;
  const payload = useMemo<StudioBrandingPayload | null>(() => {
    if (holdBack) return null;
    const sharedLogo = toSharedLogo(logoUrl, logo.imageId);
    return buildStudioBrandingPayload({
      brandColor,
      logoUrl: sharedLogo.logoUrl,
      logoImageId: sharedLogo.logoImageId,
      stageBackground: toSharedStageBackground(stageBackground, background.imageId ?? undefined),
      waitingRoom,
      updatedBy: participantId,
    });
  }, [background.imageId, brandColor, holdBack, logo.imageId, logoUrl, participantId, stageBackground, waitingRoom]);

  const { connected, joined, canSend, isHost, send } = options;
  useEffect(() => {
    if (!payload) return;
    if (!connected || !joined || !canSend || !isHost) return;
    const timeout = window.setTimeout(() => {
      send({ type: 'studio-branding-updated', payload });
    }, 350);
    return () => window.clearTimeout(timeout);
  }, [canSend, connected, isHost, joined, payload, send]);

  return {
    logo: { state: logo.state, retry: logo.retry },
    background: { state: background.state, retry: background.retry },
  };
}
