import { useCallback, useEffect, useState } from 'react';
import { percentToGain } from './mixControls.ts';
import { readScreenVolume, writeScreenVolume } from './screenVolumeStore.ts';

/**
 * The host's screen-share volume (0..1, default 1), kept for the browser
 * session and restored after a reload. One value covers every share on the
 * program; the program mix and the host's monitor both read it.
 */
export function useScreenShareVolume(roomId: string | undefined): [number, (percent: number) => void] {
  const [volume, setVolume] = useState(() => readScreenVolume(roomId));

  useEffect(() => {
    setVolume(readScreenVolume(roomId));
  }, [roomId]);

  const setPercent = useCallback((percent: number) => {
    const gain = percentToGain(percent);
    setVolume(gain);
    writeScreenVolume(roomId, gain);
  }, [roomId]);

  return [volume, setPercent];
}
