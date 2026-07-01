import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveStreamTokenClaims, RtmpRelayDestination } from '@studio/shared';
import { signLiveStreamToken, verifyLiveStreamToken } from './auth.js';
import {
  buildRtmpOutputUrl,
  createFfmpegArgs,
  hasRemainingRelayWork,
  normalizeVideoConfig,
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
    assert.equal(validateDestinations([destination]), null);
    assert.match(validateDestinations([]) || '', /required/);
    assert.match(validateDestinations([destination, { ...destination, id: 'dest-2' }, { ...destination, id: 'dest-3' }, { ...destination, id: 'dest-4' }]) || '', /maximum/i);
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

  it('builds FFmpeg args for 1080p RTMP relay', () => {
    const args = createFfmpegArgs(destination, {
      video: {
        width: 1920,
        height: 1080,
        frameRate: 30,
        videoBitsPerSecond: 4_500_000,
      },
      audio: {
        sampleRate: 48_000,
        channelCount: 2,
        audioBitsPerSecond: 160_000,
      },
    });

    assert.equal(args.at(-1), 'rtmps://live.example.com/app/secret-stream-key');
    assert.equal(args.includes('libx264'), true);
    assert.equal(args.includes('aac'), true);
    assert.equal(args.includes('flv'), true);
    assert.equal(args.includes('30'), true);
  });

  it('builds FFmpeg args for portrait 1080x1920 relay output', () => {
    const args = createFfmpegArgs(destination, {
      video: {
        width: 1080,
        height: 1920,
        frameRate: 30,
        videoBitsPerSecond: 4_500_000,
      },
      audio: {
        sampleRate: 48_000,
        channelCount: 2,
        audioBitsPerSecond: 160_000,
      },
    });

    assert.equal(args.includes('scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2'), true);
  });

  it('builds FFmpeg args for 1080p60 relay output', () => {
    const args = createFfmpegArgs(destination, {
      video: {
        width: 1920,
        height: 1080,
        frameRate: 60,
        videoBitsPerSecond: 10_000_000,
      },
      audio: {
        sampleRate: 48_000,
        channelCount: 2,
        audioBitsPerSecond: 160_000,
      },
    });

    assert.equal(args.includes('scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2'), true);
    assert.equal(args.includes('60'), true);
    assert.equal(args.includes('120'), true);
    assert.equal(args.includes('10000k'), true);
  });

  it('builds FFmpeg args for 4K landscape and portrait relay output', () => {
    const landscape = createFfmpegArgs(destination, {
      video: {
        width: 3840,
        height: 2160,
        frameRate: 30,
        videoBitsPerSecond: 18_000_000,
      },
      audio: {
        sampleRate: 48_000,
        channelCount: 2,
        audioBitsPerSecond: 160_000,
      },
    });
    const portrait = createFfmpegArgs(destination, {
      video: {
        width: 2160,
        height: 3840,
        frameRate: 30,
        videoBitsPerSecond: 18_000_000,
      },
      audio: {
        sampleRate: 48_000,
        channelCount: 2,
        audioBitsPerSecond: 160_000,
      },
    });

    assert.equal(landscape.includes('scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2'), true);
    assert.equal(portrait.includes('scale=2160:3840:force_original_aspect_ratio=decrease,pad=2160:3840:(ow-iw)/2:(oh-ih)/2'), true);
    assert.equal(landscape.includes('18000k'), true);
  });

  it('bounds oversized relay video configs to 4K-class output', () => {
    const normalized = normalizeVideoConfig({
      width: 3840,
      height: 3840,
      frameRate: 120,
      videoBitsPerSecond: 50_000_000,
    });

    assert.ok(normalized.width * normalized.height <= 3840 * 2160);
    assert.equal(normalized.width % 2, 0);
    assert.equal(normalized.height % 2, 0);
    assert.equal(normalized.frameRate, 60);
    assert.equal(normalized.videoBitsPerSecond, 24_000_000);
  });
});
