import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRelayRecorderOptions,
  chooseRelayRecorderFormat,
  detectRecorderKeyframeIntervalSupport,
  getRelayUploadVideoConfig,
  RELAY_KEYFRAME_INTERVAL_MS,
} from '../src/utils/relayEncoding.ts';

const supports = (...types: string[]) => (mimeType: string) => types.includes(mimeType);

describe('relay upload format', () => {
  it('prefers H.264 in Matroska so the server only copies it', () => {
    const format = chooseRelayRecorderFormat({
      isTypeSupported: supports('video/webm;codecs=vp8,opus', 'video/x-matroska;codecs=avc1,opus'),
      keyframeIntervalSupported: true,
    });
    assert.deepEqual(format, {
      mimeType: 'video/x-matroska;codecs=avc1,opus',
      encoding: { container: 'matroska', videoCodec: 'h264', audioCodec: 'opus', keyframeIntervalMs: RELAY_KEYFRAME_INTERVAL_MS },
      videoMode: 'copy',
    });
  });

  it('accepts H.264 in WebM when Matroska is not offered', () => {
    const format = chooseRelayRecorderFormat({
      isTypeSupported: supports('video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus'),
      keyframeIntervalSupported: true,
    });
    assert.equal(format?.mimeType, 'video/webm;codecs=h264,opus');
    assert.equal(format?.videoMode, 'copy');
  });

  it('needs keyframe control for a copy: without it the server re-encodes', () => {
    const format = chooseRelayRecorderFormat({
      isTypeSupported: supports('video/x-matroska;codecs=avc1,opus'),
      keyframeIntervalSupported: false,
    });
    assert.equal(format?.encoding.keyframeIntervalMs, null);
    assert.equal(format?.videoMode, 'transcode');
  });

  it('falls back to VP8 (server re-encode), and to nothing', () => {
    const vp8 = chooseRelayRecorderFormat({ isTypeSupported: supports('video/webm;codecs=vp8,opus'), keyframeIntervalSupported: true });
    assert.equal(vp8?.encoding.videoCodec, 'vp8');
    assert.equal(vp8?.videoMode, 'transcode');
    assert.equal(chooseRelayRecorderFormat({ isTypeSupported: () => false, keyframeIntervalSupported: true }), null);
    assert.equal(chooseRelayRecorderFormat({
      isTypeSupported: () => { throw new Error('bad type'); },
      keyframeIntervalSupported: true,
    }), null);
  });

  it('detects videoKeyFrameIntervalDuration support from the options a browser reads', () => {
    class ReadsInterval {
      constructor(_stream: MediaStream, options?: MediaRecorderOptions & { videoKeyFrameIntervalDuration?: number }) {
        void options?.videoKeyFrameIntervalDuration;
        throw new Error('empty stream refused after reading the options');
      }
    }
    class IgnoresInterval {
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        void options?.mimeType;
      }
    }
    const stream = () => ({}) as MediaStream;
    assert.equal(detectRecorderKeyframeIntervalSupport(ReadsInterval, stream), true);
    assert.equal(detectRecorderKeyframeIntervalSupport(IgnoresInterval, stream), false);
    assert.equal(detectRecorderKeyframeIntervalSupport(undefined, stream), false);
  });

  it('asks the recorder for a keyframe every two seconds only when it can', () => {
    const video = { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 4_500_000 };
    const copy = chooseRelayRecorderFormat({ isTypeSupported: supports('video/x-matroska;codecs=avc1,opus'), keyframeIntervalSupported: true });
    assert.ok(copy);
    assert.deepEqual(buildRelayRecorderOptions(copy, video, 160_000), {
      mimeType: 'video/x-matroska;codecs=avc1,opus',
      videoBitsPerSecond: 4_500_000,
      audioBitsPerSecond: 160_000,
      videoKeyFrameIntervalDuration: 2_000,
    });
    const vp8 = chooseRelayRecorderFormat({ isTypeSupported: supports('video/webm;codecs=vp8,opus'), keyframeIntervalSupported: false });
    assert.ok(vp8);
    assert.equal('videoKeyFrameIntervalDuration' in buildRelayRecorderOptions(vp8, video, 160_000), false);
  });

  it('sizes a re-encoded upload to the server ceiling and leaves a copy alone', () => {
    const landscape = { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 4_500_000 };
    assert.deepEqual(getRelayUploadVideoConfig(landscape, 'copy'), landscape);
    assert.deepEqual(getRelayUploadVideoConfig(landscape, 'transcode'), {
      width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 3_000_000,
    });
    assert.deepEqual(getRelayUploadVideoConfig({ width: 1080, height: 1920, frameRate: 30, videoBitsPerSecond: 4_500_000 }, 'transcode'), {
      width: 720, height: 1280, frameRate: 30, videoBitsPerSecond: 3_000_000,
    });
    const small = { width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 2_500_000 };
    assert.deepEqual(getRelayUploadVideoConfig(small, 'transcode'), small);
  });
});
