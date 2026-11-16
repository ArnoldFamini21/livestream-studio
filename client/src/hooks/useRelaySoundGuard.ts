import { useCallback, useEffect, useRef, useState } from 'react';
import type { BroadcastAudioBus } from './useBroadcastAudioBus.ts';
import type { RelayMediaStallEvent, RtmpRelayStats } from './useRtmpRelay.ts';
import {
  relayNotSendingNotice,
  shouldRestoreSoundQuietly,
  soundOutputOffNotice,
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

  const onMediaStall = useCallback((event: RelayMediaStallEvent) => {
    if (event.action === 'end') {
      // The final stop path shows the host no reason; this does, until dismissed.
      addToastRef.current(event.message, 'error');
      return;
    }
    addToastRef.current(relayNotSendingNotice(event.test), 'warning');
    if (event.cause === 'sound-output-recovered') {
      addToastRef.current(soundOutputOffNotice(event.test), 'warning', { durationMs: 20_000 });
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
    onMediaStall,
    restoreSound,
  };
}

/**
 * Whenever the studio's sound output is off and no broadcast runs (the
 * broadcast just ended, or the output went off during a check that finished
 * after the host pressed Stop), try to turn it back on once, quietly: the host
 * no longer depends on a stuck clock. If the device still does not answer, the
 * sound stays off and the marker stays. One try for each stretch with the
 * output off and no broadcast.
 */
export function useRestoreSoundWhenRelayEnds(
  status: RtmpRelayStats['status'],
  studioLive: boolean,
  bus: BroadcastAudioBus
): void {
  const triedRef = useRef(false);
  const busRef = useRef(bus);
  busRef.current = bus;
  const due = shouldRestoreSoundQuietly({ relayStatus: status, studioLive, soundOutputOff: bus.soundOutputOff });
  useEffect(() => {
    if (!due) {
      triedRef.current = false;
      return;
    }
    if (triedRef.current) return;
    triedRef.current = true;
    void busRef.current.restoreAudioOutput();
  }, [due]);
}
