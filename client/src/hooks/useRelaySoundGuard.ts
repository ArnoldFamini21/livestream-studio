import { useCallback, useEffect, useRef, useState } from 'react';
import type { BroadcastAudioBus } from './useBroadcastAudioBus.ts';
import type { RelayMediaRestartEvent, RtmpRelayStats } from './useRtmpRelay.ts';
import {
  RELAY_NOT_SENDING_NOTICE,
  relayJustEnded,
  SOUND_OUTPUT_OFF_NOTICE,
  SOUND_OUTPUT_RESTORED_NOTICE,
  SOUND_OUTPUT_RESTORE_FAILED,
} from '../utils/relayMediaNotices.ts';

type AddToast = (message: string, type?: 'success' | 'error' | 'warning' | 'info', options?: { durationMs?: number }) => void;

/**
 * What the host is told, and what the host can do, when the browser stops
 * producing the broadcast. The relay (useRtmpRelay) finds the problem and
 * restarts the broadcast; the audio bus runs the sound check. This connects
 * them to the studio's toasts and to the "Turn sound back on" marker.
 */
export function useRelaySoundGuard({ bus, addToast }: { bus: BroadcastAudioBus; addToast: AddToast }) {
  const busRef = useRef(bus);
  busRef.current = bus;
  const addToastRef = useRef(addToast);
  addToastRef.current = addToast;
  const [restoring, setRestoring] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);

  const checkProgramAudio = useCallback(() => busRef.current.checkProgramAudio(), []);

  const onMediaRestart = useCallback((event: RelayMediaRestartEvent) => {
    addToastRef.current(RELAY_NOT_SENDING_NOTICE, 'warning');
    if (event.cause === 'sound-output-recovered') {
      addToastRef.current(SOUND_OUTPUT_OFF_NOTICE, 'warning', { durationMs: 20_000 });
    }
  }, []);

  /** The "Turn sound back on" button. */
  const restoreSound = useCallback(async () => {
    setRestoring(true);
    setRestoreFailed(false);
    try {
      const restored = await busRef.current.restoreAudioOutput();
      if (restored) addToastRef.current(SOUND_OUTPUT_RESTORED_NOTICE, 'success');
      else setRestoreFailed(true);
    } finally {
      setRestoring(false);
    }
  }, []);

  // The failure line belongs to the marker; it goes with it.
  useEffect(() => {
    if (!bus.soundOutputOff) setRestoreFailed(false);
  }, [bus.soundOutputOff]);

  return {
    soundOutputOff: bus.soundOutputOff,
    restoring,
    restoreFailedMessage: restoreFailed ? SOUND_OUTPUT_RESTORE_FAILED : null,
    checkProgramAudio,
    onMediaRestart,
    restoreSound,
  };
}

/**
 * When the broadcast ends and the studio's sound output is off, try to turn it
 * back on once, quietly (the host is no longer depending on a stuck clock).
 * If the device still does not answer, the sound stays off and the marker stays.
 */
export function useRestoreSoundWhenRelayEnds(status: RtmpRelayStats['status'], bus: BroadcastAudioBus): void {
  const previousRef = useRef(status);
  const busRef = useRef(bus);
  busRef.current = bus;
  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = status;
    if (!relayJustEnded(previous, status)) return;
    if (!busRef.current.soundOutputOff) return;
    void busRef.current.restoreAudioOutput();
  }, [status]);
}
