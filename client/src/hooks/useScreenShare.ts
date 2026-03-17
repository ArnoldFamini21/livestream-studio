import { useState, useCallback, useRef, useEffect } from 'react';

export function useScreenShare() {
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);

  const stopScreenShare = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setScreenStream(null);
      setIsScreenSharing(false);
    }
  }, []);

  const startScreenShare = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      // Handle the browser's native "Stop sharing" button — when the user
      // clicks it the video track fires an "ended" event.
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          stopScreenShare();
        });
      });

      streamRef.current = stream;
      setScreenStream(stream);
      setIsScreenSharing(true);

      return stream;
    } catch (err) {
      // User cancelled the screen share dialog (or browser denied permission).
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        console.log('Screen share cancelled by user');
      } else {
        console.error('Screen share error:', err);
      }
      return null;
    }
  }, [stopScreenShare]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopScreenShare();
    };
  }, [stopScreenShare]);

  return {
    screenStream,
    isScreenSharing,
    startScreenShare,
    stopScreenShare,
  };
}
