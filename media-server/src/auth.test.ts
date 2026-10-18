import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  signLiveStreamToken,
  verifyLiveStreamToken,
  verifyRecordingUploadToken,
  verifySfuToken,
} from './auth.js';

const SECRET = 'purpose-scoping-test-secret-at-least-32-characters';
const NOW = 1_800_000_000_000;
const BASE_CLAIMS = {
  v: 1 as const,
  roomId: 'room-one',
  participantId: 'operator-one',
  role: 'co-host' as const,
  nonce: 'nonce-one',
  exp: NOW + 6 * 60 * 60_000,
};

describe('media token purpose isolation', () => {
  it('continues accepting the existing host live-stream token format', () => {
    const token = signLiveStreamToken(BASE_CLAIMS, SECRET);
    assert.deepEqual(verifyLiveStreamToken(token, SECRET, NOW), BASE_CLAIMS);
  });

  it('does not grant privileged live or full-room recording access with an upload token', () => {
    const claims = {
      ...BASE_CLAIMS,
      purpose: 'recording-upload' as const,
      participantName: 'Operator One',
      sessionId: 'take-one',
    };
    const token = signLiveStreamToken(claims, SECRET);
    assert.deepEqual(verifyRecordingUploadToken(token, SECRET, NOW), claims);
    assert.throws(() => verifyLiveStreamToken(token, SECRET, NOW), /Invalid live stream token claims/);
    assert.throws(() => verifyLiveStreamToken(token, SECRET, NOW + 60 * 60_000), /Invalid live stream token claims/);
  });

  it('does not grant privileged live or recording access with an SFU token', () => {
    const claims = { ...BASE_CLAIMS, purpose: 'sfu' as const };
    const token = signLiveStreamToken(claims, SECRET);
    assert.deepEqual(verifySfuToken(token, SECRET, NOW), claims);
    assert.throws(() => verifyLiveStreamToken(token, SECRET, NOW), /Invalid live stream token claims/);
    assert.throws(() => verifyRecordingUploadToken(token, SECRET, NOW), /Invalid recording upload token claims/);
  });
});
