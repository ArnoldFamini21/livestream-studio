import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_RECORDING_COUNTDOWN_SECONDS, normalizeRecordingCountdownSeconds } from '../src/utils/recordingCountdown.ts';

describe('recording countdown shown to guests', () => {
  it('accepts whole seconds and caps long countdowns', () => {
    assert.equal(normalizeRecordingCountdownSeconds(3), 3);
    assert.equal(normalizeRecordingCountdownSeconds(2.6), 3);
    assert.equal(normalizeRecordingCountdownSeconds(600), MAX_RECORDING_COUNTDOWN_SECONDS);
  });

  it('treats zero, negatives and junk as no countdown', () => {
    assert.equal(normalizeRecordingCountdownSeconds(0), null);
    assert.equal(normalizeRecordingCountdownSeconds(-2), null);
    assert.equal(normalizeRecordingCountdownSeconds('3'), null);
    assert.equal(normalizeRecordingCountdownSeconds(Number.NaN), null);
  });
});
