import assert from 'node:assert/strict';
import test from 'node:test';
import type { RtmpRelayStartPayload } from '@studio/shared';
import { admitSecondaryProgram, getDualOutputIssue, isDualOutputSupported } from './dualOutput.js';
import { countActiveRelaySessions } from './relayAdmission.js';
import { isSameRelaySetup } from './relayResume.js';

function payload(role: 'primary' | 'secondary'): RtmpRelayStartPayload {
  const primary = role === 'primary';
  const orientation = primary ? 'landscape' : 'portrait';
  return {
    token: 'token',
    dualOutput: role,
    dualOutputId: 'studio-broadcast-uuid',
    orientation,
    destinations: [{ id: role, name: role, rtmpUrl: 'rtmp://example.org/live', streamKey: role, orientation }],
    video: { width: primary ? 1280 : 720, height: primary ? 720 : 1280, frameRate: 30, videoBitsPerSecond: 2_500_000 },
    audio: { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 160_000 },
    encoding: { container: 'matroska', videoCodec: 'h264', audioCodec: 'opus', keyframeIntervalMs: 1_000 },
  };
}

test('dual output requires encode-once, two destinations, copy H.264 and matching routes', () => {
  assert.equal(isDualOutputSupported({ RTMP_ENCODE_ONCE: 'false' }), false);
  assert.equal(isDualOutputSupported({ RTMP_MAX_DESTINATIONS: '1' }), false);
  assert.equal(isDualOutputSupported({ RTMP_DUAL_OUTPUT: '0' }), false);
  assert.equal(isDualOutputSupported({}), true);

  const second = payload('secondary');
  assert.equal(getDualOutputIssue(second), null);
  assert.match(getDualOutputIssue({ ...second, test: true }) || '', /Private test/);
  assert.match(getDualOutputIssue({ ...second, encoding: undefined }) || '', /H.264/);
  assert.match(getDualOutputIssue({ ...second, dualOutputId: 'short' }) || '', /one broadcast/);
  assert.match(getDualOutputIssue({ ...second, orientation: 'landscape' }) || '', /upload size/);
  assert.match(getDualOutputIssue({ ...second, destinations: [{ ...second.destinations[0], orientation: 'landscape' }] }) || '', /destination/);
  assert.match(getDualOutputIssue({ ...second, video: { ...second.video, width: 1080, height: 1920 } }) || '', /720p/);
});

test('secondary belongs to the live host and group, with both programs sharing the destination cap', () => {
  const claims = { roomId: 'studio', participantId: 'host' };
  const main = { started: true, stopping: false, clientGone: false, claims, payload: payload('primary') };
  const second = payload('secondary');
  const activeSecond = { ...main, payload: second };
  const pending = { ...main, started: false };

  assert.deepEqual(admitSecondaryProgram([main, pending], pending, claims, second, 2), { ok: true, primary: main });
  assert.equal(admitSecondaryProgram([main], pending, { ...claims, participantId: 'other' }, second).ok, false);
  assert.equal(admitSecondaryProgram([main], pending, { ...claims, roomId: 'other' }, second).ok, false);
  assert.equal(admitSecondaryProgram([main], pending, claims, { ...second, dualOutputId: 'other-broadcast-uuid' }).ok, false);
  assert.equal(admitSecondaryProgram([{ ...main, clientGone: true }], pending, claims, second).ok, false);
  assert.equal(admitSecondaryProgram([main, activeSecond], pending, claims, second).ok, false);
  assert.equal(admitSecondaryProgram([main], pending, claims, second, 1).ok, false);
  assert.equal(admitSecondaryProgram([main], pending, claims, { ...second, orientation: 'landscape' }).ok, false);
  assert.equal(admitSecondaryProgram([main], pending, claims, {
    ...second, destinations: [{ ...second.destinations[0], rtmpUrl: 'rtmp://example.org/live/', streamKey: '/primary' }],
  }).ok, false);
  assert.equal(countActiveRelaySessions([main, { ...activeSecond, secondaryOf: main }, main]), 1);
});

test('a main program can resume after a page reload without dropping dual-output settings', () => {
  const main = payload('primary');
  assert.equal(isSameRelaySetup(main, { ...main, dualOutputId: 'new-studio-broadcast-uuid' }), true);
  assert.equal(isSameRelaySetup(main, { ...main, dualOutput: undefined, dualOutputId: undefined, orientation: undefined }), false);
});
