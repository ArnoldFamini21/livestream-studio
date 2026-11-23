import { useEffect, useRef, type CSSProperties } from 'react';
import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import { connectMediaElementAudio } from '../utils/mediaElementAudio.ts';

const clipStyle: CSSProperties = {
  position: 'absolute', inset: 0, width: '100%', height: '100%',
  background: '#000', objectFit: 'contain',
};

export function BroadcastScreenVideo({
  url, bus, onEnded, onFailure,
}: {
  url: string;
  bus: BroadcastAudioBus;
  onEnded: () => void;
  onFailure: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const events = useRef({ onEnded, onFailure });
  events.current = { onEnded, onFailure };
  const { getContext, connectNode } = bus;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let failedOnce = false;
    let disconnect: (() => void) | undefined;
    const failed = () => {
      if (cancelled || failedOnce) return;
      failedOnce = true;
      video.style.visibility = 'hidden';
      events.current.onFailure();
    };
    video.addEventListener('error', failed);
    try {
      const audio = connectMediaElementAudio(video, { getContext, connectNode }, { duck: false });
      disconnect = audio.disconnect;
      void audio.resume().then(() => {
        if (!cancelled && !failedOnce) return video.play();
      }).catch(failed);
    } catch {
      failed();
    }
    return () => {
      cancelled = true;
      video.removeEventListener('error', failed);
      video.pause();
      disconnect?.();
    };
  }, [connectNode, getContext, url]);

  return <video ref={videoRef} src={url} playsInline preload="auto" data-broadcast-screen-video
    style={clipStyle} onEnded={() => events.current.onEnded()} aria-label="Broadcast screen clip" />;
}
