/**
 * Streaming WAV (RIFF/PCM) writing without holding the audio in memory.
 *
 * A recorder writes a header with placeholder sizes first, appends PCM as it
 * arrives, and replaces the header with the real sizes when it finishes
 * (`createWavHeader` with the final data length). Until then the
 * placeholder (0xFFFFFFFF) makes a crash-recovered file playable to its end
 * in common players. Sizes are clamped to the 4 GiB RIFF limit (about 7.7
 * hours of 48 kHz / 24-bit mono).
 */

export const WAV_HEADER_BYTES = 44;
const MAX_UINT32 = 0xffffffff;

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: 16 | 24 | 32;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

/** 44-byte PCM header. Omit `dataBytes` for the streaming placeholder. */
export function createWavHeader(format: WavFormat, dataBytes?: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) throw new RangeError('Invalid WAV sample rate');
  if (!Number.isInteger(format.channels) || format.channels < 1 || format.channels > 8) throw new RangeError('Invalid WAV channel count');
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const blockAlign = format.channels * (format.bitsPerSample / 8);
  const known = dataBytes !== undefined && Number.isFinite(dataBytes) && dataBytes >= 0;
  const dataSize = known ? Math.min(Math.floor(dataBytes as number), MAX_UINT32 - 36) : MAX_UINT32;
  const riffSize = known ? Math.min(dataSize + 36, MAX_UINT32) : MAX_UINT32;
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, riffSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, format.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  return header;
}

export interface ParsedWavHeader extends WavFormat {
  dataBytes: number;
  riffBytes: number;
}

export function parseWavHeader(bytes: Uint8Array): ParsedWavHeader | null {
  if (bytes.byteLength < WAV_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE' || text(12) !== 'fmt ' || text(36) !== 'data') return null;
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) return null;
  return {
    riffBytes: view.getUint32(4, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample,
    dataBytes: view.getUint32(40, true),
  };
}

/** Interleave float channels (-1..1) into little-endian signed PCM. */
export function encodePcmFrames(channels: Float32Array[], bitsPerSample: WavFormat['bitsPerSample']): Uint8Array<ArrayBuffer> {
  const channelCount = channels.length;
  const frames = channelCount ? Math.min(...channels.map((channel) => channel.length)) : 0;
  const bytesPerSample = bitsPerSample / 8;
  const output = new Uint8Array(frames * channelCount * bytesPerSample);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] || 0));
      if (bitsPerSample === 16) {
        view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
      } else if (bitsPerSample === 24) {
        const value = sample < 0 ? Math.round(sample * 0x800000) : Math.round(sample * 0x7fffff);
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
      } else {
        view.setInt32(offset, sample < 0 ? Math.round(sample * 0x80000000) : Math.round(sample * 0x7fffffff), true);
      }
      offset += bytesPerSample;
    }
  }
  return output;
}

/**
 * Rewrite the header of a WAV file in place (FileSystemWritableFileStream
 * positional write), e.g. to repair a crash-recovered file.
 */
export async function patchWavFileHeader(
  handle: { createWritable(options?: { keepExistingData?: boolean }): Promise<{ write(data: unknown): Promise<void>; close(): Promise<void> }> },
  format: WavFormat,
  dataBytes: number,
): Promise<void> {
  const writable = await handle.createWritable({ keepExistingData: true });
  await writable.write({ type: 'write', position: 0, data: createWavHeader(format, dataBytes) });
  await writable.close();
}
