import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatRtmpRelayOutputSummary,
  getRtmpRelayOutputPreflight,
  getRtmpRelayTargetKbps,
  getRtmpRelayVideoConfig,
  RTMP_RELAY_AUDIO_BITS_PER_SECOND,
  RTMP_RELAY_OUTPUT_PRESETS,
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

  it('builds high-motion 1080p60 and 4K30 relay configs', () => {
    assert.deepEqual(RTMP_RELAY_OUTPUT_PRESETS.map((preset) => preset.id), [
      'smooth-720p',
      'standard-1080p',
      'maximum-1080p',
      'motion-1080p60',
      'ultra-4k30',
    ]);
    assert.deepEqual(getRtmpRelayVideoConfig('landscape', 'motion-1080p60'), {
      width: 1920,
      height: 1080,
      frameRate: 60,
      videoBitsPerSecond: 10_000_000,
    });
    assert.deepEqual(getRtmpRelayVideoConfig('landscape', 'ultra-4k30'), {
      width: 3840,
      height: 2160,
      frameRate: 30,
      videoBitsPerSecond: 18_000_000,
    });
  });

  it('rotates output dimensions for portrait destinations without changing bitrate', () => {
    assert.deepEqual(getRtmpRelayVideoConfig('portrait', 'standard-1080p'), {
      width: 1080,
      height: 1920,
      frameRate: 30,
      videoBitsPerSecond: 4_500_000,
    });
    assert.deepEqual(getRtmpRelayVideoConfig('portrait', 'ultra-4k30'), {
      width: 2160,
      height: 3840,
      frameRate: 30,
      videoBitsPerSecond: 18_000_000,
    });
  });

  it('includes audio overhead in stream health bitrate targets', () => {
    assert.equal(RTMP_RELAY_AUDIO_BITS_PER_SECOND, 160_000);
    assert.equal(getRtmpRelayTargetKbps('smooth-720p'), 2660);
    assert.equal(getRtmpRelayTargetKbps('maximum-1080p'), 8160);
    assert.equal(getRtmpRelayTargetKbps('motion-1080p60'), 10160);
    assert.equal(getRtmpRelayTargetKbps('ultra-4k30'), 18160);
  });

  it('formats the visible output summary from the active orientation and preset', () => {
    assert.equal(
      formatRtmpRelayOutputSummary('portrait', 'smooth-720p'),
      '720x1280 / 30 FPS / 2.7 Mbps'
    );
  });

  it('warns for 60fps and 4K live relay outputs', () => {
    assert.equal(getRtmpRelayOutputPreflight('landscape', 'standard-1080p').status, 'good');
    assert.deepEqual(getRtmpRelayOutputPreflight('landscape', 'motion-1080p60'), {
      status: 'warning',
      detail: '1920x1080 / 60 FPS / 10.2 Mbps. 60 FPS doubles encoder work; test this browser and upload path before a long live session.',
    });
    assert.equal(getRtmpRelayOutputPreflight('portrait', 'ultra-4k30').status, 'warning');
    assert.match(getRtmpRelayOutputPreflight('portrait', 'ultra-4k30').detail, /2160x3840/);
  });
});
