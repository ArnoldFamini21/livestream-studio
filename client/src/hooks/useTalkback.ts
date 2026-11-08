import { useCallback, useEffect, useRef, useState } from 'react';
import { getTalkbackKeyAction, type TalkbackKeyEvent } from '../utils/talkback.ts';

export interface TalkbackState {
  /** The host's mic is off the program right now. */
  active: boolean;
  /** Latched on with the button or Shift + K. */
  latched: boolean;
  /** K is being held. */
  holding: boolean;
  toggle: () => void;
}

/**
 * Talk backstage for hosts and co-hosts: hold K (push-to-talk) or latch it
 * with the control bar button / Shift + K. Losing focus releases the hold.
 */
export function useTalkback(enabled: boolean): TalkbackState {
  const [latched, setLatched] = useState(false);
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);

  const setHold = useCallback((value: boolean) => {
    holdingRef.current = value;
    setHolding(value);
  }, []);

  useEffect(() => {
    if (enabled) return;
    setLatched(false);
    setHold(false);
  }, [enabled, setHold]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented && event.type === 'keydown') return;
      const action = getTalkbackKeyAction(event as unknown as TalkbackKeyEvent, holdingRef.current);
      if (action === 'hold-start') {
        event.preventDefault();
        setHold(true);
      } else if (action === 'hold-end') {
        setHold(false);
      }
    };
    const release = () => {
      if (holdingRef.current) setHold(false);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, setHold]);

  const toggle = useCallback(() => setLatched((current) => !current), []);

  return { active: enabled && (latched || holding), latched, holding, toggle };
}
