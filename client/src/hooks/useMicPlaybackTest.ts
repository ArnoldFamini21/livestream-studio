import { useCallback, useEffect, useRef, useState } from 'react';
import { MIC_TEST_DURATION_MS, pickMicTestMimeType, type MicTestPhase } from '../utils/micPlaybackTest.ts';

/**
 * Record a few seconds from the preview microphone and play it back through
 * the chosen speaker, so a guest hears exactly what the studio will hear.
 */
export function useMicPlaybackTest(
  stream: MediaStream | null,
  applyAudioOutput: (element: HTMLMediaElement) => Promise<void>
) {
  const [phase, setPhase] = useState<MicTestPhase>('idle');
  const [secondsLeft, setSecondsLeft] = useState(Math.round(MIC_TEST_DURATION_MS / 1000));
  const recorderRef = useRef<MediaRecorder | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef('');
  const timersRef = useRef<number[]>([]);

  const clearTimers = () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  };

  const releaseRecording = useCallback(() => {
    clearTimers();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    trackRef.current?.stop();
    trackRef.current = null;
  }, []);

  const releasePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute('src');
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = '';
    }
  }, []);

  useEffect(() => () => {
    releaseRecording();
    releasePlayback();
  }, [releasePlayback, releaseRecording]);

  const audioTrack = stream?.getAudioTracks().find((track) => track.readyState === 'live') || null;
  const supported = typeof MediaRecorder !== 'undefined' && Boolean(audioTrack);

  const start = useCallback(() => {
    if (!audioTrack || typeof MediaRecorder === 'undefined') {
      setPhase('error');
      return;
    }
    releaseRecording();
    releasePlayback();
    // Record a clone so muting or switching the preview mic cannot cut the test short.
    const track = audioTrack.clone();
    track.enabled = true;
    trackRef.current = track;
    const mimeType = pickMicTestMimeType(MediaRecorder.isTypeSupported?.bind(MediaRecorder));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(new MediaStream([track]), mimeType ? { mimeType } : undefined);
    } catch {
      track.stop();
      trackRef.current = null;
      setPhase('error');
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      track.stop();
      trackRef.current = null;
      recorderRef.current = null;
      if (chunks.length === 0) {
        setPhase('error');
        return;
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      urlRef.current = URL.createObjectURL(blob);
      const audio = audioRef.current || new Audio();
      audioRef.current = audio;
      audio.src = urlRef.current;
      audio.onended = () => setPhase('done');
      audio.onerror = () => setPhase('error');
      setPhase('playing');
      void applyAudioOutput(audio)
        .then(() => audio.play())
        .catch(() => setPhase('error'));
    };
    recorderRef.current = recorder;
    recorder.start();
    setPhase('recording');
    const totalSeconds = Math.round(MIC_TEST_DURATION_MS / 1000);
    setSecondsLeft(totalSeconds);
    for (let second = 1; second < totalSeconds; second++) {
      timersRef.current.push(window.setTimeout(() => setSecondsLeft(totalSeconds - second), second * 1000));
    }
    timersRef.current.push(window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, MIC_TEST_DURATION_MS));
  }, [applyAudioOutput, audioTrack, releasePlayback, releaseRecording]);

  const stop = useCallback(() => {
    releaseRecording();
    releasePlayback();
    setPhase('idle');
  }, [releasePlayback, releaseRecording]);

  return { phase, secondsLeft, supported, start, stop };
}
