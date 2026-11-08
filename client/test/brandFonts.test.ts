import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeBrandFont, normalizeBrandFontFamilyName, type BrandFont } from '@studio/shared';
import {
  BRAND_FONT_PRESETS,
  checkBrandFontFile,
  DEFAULT_CANVAS_FONT_FAMILY,
  getBrandFontFamilyStack,
  getBrandFontLabel,
  getBrandFontLoadDescriptors,
  getUploadedBrandFontFaceName,
  isSameBrandFont,
  MAX_BRAND_FONT_FILE_BYTES,
} from '../src/utils/brandFonts.ts';
import { buildLowerThirdCanvasFont } from '../src/utils/lowerThirds.ts';

const upload: Extract<BrandFont, { source: 'upload' }> = {
  source: 'upload',
  family: 'Acme Sans',
  fileId: 'font-abc123',
  fileName: 'AcmeSans-Bold.woff2',
};

describe('brand font normalization', () => {
  it('keeps known presets and well-formed uploads only', () => {
    assert.deepEqual(normalizeBrandFont({ source: 'preset', presetId: 'oswald' }), { source: 'preset', presetId: 'oswald' });
    assert.equal(normalizeBrandFont({ source: 'preset', presetId: 'comic-sans' }), null);
    assert.equal(normalizeBrandFont({ source: 'upload', family: 'X', fileId: '../etc' }), null);
    assert.equal(normalizeBrandFont('inter'), null);
    assert.deepEqual(normalizeBrandFont({ ...upload, fileName: '' }), { ...upload, fileName: 'Acme Sans' });
  });

  it('strips characters that could break out of a CSS font stack', () => {
    assert.equal(normalizeBrandFontFamilyName('Evil"; } body { x'), 'Evil body x');
    assert.equal(normalizeBrandFontFamilyName('  Two   Spaces '), 'Two Spaces');
  });
});

describe('brand font stacks', () => {
  it('uses Inter when no brand font is set, and for the Inter preset', () => {
    assert.equal(getBrandFontFamilyStack(null), DEFAULT_CANVAS_FONT_FAMILY);
    assert.equal(getBrandFontFamilyStack({ source: 'preset', presetId: 'inter' }), DEFAULT_CANVAS_FONT_FAMILY);
    assert.equal(getBrandFontLabel(null), 'Inter (default)');
  });

  it('quotes the preset family and falls back to Inter and a generic family', () => {
    assert.equal(getBrandFontFamilyStack({ source: 'preset', presetId: 'playfair-display' }), '"Playfair Display", Inter, Arial, serif');
    assert.equal(getBrandFontFamilyStack({ source: 'preset', presetId: 'montserrat' }), '"Montserrat", Inter, Arial, sans-serif');
  });

  it('registers uploads under a prefixed name so they never replace the studio faces', () => {
    const face = getUploadedBrandFontFaceName({ ...upload, family: 'Inter' });
    assert.notEqual(face, 'Inter');
    assert.ok(face.startsWith('Brand Inter '));
    assert.equal(getBrandFontFamilyStack(upload), `"${getUploadedBrandFontFaceName(upload)}", Inter, Arial, sans-serif`);
  });

  it('waits on every weight a preset draws with', () => {
    assert.deepEqual(getBrandFontLoadDescriptors(null), []);
    const oswald = BRAND_FONT_PRESETS.find((preset) => preset.id === 'oswald');
    assert.deepEqual(
      getBrandFontLoadDescriptors({ source: 'preset', presetId: 'oswald' }),
      (oswald?.weights || []).map((weight) => `${weight} 32px "Oswald"`)
    );
    assert.equal(getBrandFontLoadDescriptors(upload).length, 1);
  });

  it('compares brand fonts by content', () => {
    assert.ok(isSameBrandFont(null, null));
    assert.ok(isSameBrandFont({ source: 'preset', presetId: 'poppins' }, { source: 'preset', presetId: 'poppins' }));
    assert.ok(!isSameBrandFont({ source: 'preset', presetId: 'poppins' }, null));
    assert.ok(isSameBrandFont(upload, { ...upload }));
    assert.ok(!isSameBrandFont(upload, { ...upload, fileId: 'font-other' }));
  });

  it('draws the default Sans lower third in the brand font, and leaves picked faces alone', () => {
    const stack = getBrandFontFamilyStack({ source: 'preset', presetId: 'oswald' });
    assert.equal(buildLowerThirdCanvasFont(700, 32, 'inter', stack), `700 32px ${stack}`);
    assert.equal(buildLowerThirdCanvasFont(700, 32, 'inter', null), '700 32px Inter, Arial, sans-serif');
    assert.ok(!buildLowerThirdCanvasFont(700, 32, 'display', stack).includes('Oswald'));
  });
});

describe('uploaded font files', () => {
  it('accepts web and desktop font formats up to the size limit and names the family from the file', () => {
    assert.deepEqual(checkBrandFontFile({ name: 'AcmeSans-Bold.woff2', size: 20_000 }), { ok: true, family: 'AcmeSans' });
    assert.deepEqual(checkBrandFontFile({ name: 'my_brand_font.ttf', size: 20_000 }), { ok: true, family: 'my brand font' });
    assert.equal(checkBrandFontFile({ name: 'logo.png', size: 20_000 }).ok, false);
    assert.equal(checkBrandFontFile({ name: 'empty.otf', size: 0 }).ok, false);
    assert.equal(checkBrandFontFile({ name: 'huge.woff', size: MAX_BRAND_FONT_FILE_BYTES + 1 }).ok, false);
  });
});
