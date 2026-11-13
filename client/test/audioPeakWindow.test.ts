import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AudioPeakWindow, amplitudeToDb } from '../src/utils/audioPeakWindow.ts';

describe('audio peak window', () => {
  it('converts amplitude to dBFS', () => {
    assert.equal(amplitudeToDb(1), 0);
    assert.ok(Math.abs(amplitudeToDb(0.5) + 6.02) < 0.01);
    assert.equal(amplitudeToDb(0), -120);
    assert.equal(amplitudeToDb(Number.NaN), -120);
  });

  it('has no reading until the meter reports', () => {
    assert.equal(new AudioPeakWindow().peak(1000), null);
  });

  it('keeps the loudest recent reading and forgets old ones', () => {
    const window = new AudioPeakWindow(5_000);
    window.push(-10, 1_000);
    window.push(-40, 2_000);
    assert.equal(window.peak(3_000), -10);
    // The loud moment ages out; only the quiet reading remains.
    assert.equal(window.peak(6_500), -40);
    assert.equal(window.peak(20_000), null);
  });

  it('reads pure silence as the floor, not as missing', () => {
    const window = new AudioPeakWindow();
    window.push(amplitudeToDb(0), 100);
    assert.equal(window.peak(200), -120);
  });
});
