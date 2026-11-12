import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { loadStageImageObjectUrl } from '../utils/stageMirror.ts';

const LOAD_ATTEMPTS = 3;
const FIRST_PAUSE_MS = 1_000;

/**
 * Loads a picture the studio shares by id (the logo, the canvas background)
 * into an object URL with this participant's read token. The previous picture
 * stays in place until the next one has loaded, and stays if the next one
 * cannot be loaded, so nothing flashes or disappears from the program.
 * `epoch` changes on every join, which brings a fresh token.
 */
export function useLoadedSharedImage(
  imageUrl: string | null,
  readTokenRef: MutableRefObject<string | null>,
  epoch: number,
): string | null {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const currentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!imageUrl) return;
    let cancelled = false;
    let timer: number | undefined;
    const attempt = (number: number) => {
      void loadStageImageObjectUrl(imageUrl, readTokenRef.current).then((objectUrl) => {
        if (cancelled) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }
        if (!objectUrl) {
          if (number < LOAD_ATTEMPTS) timer = window.setTimeout(() => attempt(number + 1), FIRST_PAUSE_MS * 2 ** (number - 1));
          return;
        }
        const previous = currentRef.current;
        currentRef.current = objectUrl;
        setLoadedUrl(objectUrl);
        if (previous && previous !== objectUrl) URL.revokeObjectURL(previous);
      });
    };
    attempt(1);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [imageUrl, epoch, readTokenRef]);

  useEffect(() => () => {
    if (currentRef.current) URL.revokeObjectURL(currentRef.current);
  }, []);

  return loadedUrl;
}
