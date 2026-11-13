import { amplitudeToDb } from './audioPeakWindow.ts';

export interface AudioPeakProbe {
  stop: () => void;
}

const PROBE_INTERVAL_MS = 200;

/**
 * Watches the loudness of an audio track (the program mix going to the media
 * server) without changing it. Reports the peak level of each short slice in
 * dBFS; the track is only listened to, never played.
 */
export function startAudioPeakProbe(track: MediaStreamTrack, onReading: (db: number) => void): AudioPeakProbe | null {
  const AudioContextClass = window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  let context: AudioContext;
  try {
    context = new AudioContextClass();
  } catch {
    return null;
  }
  void context.resume().catch(() => undefined);
  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.abs(samples[index]);
      if (value > peak) peak = value;
    }
    onReading(amplitudeToDb(peak));
  }, PROBE_INTERVAL_MS);
  return {
    stop: () => {
      window.clearInterval(timer);
      try { source.disconnect(); } catch { /* Already disconnected. */ }
      void context.close().catch(() => undefined);
    },
  };
}
