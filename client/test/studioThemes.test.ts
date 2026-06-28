import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_STUDIO_THEME_ID,
  STUDIO_THEME_PRESETS,
  getStudioThemeLabel,
  normalizeStudioThemeId,
} from '../src/utils/studioThemes.ts';

describe('studio themes', () => {
  it('normalizes known theme ids and falls back to dark', () => {
    assert.equal(normalizeStudioThemeId('dark'), 'dark');
    assert.equal(normalizeStudioThemeId('light'), 'light');
    assert.equal(normalizeStudioThemeId('colorful'), 'colorful');
    assert.equal(normalizeStudioThemeId('missing'), DEFAULT_STUDIO_THEME_ID);
    assert.equal(normalizeStudioThemeId(null), DEFAULT_STUDIO_THEME_ID);
  });

  it('exposes readable theme labels and swatches for controls', () => {
    assert.equal(getStudioThemeLabel('dark'), 'Dark');
    assert.equal(getStudioThemeLabel('light'), 'Light');
    assert.equal(getStudioThemeLabel('bad'), 'Dark');
    assert.deepEqual(
      STUDIO_THEME_PRESETS.map((theme) => theme.swatches.length),
      [3, 3, 3]
    );
  });
});
