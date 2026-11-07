import { useEffect, useRef, useState } from 'react';

/**
 * Keep showing the last value for `exitMs` after it becomes null, so a panel
 * can play its closing animation before it unmounts.
 */
export function useExitTransition<T>(value: T | null | undefined, exitMs = 180): { shown: T | null; exiting: boolean } {
  const [lingering, setLingering] = useState<T | null>(null);
  const previousRef = useRef<T | null>(value ?? null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = value ?? null;
    if (value != null || previous == null) {
      setLingering(null);
      return;
    }
    const reduceMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;
    setLingering(previous);
    const timer = window.setTimeout(() => setLingering(null), exitMs);
    return () => window.clearTimeout(timer);
  }, [value, exitMs]);

  if (value != null) return { shown: value, exiting: false };
  return { shown: lingering, exiting: lingering != null };
}
