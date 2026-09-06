import { useEffect, useRef, type CSSProperties } from 'react';
import type { BroadcastAudioBus } from '../hooks/useBroadcastAudioBus.ts';
import { connectMediaElementAudio } from '../utils/mediaElementAudio.ts';

interface StudioMediaVideoProps {
  url: string;
  name: string;
  style?: CSSProperties;
  broadcastAudio: BroadcastAudioBus;
  onError: (message: string) => void;
}

export function StudioMediaVideo({ url, name, style, broadcastAudio, onError }: StudioMediaVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRouteRef = useRef<ReturnType<typeof connectMediaElementAudio> | null>(null);
  const errorReportedRef = useRef(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reportError = (message: string) => {
    if (errorReportedRef.current) return;
    errorReportedRef.current = true;
    videoRef.current?.pause();
    onErrorRef.current(message);
  };

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (!audioRouteRef.current) return;
      video?.pause();
      audioRouteRef.current.disconnect();
      audioRouteRef.current = null;
    };
  }, []);

  const connectAudio = () => {
    const video = videoRef.current;
    if (!video || errorReportedRef.current) return;
    try {
      audioRouteRef.current ??= connectMediaElementAudio(video, broadcastAudio);
      void audioRouteRef.current.resume().catch(() => {
        reportError('Video audio could not start. Add the clip again to retry.');
      });
    } catch {
      reportError('Video audio could not be added to the broadcast. Add the clip again to retry.');
    }
  };

  return (
    <video
      ref={videoRef}
      crossOrigin="anonymous"
      src={url}
      aria-label={name}
      style={style}
      autoPlay
      playsInline
      controls
      onPlay={connectAudio}
      onError={() => reportError('This video could not play. Upload a supported video file or use a direct link that allows sharing.')}
    />
  );
}
