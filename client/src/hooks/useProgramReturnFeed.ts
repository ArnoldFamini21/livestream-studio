import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ProgramAudioTrackLease } from '../audio/useProgramAudioMix.ts';
import { createFrameTicker } from '../utils/frameTicker.ts';
import {
  PROGRAM_RETURN_FPS,
  PROGRAM_RETURN_HEIGHT,
  PROGRAM_RETURN_WIDTH,
  type ProgramReturnSource,
} from '../utils/programReturn.ts';

interface UseProgramReturnFeedOptions {
  /** Someone needs the picture (see getProgramReturnDemand). */
  enabled: boolean;
  /** Someone needs the program audio too (backstage guests). */
  audioWanted: boolean;
  /** The broadcast compositor's 1920x1080 canvas. */
  compositeCanvasRef: MutableRefObject<HTMLCanvasElement | null>;
  /** A lease on the program audio mix for return receivers. */
  acquireAudio: () => ProgramAudioTrackLease | null;
}

/**
 * The stage owner's program return: the compositor canvas scaled to 640x360
 * at 15 fps on the worker frame ticker (requestAnimationFrame stops in a
 * hidden tab), plus a lease on the program audio while backstage guests need
 * it. The MediaStream that names the feed is created once, so its id (the one
 * receivers were told) never changes. Nothing is built while nobody needs it.
 */
export function useProgramReturnFeed({
  enabled,
  audioWanted,
  compositeCanvasRef,
  acquireAudio,
}: UseProgramReturnFeedOptions): ProgramReturnSource | null {
  const streamRef = useRef<MediaStream | null>(null);
  const [video, setVideo] = useState<MediaStreamTrack | null>(null);
  const [audio, setAudio] = useState<MediaStreamTrack | null>(null);
  const acquireAudioRef = useRef(acquireAudio);
  acquireAudioRef.current = acquireAudio;

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = PROGRAM_RETURN_WIDTH;
    canvas.height = PROGRAM_RETURN_HEIGHT;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context || typeof canvas.captureStream !== 'function') return;
    context.fillStyle = '#000';
    context.fillRect(0, 0, PROGRAM_RETURN_WIDTH, PROGRAM_RETURN_HEIGHT);
    let track: MediaStreamTrack | undefined;
    try {
      track = canvas.captureStream(PROGRAM_RETURN_FPS).getVideoTracks()[0];
    } catch (error) {
      console.warn('The program return could not start; backstage guests will not see the show:', error);
      return;
    }
    if (!track) return;
    try { track.contentHint = 'motion'; } catch { /* Optional encoder hint. */ }
    const ticker = createFrameTicker(PROGRAM_RETURN_FPS, () => {
      const source = compositeCanvasRef.current;
      if (!source || source.width === 0 || source.height === 0) return;
      context.drawImage(source, 0, 0, PROGRAM_RETURN_WIDTH, PROGRAM_RETURN_HEIGHT);
    });
    setVideo(track);
    return () => {
      ticker.stop();
      track?.stop();
      setVideo(null);
    };
  }, [compositeCanvasRef, enabled]);

  useEffect(() => {
    if (!enabled || !audioWanted) return;
    const lease = acquireAudioRef.current();
    if (!lease) return;
    setAudio(lease.track);
    return () => {
      lease.release();
      setAudio(null);
    };
  }, [audioWanted, enabled]);

  return useMemo(() => {
    if (!video) return null;
    if (!streamRef.current) streamRef.current = new MediaStream();
    return { stream: streamRef.current, video, audio };
  }, [audio, video]);
}
