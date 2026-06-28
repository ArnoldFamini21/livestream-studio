import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CHROMA_KEY_COLOR,
  DEFAULT_VIRTUAL_BACKGROUND_CONFIG,
  MAX_CHROMA_SIMILARITY,
  MIN_CHROMA_SIMILARITY,
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

  it('normalizes green-screen mode with bounded chroma controls', () => {
    assert.deepEqual(normalizeVirtualBackgroundConfig({
      mode: 'green-screen',
      imageSrc: ' https://example.test/studio-background.webp ',
      keyColor: '#0F0',
      similarity: 0.333,
    }), {
      mode: 'green-screen',
      imageSrc: 'https://example.test/studio-background.webp',
      keyColor: '#00ff00',
      similarity: 0.33,
    });

    assert.deepEqual(normalizeVirtualBackgroundConfig({
      mode: 'green-screen',
      imageSrc: 'javascript:alert(1)',
      keyColor: 'green',
      similarity: 99,
    }), {
      mode: 'green-screen',
      keyColor: DEFAULT_CHROMA_KEY_COLOR,
      similarity: MAX_CHROMA_SIMILARITY,
    });

    assert.deepEqual(normalizeVirtualBackgroundConfig({
      mode: 'green-screen',
      keyColor: '#123456',
      similarity: -1,
    }), {
      mode: 'green-screen',
      keyColor: '#123456',
      similarity: MIN_CHROMA_SIMILARITY,
    });
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
    assert.equal(
      serializeVirtualBackgroundConfig({
        mode: 'green-screen',
        imageSrc: 'ftp://example.test/image.png',
        keyColor: '#fff',
        similarity: 0,
      }),
      JSON.stringify({
        mode: 'green-screen',
        keyColor: '#ffffff',
        similarity: MIN_CHROMA_SIMILARITY,
      })
    );
  });
});
