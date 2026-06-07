import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LiveStreamTokenClaims, RtmpRelayDestination } from '@studio/shared';
import { signLiveStreamToken, verifyLiveStreamToken } from './auth.js';
import {
  buildRtmpOutputUrl,
  createFfmpegArgs,
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
});
