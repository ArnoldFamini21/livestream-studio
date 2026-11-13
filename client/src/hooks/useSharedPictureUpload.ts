import { useCallback, useEffect, useRef, useState } from 'react';
import type { PictureUploadCache } from '../utils/pictureUpload.ts';

export type PictureShareState = 'none' | 'sharing' | 'shared' | 'failed';

export interface SharedPictureUpload {
  state: PictureShareState;
  /** The id guests load the picture by; set once `state` is `shared`. */
  imageId: string | null;
  /** Try again after `failed`. */
  retry: () => void;
}

interface Outcome {
  cache: PictureUploadCache;
  key: string;
  nonce: number;
  state: 'shared' | 'failed';
  imageId: string | null;
}

/**
 * Uploads a picture only this browser can read (a logo, a canvas background)
 * to the studio's image store, once per picture and join, and reports where it
 * stands: `sharing` while it uploads (the caller holds the picture back, not
 * the rest of the branding for good), `shared` with its id, or `failed` after
 * the attempts ran out (the caller sends the branding without the picture and
 * offers a retry).
 */
export function useSharedPictureUpload(options: {
  /** True for a data: or blob: picture; false (or no picture) means there is nothing to upload. */
  needsUpload: boolean;
  /** Cheap key of the picture; null when there is none. */
  uploadKey: string | null;
  /** The participant may upload right now (host, admitted, upload token in hand). */
  enabled: boolean;
  cache: PictureUploadCache;
  /** Uploads the picture (with its own time limit and retries) and resolves to its id. */
  upload: () => Promise<string>;
}): SharedPictureUpload {
  const { needsUpload, uploadKey, enabled, cache } = options;
  const uploadRef = useRef(options.upload);
  uploadRef.current = options.upload;
  const [nonce, setNonce] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!needsUpload || !enabled || !uploadKey) return;
    if (cache.get(uploadKey)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      cache.upload(uploadKey, () => uploadRef.current()).then((imageId) => {
        if (!cancelled) setOutcome({ cache, key: uploadKey, nonce, state: 'shared', imageId });
      }, (error: unknown) => {
        console.warn('The picture could not be shared; the studio carries on without it:', error);
        if (!cancelled) setOutcome({ cache, key: uploadKey, nonce, state: 'failed', imageId: null });
      });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cache, enabled, needsUpload, nonce, uploadKey]);

  const retry = useCallback(() => {
    setOutcome(null);
    setNonce((current) => current + 1);
  }, []);

  if (!needsUpload || !enabled || !uploadKey) return { state: 'none', imageId: null, retry };
  const cached = cache.get(uploadKey);
  if (cached) return { state: 'shared', imageId: cached, retry };
  if (outcome && outcome.cache === cache && outcome.key === uploadKey && outcome.nonce === nonce) {
    return { state: outcome.state, imageId: outcome.imageId, retry };
  }
  return { state: 'sharing', imageId: null, retry };
}
