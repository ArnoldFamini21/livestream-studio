import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_VIRTUAL_BACKGROUND_CONFIG,
  VIRTUAL_BACKGROUND_STORAGE_KEY,
  normalizeVirtualBackgroundConfig,
  parseVirtualBackgroundConfig,
  serializeVirtualBackgroundConfig,
} from '../src/utils/virtualBackgrounds.ts';

describe('virtual background config', () => {
  it('normalizes blur mode with bounded strength', () => {
    assert.deepEqual(normalizeVirtualBackgroundConfig({ mode: 'blur', blurPx: 16 }), {
      mode: 'blur',
      blurPx: 16,
    });
    assert.deepEqual(normalizeVirtualBackgroundConfig({ mode: 'blur', blurPx: 99 }), {
      mode: 'blur',
      blurPx: 28,
    });
    assert.deepEqual(normalizeVirtualBackgroundConfig({ mode: 'blur', blurPx: 1 }), {
      mode: 'blur',
      blurPx: 4,
    });
  });

  it('accepts only supported image sources for image mode', () => {
    assert.deepEqual(normalizeVirtualBackgroundConfig({
      mode: 'image',
      imageSrc: 'data:image/png;base64,abc123',
    }), {
      mode: 'image',
      imageSrc: 'data:image/png;base64,abc123',
    });
    assert.deepEqual(normalizeVirtualBackgroundConfig({
      mode: 'image',
      imageSrc: 'https://example.test/background.webp',
    }), {
      mode: 'image',
      imageSrc: 'https://example.test/background.webp',
    });
    assert.deepEqual(
      normalizeVirtualBackgroundConfig({ mode: 'image', imageSrc: 'javascript:alert(1)' }),
      DEFAULT_VIRTUAL_BACKGROUND_CONFIG
    );
    assert.deepEqual(
      normalizeVirtualBackgroundConfig({ mode: 'image' }),
      DEFAULT_VIRTUAL_BACKGROUND_CONFIG
    );
  });

  it('parses and serializes persisted config defensively', () => {
    assert.equal(VIRTUAL_BACKGROUND_STORAGE_KEY, 'livestream-studio:virtual-background');
    assert.deepEqual(parseVirtualBackgroundConfig(null), DEFAULT_VIRTUAL_BACKGROUND_CONFIG);
    assert.deepEqual(parseVirtualBackgroundConfig('not json'), DEFAULT_VIRTUAL_BACKGROUND_CONFIG);
    assert.deepEqual(parseVirtualBackgroundConfig(JSON.stringify({ mode: 'blur', blurPx: 15.7 })), {
      mode: 'blur',
      blurPx: 16,
    });
    assert.equal(
      serializeVirtualBackgroundConfig({ mode: 'image', imageSrc: 'ftp://example.test/image.png' }),
      JSON.stringify(DEFAULT_VIRTUAL_BACKGROUND_CONFIG)
    );
  });
});
