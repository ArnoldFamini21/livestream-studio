/**
 * Reads a recorded track as short 16 kHz mono windows without decoding the
 * whole file: mediabunny (already used by the cleaned render) reads the
 * container in pieces from the Blob and WebCodecs AudioDecoder decodes only
 * the packets inside each requested window. Browsers without WebCodecs audio
 * decoding fall back to decodeAudioData for tracks small enough to hold in
 * memory.
 */
import { WHISPER_SAMPLE_RATE, downmixAndResample } from './transcriptionWindows.ts';

export interface AudioWindowReader {
  durationSeconds: number;
  /** 16 kHz mono samples for [startSeconds, endSeconds) of the track. */
  readWindow(startSeconds: number, endSeconds: number): Promise<Float32Array>;
  close(): void;
}

/** Largest file the whole-file decodeAudioData fallback accepts (about 30 min of 256 kbps Opus). */
export const MAX_FALLBACK_DECODE_BYTES = 60 * 1024 * 1024;

export async function openAudioWindowReader(blob: Blob, sampleRate = WHISPER_SAMPLE_RATE): Promise<AudioWindowReader> {
  let streamingError: unknown = null;
  try {
    const reader = await openStreamingReader(blob, sampleRate);
    if (reader) return reader;
  } catch (err) {
    streamingError = err;
  }
  if (blob.size > MAX_FALLBACK_DECODE_BYTES) {
    const reason = streamingError instanceof Error ? ` (${streamingError.message})` : '';
    throw new Error(
      `This browser cannot decode this track in pieces${reason}. Use a recent desktop Chrome, Edge or Firefox for long tracks.`
    );
  }
  return openWholeFileReader(blob, sampleRate);
}

async function openStreamingReader(blob: Blob, sampleRate: number): Promise<AudioWindowReader | null> {
  if (typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder !== 'function') return null;
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('The track has no audio');
  if (!(await track.canDecode())) throw new Error(`no ${track.codec || 'audio'} decoder`);
  const firstTimestamp = await input.getFirstTimestamp().catch(() => 0);
  const lastTimestamp = await track.computeDuration();
  const durationSeconds = Math.max(0, lastTimestamp - firstTimestamp);
  const sink = new mb.AudioSampleSink(track);
  let closed = false;

  return {
    durationSeconds,
    async readWindow(startSeconds, endSeconds) {
      if (closed) throw new Error('The audio reader is closed');
      const from = firstTimestamp + Math.max(0, startSeconds);
      const to = firstTimestamp + Math.max(startSeconds, endSeconds);
      const channels: Float32Array[][] = [];
      let sourceRate = 0;
      for await (const sample of sink.samples(from, to)) {
        try {
          sourceRate = sourceRate || sample.sampleRate;
          const frames = sample.numberOfFrames;
          const sampleStart = sample.timestamp;
          // Trim the first and last sample to the exact window edges.
          const skip = Math.max(0, Math.round((from - sampleStart) * sample.sampleRate));
          const keepUntil = Math.min(frames, Math.round((to - sampleStart) * sample.sampleRate));
          if (keepUntil <= skip) continue;
          for (let plane = 0; plane < sample.numberOfChannels; plane += 1) {
            const data = new Float32Array(frames);
            sample.copyTo(data, { planeIndex: plane, format: 'f32-planar' });
            (channels[plane] ||= []).push(data.subarray(skip, keepUntil));
          }
        } finally {
          sample.close();
        }
      }
      if (!sourceRate || channels.length === 0) return new Float32Array(0);
      return downmixAndResample(channels.map(concatFloat32), sourceRate, sampleRate);
    },
    close() {
      closed = true;
      try {
        input.dispose?.();
      } catch {
        // Releasing the reader is best-effort.
      }
    },
  };
}

async function openWholeFileReader(blob: Blob, sampleRate: number): Promise<AudioWindowReader> {
  const OfflineContext = (globalThis as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  }).OfflineAudioContext || (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('This browser cannot decode audio for transcription');
  // decodeAudioData resamples to the context rate, so the buffer is already 16 kHz.
  const context = new OfflineContext(1, 1, sampleRate);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  const planes: Float32Array[] = [];
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) planes.push(decoded.getChannelData(channel));
  let mono: Float32Array | null = downmixAndResample(planes, decoded.sampleRate, sampleRate);
  const durationSeconds = mono.length / sampleRate;
  return {
    durationSeconds,
    async readWindow(startSeconds, endSeconds) {
      if (!mono) throw new Error('The audio reader is closed');
      const from = Math.max(0, Math.floor(startSeconds * sampleRate));
      const to = Math.min(mono.length, Math.ceil(endSeconds * sampleRate));
      return mono.slice(from, Math.max(from, to));
    },
    close() {
      mono = null;
    },
  };
}

export function concatFloat32(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
