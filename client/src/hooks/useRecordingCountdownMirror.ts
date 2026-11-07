import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeRecordingCountdownSeconds } from '../utils/recordingCountdown.ts';

/**
 * Guests see the host's 3-2-1 before recording starts. The host sends one
 * message when the countdown begins (and one if it is cancelled); each guest
 * ticks it down locally, so there is no message per second.
 */
export function useRecordingCountdownMirror() {
  const [value, setValue] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setValue(null);
  }, []);

  const start = useCallback((rawSeconds: unknown) => {
    const seconds = normalizeRecordingCountdownSeconds(rawSeconds);
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    if (seconds === null) {
      setValue(null);
      return;
    }
    let remaining = seconds;
    setValue(remaining);
    timerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        setValue(null);
      } else {
        setValue(remaining);
      }
    }, 1000);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
  }, []);

  return { value, start, stop };
}
