import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSpeakerTestToneBlob,
  SPEAKER_TEST_DURATION_SECONDS,
  SPEAKER_TEST_SAMPLE_RATE,
} from '../src/utils/speakerTestTone.ts';

function readAscii(view: DataView, offset: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index++) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

describe('speaker test tone', () => {
  it('creates a mono 16-bit WAV tone with non-silent samples', async () => {
    const blob = createSpeakerTestToneBlob();
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const expectedSampleCount = Math.floor(SPEAKER_TEST_SAMPLE_RATE * SPEAKER_TEST_DURATION_SECONDS);
    const expectedDataSize = expectedSampleCount * 2;

    assert.equal(blob.type, 'audio/wav');
    assert.equal(readAscii(view, 0, 4), 'RIFF');
    assert.equal(readAscii(view, 8, 4), 'WAVE');
    assert.equal(readAscii(view, 12, 4), 'fmt ');
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), SPEAKER_TEST_SAMPLE_RATE);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(readAscii(view, 36, 4), 'data');
    assert.equal(view.getUint32(40, true), expectedDataSize);
    assert.equal(buffer.byteLength, 44 + expectedDataSize);

    let nonSilentSamples = 0;
    for (let offset = 44; offset < buffer.byteLength; offset += 2) {
      if (view.getInt16(offset, true) !== 0) nonSilentSamples++;
    }
    assert.ok(nonSilentSamples > expectedSampleCount * 0.8);
  });
});
