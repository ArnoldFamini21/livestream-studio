import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatRtmpRelayOutputSummary,
  getRtmpRelayTargetKbps,
  getRtmpRelayVideoConfig,
  RTMP_RELAY_AUDIO_BITS_PER_SECOND,
} from '../src/utils/rtmpRelayOutput.ts';

describe('RTMP relay output presets', () => {
  it('builds landscape 720p and 1080p video configs at the selected bitrate', () => {
    assert.deepEqual(getRtmpRelayVideoConfig('landscape', 'smooth-720p'), {
      width: 1280,
      height: 720,
      frameRate: 30,
      videoBitsPerSecond: 2_500_000,
    });
    assert.deepEqual(getRtmpRelayVideoConfig('landscape', 'maximum-1080p'), {
      width: 1920,
      height: 1080,
      frameRate: 30,
      videoBitsPerSecond: 8_000_000,
    });
  });

  it('rotates output dimensions for portrait destinations without changing bitrate', () => {
    assert.deepEqual(getRtmpRelayVideoConfig('portrait', 'standard-1080p'), {
      width: 1080,
      height: 1920,
      frameRate: 30,
      videoBitsPerSecond: 4_500_000,
    });
  });

  it('includes audio overhead in stream health bitrate targets', () => {
    assert.equal(RTMP_RELAY_AUDIO_BITS_PER_SECOND, 160_000);
    assert.equal(getRtmpRelayTargetKbps('smooth-720p'), 2660);
    assert.equal(getRtmpRelayTargetKbps('maximum-1080p'), 8160);
  });

  it('formats the visible output summary from the active orientation and preset', () => {
    assert.equal(
      formatRtmpRelayOutputSummary('portrait', 'smooth-720p'),
      '720x1280 / 30 FPS / 2.7 Mbps'
    );
  });
});
