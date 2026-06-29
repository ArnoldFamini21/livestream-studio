import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  createVideoTrackConstraints,
  DEFAULT_AUDIO_PROCESSING_PREFERENCES,
  DEFAULT_VIDEO_QUALITY_PRESET_ID,
  getVideoQualityPreset,
  normalizeVideoQualityPresetId,
  readPreferredAudioProcessing,
  readPreferredVideoQuality,
  VIDEO_QUALITY_PRESETS,
  writePreferredAudioProcessing,
  writePreferredVideoQuality,
} from '../src/utils/mediaPreferences.ts';

class MemoryStorage {
  private readonly store = new Map<string, string>();

  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key) || '' : null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: new MemoryStorage(),
    configurable: true,
  });
});

describe('audio processing preferences', () => {
  it('defaults echo cancellation and noise suppression on', () => {
    assert.deepEqual(readPreferredAudioProcessing(), DEFAULT_AUDIO_PROCESSING_PREFERENCES);
  });

  it('round trips explicit join-screen audio processing choices through session storage', () => {
    writePreferredAudioProcessing({ echoCancellation: false, noiseSuppression: true });

    assert.deepEqual(readPreferredAudioProcessing(), {
      echoCancellation: false,
      noiseSuppression: true,
    });
  });

  it('falls back to defaults when session storage values are not booleans', () => {
    sessionStorage.setItem('preferredEchoCancellation', 'yes');
    sessionStorage.setItem('preferredNoiseSuppression', '');

    assert.deepEqual(readPreferredAudioProcessing(), DEFAULT_AUDIO_PROCESSING_PREFERENCES);
  });
});

describe('video quality preferences', () => {
  it('defaults camera capture to 1080p', () => {
    assert.equal(readPreferredVideoQuality(), DEFAULT_VIDEO_QUALITY_PRESET_ID);
    assert.equal(getVideoQualityPreset(readPreferredVideoQuality()).label, '1080p');
  });

  it('exposes bounded 720p, 1080p, and 4K presets', () => {
    assert.deepEqual(VIDEO_QUALITY_PRESETS.map((preset) => preset.id), ['720p', '1080p', '4k']);
    assert.equal(getVideoQualityPreset('720p').width, 1280);
    assert.equal(getVideoQualityPreset('1080p').height, 1080);
    assert.equal(getVideoQualityPreset('4k').width, 3840);
  });

  it('round trips the selected video quality through session storage', () => {
    writePreferredVideoQuality('4k');
    assert.equal(readPreferredVideoQuality(), '4k');

    writePreferredVideoQuality('720p');
    assert.equal(readPreferredVideoQuality(), '720p');
  });

  it('falls back to 1080p for invalid stored video quality values', () => {
    sessionStorage.setItem('preferredVideoQuality', '8k');
    assert.equal(readPreferredVideoQuality(), DEFAULT_VIDEO_QUALITY_PRESET_ID);
    assert.equal(normalizeVideoQualityPresetId(null), DEFAULT_VIDEO_QUALITY_PRESET_ID);
  });

  it('builds video constraints from the selected quality preset and optional camera', () => {
    assert.deepEqual(createVideoTrackConstraints('camera-1', '4k'), {
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
      deviceId: { exact: 'camera-1' },
    });

    assert.deepEqual(createVideoTrackConstraints('', '720p'), {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
  });
});
