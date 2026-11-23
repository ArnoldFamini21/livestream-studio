import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectCueAgreement, readFlashCues, readPulseCues } from './recording-cues.mjs';

test('uses the first illuminated frame and ignores isolated bright frames', () => {
  const input = [30, 160, 32, 211, 210, 30].map((luma, index) => (
    `frame:${index} pts:${index} pts_time:${index / 25}\nlavfi.signalstats.YAVG=${luma}\n`
  )).join('');
  assert.deepEqual(readFlashCues(input, 150), [0.12]);
  assert.throws(() => readFlashCues(input, 0), /dark background/);
});

test('ignores a silence endpoint at the end of the captured audio', () => {
  assert.deepEqual(readPulseCues('silence_end: 1.2\nsilence_end: 3.1\nsilence_end: 9.9999', 10), [1.2, 3.1]);
});

test('requires matching cue counts and checks absolute offset and change independently', () => {
  const pulses = [1, 10, 20];
  assert.equal(inspectCueAgreement([1.01, 10.02, 20.02], pulses, 3).passed, true);
  assert.equal(inspectCueAgreement([1.05, 10.05, 20.05], pulses, 3).passed, false);
  assert.equal(inspectCueAgreement([1.03, 9.97, 20.001], pulses, 3).passed, false);
  assert.throws(() => inspectCueAgreement([1, 10], pulses, 3), /Found 2 flashes/);
});
