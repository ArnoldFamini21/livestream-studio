import { useState, useCallback, useRef, useEffect } from 'react';
import { createScreenCaptureSession } from '../utils/screenCapture.ts';

export function useScreenShare() {
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const sessionRef = useRef<ReturnType<typeof createScreenCaptureSession> | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = createScreenCaptureSession(() => navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
      audio: true,
    }));
  }

  const stopScreenShare = useCallback(() => {
    sessionRef.current?.stop();
    setScreenStream(null);
    setIsScreenSharing(false);
  }, []);

  const startScreenShare = useCallback(async () => {
    try {
      const stream = await sessionRef.current!.start();
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
