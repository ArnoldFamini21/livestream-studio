export const SPEAKER_TEST_SAMPLE_RATE = 44_100;
export const SPEAKER_TEST_DURATION_SECONDS = 0.7;

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function createSpeakerTestToneBlob(): Blob {
  const sampleCount = Math.floor(SPEAKER_TEST_SAMPLE_RATE * SPEAKER_TEST_DURATION_SECONDS);
  const bytesPerSample = 2;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SPEAKER_TEST_SAMPLE_RATE, true);
  view.setUint32(28, SPEAKER_TEST_SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < sampleCount; index++) {
    const time = index / SPEAKER_TEST_SAMPLE_RATE;
    const fadeIn = Math.min(1, index / (SPEAKER_TEST_SAMPLE_RATE * 0.04));
    const fadeOut = Math.min(1, (sampleCount - index) / (SPEAKER_TEST_SAMPLE_RATE * 0.08));
    const envelope = Math.min(fadeIn, fadeOut);
    const frequency = time < SPEAKER_TEST_DURATION_SECONDS / 2 ? 660 : 880;
    const sample = Math.sin(2 * Math.PI * frequency * time) * envelope * 0.25;
    view.setInt16(44 + index * bytesPerSample, Math.round(sample * 0x7fff), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
