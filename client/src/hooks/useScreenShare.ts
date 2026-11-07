import { useState, useCallback, useRef, useEffect } from 'react';
import { createScreenCaptureSession } from '../utils/screenCapture.ts';

/**
 * Ask for the tab's or the system's sound as well, so guests and the
 * broadcast hear a shared video. The extra hints (not yet in TypeScript's DOM
 * types) offer system audio, hide the studio tab itself from the picker, and
 * let the presenter switch tabs mid-share.
 */
export const SCREEN_SHARE_CAPTURE_OPTIONS = {
  video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  audio: { suppressLocalAudioPlayback: false },
  systemAudio: 'include',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
} as DisplayMediaStreamOptions;

export type ScreenShareContentHint = 'detail' | 'motion';

export function useScreenShare() {
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const sessionRef = useRef<ReturnType<typeof createScreenCaptureSession> | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = createScreenCaptureSession(() => navigator.mediaDevices.getDisplayMedia(SCREEN_SHARE_CAPTURE_OPTIONS));
  }

  const stopScreenShare = useCallback(() => {
    sessionRef.current?.stop();
    setScreenStream(null);
    setIsScreenSharing(false);
  }, []);

  const startScreenShare = useCallback(async (contentHint: ScreenShareContentHint = 'detail') => {
    try {
      const stream = await sessionRef.current!.start(contentHint);
      if (!stream) return null;

      // NOTE: The browser's native "Stop sharing" ended event is handled in
      // StudioRoom.tsx where it can also notify peers via signaling. Do not
      // add a duplicate ended listener here to avoid race conditions.

      setScreenStream(stream);
      setIsScreenSharing(true);

      return stream;
    } catch (err) {
      // User cancelled the screen share dialog (or browser denied permission).
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        // Nothing to report: the user chose not to share.
      } else {
        console.error('Screen share error:', err);
      }
      return null;
    }
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
    };
  }, []);

  return {
    screenStream,
    isScreenSharing,
    startScreenShare,
    stopScreenShare,
  };
}
