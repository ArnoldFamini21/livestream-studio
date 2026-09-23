import { useEffect, useState, type RefObject } from 'react';
import { getIntrinsicAspect, shouldUpdateContentAspect } from '../utils/contentAspect.ts';

const MEDIA_SELECTOR = '.studio-active-media';

/**
 * Track the shape of whatever is shared on stage (slide image, image, video,
 * or screen) so the layout can frame it exactly. Re-measures when the media
 * element changes, when an image finishes loading, and when a shared screen's
 * resolution changes.
 */
export function useSharedContentAspect(stageRef: RefObject<HTMLElement | null>, contentKey: string | null): number | null {
  const [aspect, setAspect] = useState<number | null>(null);

  useEffect(() => {
    setAspect(null);
    if (!contentKey) return undefined;
    const stage = stageRef.current;
    const container = stage?.querySelector(MEDIA_SELECTOR);
    if (!container) return undefined;

    let bound: Element | null = null;
    const measure = () => {
      const next = getIntrinsicAspect(bound);
      setAspect((current) => (shouldUpdateContentAspect(current, next) ? next : current));
    };
    const events = ['load', 'loadedmetadata', 'resize'];
    const bind = () => {
      const element = container.querySelector('img, video');
      if (element === bound) return;
      if (bound) events.forEach((name) => bound?.removeEventListener(name, measure));
      bound = element;
      if (!bound) return;
      events.forEach((name) => bound?.addEventListener(name, measure));
      measure();
    };

    bind();
    const observer = new MutationObserver(bind);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (bound) events.forEach((name) => bound?.removeEventListener(name, measure));
    };
  }, [contentKey, stageRef]);

  return aspect;
}
