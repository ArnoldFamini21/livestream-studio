import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import { resolveSoundPadHotkey } from '../utils/soundBoard.ts';
import { createSoundBoardLibrary } from '../utils/soundBoardLibrary.ts';
import { SoundBoardPlayer, type SoundBoardState } from './soundBoardPlayer.ts';

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Mounts the studio's sound board engine. Pads keep sounding after the panel
 * closes, and operators can fire the first ten with Shift+1 ... Shift+0
 * (ignored while typing in a field).
 */
export function useSoundBoardPlayer(
  bus: BroadcastAudioBus,
  { hotkeysEnabled }: { hotkeysEnabled: boolean }
): SoundBoardPlayer {
  const busRef = useRef(bus);
  busRef.current = bus;
  const playerRef = useRef<SoundBoardPlayer | null>(null);
  if (!playerRef.current) {
    playerRef.current = new SoundBoardPlayer({
      getBus: () => busRef.current,
      library: createSoundBoardLibrary(),
      storage: getLocalStorage(),
    });
  }
  const player = playerRef.current;

  useEffect(() => () => player.dispose(), [player]);

  useEffect(() => {
    if (!hotkeysEnabled) return;
    void player.loadLibrary();
    const onKeyDown = (event: KeyboardEvent) => {
      const index = resolveSoundPadHotkey({
        code: event.code,
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        repeat: event.repeat,
        target: event.target as HTMLElement | null,
      });
      if (index === null) return;
      if (player.playPadAt(index)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkeysEnabled, player]);

  return player;
}

export function useSoundBoardState(player: SoundBoardPlayer): SoundBoardState {
  return useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
}
