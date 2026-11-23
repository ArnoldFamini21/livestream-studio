import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import { connectMediaElementAudio } from '../utils/mediaElementAudio.ts';

const clipStyle: CSSProperties = {
  position: 'absolute', inset: 0, width: '100%', height: '100%',
  background: '#000', objectFit: 'contain', visibility: 'hidden',
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

  // Tear down the audio route during the commit that reveals the stage again.
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let failedOnce = false;
    let audio: ReturnType<typeof connectMediaElementAudio> | undefined;

    const hide = () => {
      video.removeAttribute('data-broadcast-screen-video');
      video.style.visibility = 'hidden';
      audio?.disconnect();
    };
    const failed = () => {
      if (cancelled || failedOnce) return;
      failedOnce = true;
      hide();
      video.pause();
      events.current.onFailure();
    };
    const playing = () => {
      // HAVE_CURRENT_DATA is the first ready state with a drawable video frame.
      if (cancelled || failedOnce || video.paused || video.ended || video.readyState < video.HAVE_CURRENT_DATA || !video.videoWidth) return;
      try {
        audio?.connect();
        video.style.visibility = 'visible';
        video.setAttribute('data-broadcast-screen-video', '');
      } catch {
        failed();
      }
    };
    video.addEventListener('playing', playing);
    video.addEventListener('waiting', hide);
    video.addEventListener('pause', hide);
    video.addEventListener('ended', hide);
    video.addEventListener('error', failed);
    try {
      audio = connectMediaElementAudio(video, { getContext, connectNode }, { duck: false, startConnected: false });
      void audio.resume().then(() => {
        if (!cancelled && !failedOnce) return video.play();
      }).catch(failed);
    } catch {
      failed();
    }
    return () => {
      cancelled = true;
      video.removeEventListener('playing', playing);
      video.removeEventListener('waiting', hide);
      video.removeEventListener('pause', hide);
      video.removeEventListener('ended', hide);
      video.removeEventListener('error', failed);
      hide();
      video.pause();
    };
  }, [connectNode, getContext, url]);

  return <video ref={videoRef} src={url} playsInline preload="auto"
    style={clipStyle} onEnded={() => events.current.onEnded()} aria-label="Broadcast screen clip" />;
}
