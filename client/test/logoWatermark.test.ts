import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_LOGO_OPACITY,
  MAX_LOGO_OPACITY,
  MIN_LOGO_OPACITY,
  normalizeLogoOpacity,
} from '../src/utils/logoWatermark.ts';

describe('logo watermark opacity', () => {
  it('normalizes numeric opacity values to the supported range', () => {
    assert.equal(normalizeLogoOpacity(0.45), 0.45);
    assert.equal(normalizeLogoOpacity('0.625'), 0.63);
    assert.equal(normalizeLogoOpacity(0), MIN_LOGO_OPACITY);
    assert.equal(normalizeLogoOpacity(2), MAX_LOGO_OPACITY);
  });

  it('falls back to the default opacity for invalid values', () => {
    assert.equal(normalizeLogoOpacity(undefined), DEFAULT_LOGO_OPACITY);
    assert.equal(normalizeLogoOpacity('bad'), DEFAULT_LOGO_OPACITY);
  });
});
