import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveStreamTokenClaims, RecordingUploadTokenClaims, RtmpRelayDestination } from '@studio/shared';
import { signLiveStreamToken, verifyLiveStreamToken, verifyRecordingUploadToken } from './auth.js';
import {
  buildRtmpOutputUrl,
  createFfmpegArgs,
  createFfmpegEncoderArgs,
  createFfmpegPushArgs,
  createFfmpegSlateArgs,
  getMaxRtmpDestinations,
  getRelayEncoderOptions,
  getRelayOutputVideoConfig,
  MAX_PER_DESTINATION_ENCODES,
  MAX_RTMP_DESTINATIONS,
  getRelayVideoMode,
  hasRemainingRelayWork,
  normalizeRelayEncoding,
  normalizeVideoConfig,
  TRANSCODE_MAX_VIDEO_BITRATE,
  redactDestinationUrl,
  validateDestinations,
  validateRtmpUrl,
} from './rtmp.js';

const destination: RtmpRelayDestination = {
  id: 'dest-1',
  name: 'Custom',
  rtmpUrl: 'rtmps://live.example.com/app/',
  streamKey: 'secret-stream-key',
};

describe('RTMP relay utilities', () => {
  it('validates RTMP and RTMPS URLs only', () => {
    assert.equal(validateRtmpUrl('rtmp://live.example.com/app'), null);
    assert.equal(validateRtmpUrl('rtmps://live.example.com/app'), null);
    assert.match(validateRtmpUrl('https://live.example.com/app') || '', /rtmp/);
    assert.match(validateRtmpUrl('not-a-url') || '', /Invalid/);
  });

  it('joins stream keys without leaking duplicate slashes', () => {
    assert.equal(
      buildRtmpOutputUrl('rtmp://a.rtmp.youtube.com/live2/', '/abcd-1234'),
      'rtmp://a.rtmp.youtube.com/live2/abcd-1234'
    );
  });

  it('validates destination count and shape', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ ...destination, id: `dest-${index + 1}` }));
    assert.equal(validateDestinations([destination], 8), null);
    assert.match(validateDestinations([], 8) || '', /required/);
    assert.equal(validateDestinations(many(8), 8), null);
    assert.match(validateDestinations(many(9), 8) || '', /maximum of 8 RTMP destinations/i);
    assert.match(validateDestinations(many(4), 3) || '', /maximum of 3/i);
    assert.match(validateDestinations([destination, destination], 8) || '', /unique/);
  });

  it('allows eight destinations by default and lets the environment lower the cap', () => {
    assert.equal(MAX_RTMP_DESTINATIONS, 8);
    assert.equal(getMaxRtmpDestinations({}), 8);
    assert.equal(getMaxRtmpDestinations({ RTMP_MAX_DESTINATIONS: '5' }), 5);
    assert.equal(getMaxRtmpDestinations({ RTMP_MAX_DESTINATIONS: ' 1 ' }), 1);
    // Never above the hard cap, and nonsense falls back to the default.
    assert.equal(getMaxRtmpDestinations({ RTMP_MAX_DESTINATIONS: '20' }), 8);
    for (const value of ['0', '-2', '2.5', 'eight', '']) {
      assert.equal(getMaxRtmpDestinations({ RTMP_MAX_DESTINATIONS: value }), 8, value);
    }
  });

  it('keeps the three-destination cap when every destination runs its own encode', () => {
    assert.equal(getMaxRtmpDestinations({ RTMP_ENCODE_ONCE: 'false' }), MAX_PER_DESTINATION_ENCODES);
    assert.equal(getMaxRtmpDestinations({ RTMP_ENCODE_ONCE: 'false', RTMP_MAX_DESTINATIONS: '8' }), 3);
    assert.equal(getMaxRtmpDestinations({ RTMP_ENCODE_ONCE: 'false', RTMP_MAX_DESTINATIONS: '2' }), 2);
  });

  it('redacts stream keys from destination URLs', () => {
    assert.equal(redactDestinationUrl(destination), 'rtmps://live.example.com/app/[stream-key]');
  });

  it('keeps relay sessions open while any destination is active or reconnecting', () => {
    assert.equal(hasRemainingRelayWork([]), false);
    assert.equal(hasRemainingRelayWork([{ exited: true }, { exited: true }]), false);
    assert.equal(hasRemainingRelayWork([{ exited: true }, { exited: false }]), true);
    assert.equal(hasRemainingRelayWork([{ exited: true, restartPending: true }]), true);
  });

  it('signs and verifies short-lived live stream tokens', () => {
    const secret = 'a'.repeat(32);
    const claims: LiveStreamTokenClaims = {
      v: 1,
      roomId: 'room-1',
      participantId: 'host-1',
      role: 'host',
      exp: Date.now() + 60_000,
      nonce: 'nonce-1',
    };

    const token = signLiveStreamToken(claims, secret);
    assert.deepEqual(verifyLiveStreamToken(token, secret), claims);
    assert.throws(() => verifyLiveStreamToken(token, 'b'.repeat(32)), /signature/);
    assert.throws(() => verifyLiveStreamToken(token, secret, claims.exp + 1), /expired/);
  });

  it('keeps participant recording tokens scoped away from live streaming', () => {
    const secret = 'c'.repeat(32);
    const claims: RecordingUploadTokenClaims = {
      v: 1,
      purpose: 'recording-upload',
      roomId: 'room-1',
      participantId: 'guest-1',
      participantName: 'Guest One',
      role: 'guest',
      sessionId: 'recording-session-1',
      exp: Date.now() + 60_000,
      nonce: 'nonce-recording-1',
    };

    const token = signLiveStreamToken(claims, secret);
    assert.deepEqual(verifyRecordingUploadToken(token, secret), claims);
    assert.throws(() => verifyLiveStreamToken(token, secret), /claims/);
    assert.throws(() => verifyRecordingUploadToken(token, secret, claims.exp + 1), /expired/);
  });

  const audio = {
    sampleRate: 48_000,
    channelCount: 2,
    audioBitsPerSecond: 160_000,
  };
  const h264Encoding = {
    container: 'matroska' as const,
    videoCodec: 'h264' as const,
    audioCodec: 'opus' as const,
    keyframeIntervalMs: 2_000,
  };

  it('copies H.264 from the browser and only encodes the audio', () => {
    const options = getRelayEncoderOptions({
      video: { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 4_500_000 },
      audio,
      encoding: h264Encoding,
    });
    assert.equal(options.videoMode, 'copy');
    const args = createFfmpegEncoderArgs(options);

    assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
    assert.equal(args.includes('libx264'), false);
    assert.equal(args.includes('-vf'), false, 'no scale filter: the browser sends the output size');
    assert.equal(args.includes('-r'), false);
    assert.deepEqual(args.slice(args.indexOf('-progress'), args.indexOf('-progress') + 4), ['-progress', 'pipe:2', '-stats_period', '2']);
    assert.equal(args.at(-1), 'pipe:1');
  });

  it('re-encodes VP8, uncontrolled keyframes and older studios, capped at 720p30', () => {
    assert.equal(getRelayVideoMode(undefined), 'transcode');
    assert.equal(getRelayVideoMode({ ...h264Encoding, videoCodec: 'vp8' }), 'transcode');
    assert.equal(getRelayVideoMode({ ...h264Encoding, keyframeIntervalMs: null }), 'transcode');
    assert.equal(getRelayVideoMode({ ...h264Encoding, keyframeIntervalMs: 10_000 }), 'transcode');
    assert.equal(getRelayVideoMode(h264Encoding), 'copy');

    const args = createFfmpegArgs(destination, {
      video: { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 4_500_000 },
      audio,
    });
    assert.equal(args.at(-1), 'rtmps://live.example.com/app/secret-stream-key');
    assert.equal(args.includes('libx264'), true);
    assert.equal(args[args.indexOf('-preset') + 1], 'ultrafast');
    assert.equal(args.includes('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2'), true);
    assert.equal(args[args.indexOf('-r') + 1], '30');
    assert.equal(args[args.indexOf('-g') + 1], '60');
    assert.equal(args[args.indexOf('-b:v') + 1], `${TRANSCODE_MAX_VIDEO_BITRATE / 1000}k`);
    assert.equal(args.includes('aac'), true);
    assert.equal(args.includes('flv'), true);
  });

  it('keeps portrait output portrait in both modes', () => {
    const video = { width: 1080, height: 1920, frameRate: 30, videoBitsPerSecond: 4_500_000 };
    assert.deepEqual(getRelayOutputVideoConfig(video, 'copy'), video);
    assert.deepEqual(getRelayOutputVideoConfig(video, 'transcode'), {
      width: 720,
      height: 1280,
      frameRate: 30,
      videoBitsPerSecond: TRANSCODE_MAX_VIDEO_BITRATE,
    });
    const args = createFfmpegArgs(destination, { video, audio });
    assert.equal(args.includes('scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2'), true);
  });

  it('builds the reconnect slate at the program output size with the cheapest preset', () => {
    const video = { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 4_500_000 };
    const copySlate = createFfmpegSlateArgs({ video, audio, videoMode: 'copy' }, '/slate.jpg');
    assert.equal(copySlate.includes('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2'), true);
    assert.equal(copySlate[copySlate.indexOf('-preset') + 1], 'ultrafast');
    const transcodeSlate = createFfmpegSlateArgs({ video, audio, videoMode: 'transcode' }, '/slate.jpg');
    assert.equal(transcodeSlate.includes('scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2'), true);
  });

  it('reports each destination uploader with FFmpeg progress', () => {
    const args = createFfmpegPushArgs(destination);
    assert.equal(args.includes('-progress'), true);
    assert.equal(args[args.indexOf('-c') + 1], 'copy');
  });

  it('normalizes the declared encoding', () => {
    assert.deepEqual(normalizeRelayEncoding(undefined), {
      container: 'webm', videoCodec: 'vp8', audioCodec: 'opus', keyframeIntervalMs: null,
    });
    assert.deepEqual(normalizeRelayEncoding({ container: 'avi', videoCodec: 'hevc', keyframeIntervalMs: -1 }), {
      container: 'webm', videoCodec: 'unknown', audioCodec: 'unknown', keyframeIntervalMs: null,
    });
    assert.deepEqual(normalizeRelayEncoding(h264Encoding), h264Encoding);
  });

  it('accepts true portrait programs at 1080x1920 and 720x1280 unchanged', () => {
    for (const [width, height] of [[1080, 1920], [720, 1280]]) {
      const video = { width, height, frameRate: 30, videoBitsPerSecond: 4_500_000 };
      assert.deepEqual(normalizeVideoConfig(video), video);
      assert.deepEqual(getRelayOutputVideoConfig(normalizeVideoConfig(video), 'copy'), video);
    }
  });

  it('bounds relay video configs to what the studio composes: 1080p30', () => {
    const normalized = normalizeVideoConfig({
      width: 3840,
      height: 3840,
      frameRate: 120,
      videoBitsPerSecond: 50_000_000,
    });

    assert.ok(normalized.width * normalized.height <= 1920 * 1080);
    assert.equal(normalized.width % 2, 0);
    assert.equal(normalized.height % 2, 0);
    assert.equal(normalized.frameRate, 30);
    assert.equal(normalized.videoBitsPerSecond, 10_000_000);
  });
});
