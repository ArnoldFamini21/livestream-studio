import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import { BackgroundMusicPlayer, type BackgroundMusicState } from './backgroundMusicPlayer.ts';

/** Mounts the studio's background music player (it outlives the music panel). */
export function useBackgroundMusicPlayer(bus: BroadcastAudioBus): BackgroundMusicPlayer {
  const busRef = useRef(bus);
  busRef.current = bus;
  const playerRef = useRef<BackgroundMusicPlayer | null>(null);
  if (!playerRef.current) {
    playerRef.current = new BackgroundMusicPlayer({ getBus: () => busRef.current });
  }
  const player = playerRef.current;
  useEffect(() => () => player.dispose(), [player]);
  return player;
}

export function useBackgroundMusicState(player: BackgroundMusicPlayer): BackgroundMusicState {
  return useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
}
