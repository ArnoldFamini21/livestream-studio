import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBrandThemeVariables, normalizeBrandColor } from '../src/utils/brandTheme.ts';

describe('brand theme variables', () => {
  it('normalizes hex colors defensively', () => {
    assert.equal(normalizeBrandColor('#ABC'), '#aabbcc');
    assert.equal(normalizeBrandColor('2563EB'), '#2563eb');
    assert.equal(normalizeBrandColor('not a color'), '#a78bfa');
    assert.equal(normalizeBrandColor(null), '#a78bfa');
  });

  it('builds CSS accent variables from the brand color', () => {
    assert.deepEqual(buildBrandThemeVariables('#2563eb', 'light'), [
      ['--accent', '#2563eb'],
      ['--accent-hover', '#1f53c5'],
      ['--accent-solid', '#235ddd'],
      ['--accent-subtle', 'rgba(37, 99, 235, 0.14)'],
      ['--accent-glow', 'rgba(37, 99, 235, 0.22)'],
    ]);
  });

  it('lightens hover colors for dark studio themes', () => {
    const variables = Object.fromEntries(buildBrandThemeVariables('#7c3aed', 'dark'));

    assert.equal(variables['--accent'], '#7c3aed');
    assert.equal(variables['--accent-hover'], '#a171f2');
    assert.equal(variables['--accent-solid'], '#6d33d1');
  });
});
