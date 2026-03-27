import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Hook to measure the audio level (RMS) of a given MediaStream in real-time.
 * Returns a value between 0 and 1.
 */
export function useAudioMeter(stream: MediaStream | null, enabled: boolean = true) {
  const [audioLevel, setAudioLevel] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);

  const updateAudioLevel = useCallback(() => {
    if (analyserRef.current) {
      const data = new Uint8Array(analyserRef.current.fftSize);
      analyserRef.current.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const val = (data[i] - 128) / 128; // convert 0-255 to -1.0 to 1.0
        sum += val * val;
      }
      const rms = Math.sqrt(sum / data.length);
      // Amplify visually and cap at 1
      setAudioLevel(Math.min(1, rms * 4));
    }
    animFrameRef.current = requestAnimationFrame(updateAudioLevel);
  }, []);

  useEffect(() => {
    if (stream && enabled && stream.getAudioTracks().length > 0) {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextClass) return;
        
        const ctx = new AudioContextClass();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        
        audioContextRef.current = ctx;
        analyserRef.current = analyser;
        
        animFrameRef.current = requestAnimationFrame(updateAudioLevel);
      } catch (err) {
        console.warn('Failed to initialize AudioContext for meter:', err);
      }
    } else {
      setAudioLevel(0);
      cancelAnimationFrame(animFrameRef.current);
    }

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      audioContextRef.current = null;
      analyserRef.current = null;
    };
  }, [stream, enabled, updateAudioLevel]);

  return audioLevel;
}
