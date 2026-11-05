import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatRtmpRelayOutputSummary,
  getRtmpRelayOutputPreflight,
  getRtmpRelayOutputPreset,
  getRtmpRelayTargetKbps,
  getRtmpRelayVideoConfig,
  RTMP_RELAY_AUDIO_BITS_PER_SECOND,
  RTMP_RELAY_OUTPUT_PRESETS,
  type RtmpRelayOutputPresetId,
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

  it('offers only what the 1080p30 compositor really delivers', () => {
    assert.deepEqual(RTMP_RELAY_OUTPUT_PRESETS.map((preset) => preset.id), [
      'smooth-720p',
      'standard-1080p',
      'maximum-1080p',
    ]);
    for (const preset of RTMP_RELAY_OUTPUT_PRESETS) {
      assert.equal(preset.frameRate, 30, `${preset.id} has no duplicated frames`);
      assert.ok(preset.width <= 1920 && preset.height <= 1080, `${preset.id} is not upscaled`);
    }
    // A preset id saved by an older studio falls back to the default.
    assert.equal(getRtmpRelayOutputPreset('ultra-4k30' as RtmpRelayOutputPresetId).id, 'standard-1080p');
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

  it('says whether the server copies or has to re-encode', () => {
    assert.equal(getRtmpRelayOutputPreflight('landscape', 'standard-1080p').status, 'good');
    assert.deepEqual(getRtmpRelayOutputPreflight('landscape', 'standard-1080p', undefined, 'copy'), {
      status: 'good',
      detail: '1920x1080 / 30 FPS / 4.7 Mbps. Browser H.264, sent on without re-encoding.',
    });
    const transcode = getRtmpRelayOutputPreflight('portrait', 'standard-1080p', undefined, 'transcode');
    assert.equal(transcode.status, 'warning');
    assert.match(transcode.detail, /re-encode/);
    assert.match(transcode.detail, /720p30/);
  });
});
