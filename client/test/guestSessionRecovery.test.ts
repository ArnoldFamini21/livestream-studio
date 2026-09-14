import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Participant } from '@studio/shared';
import { withLocalJoinMedia } from '../src/utils/joinMediaState.ts';
import { shouldReconnectSignaling } from '../src/utils/signalingRecovery.ts';

const participant = { id: 'guest', audioEnabled: true, videoEnabled: true, role: 'guest', status: 'backstage' } as Participant;
function stream(audio: boolean, video: boolean, readyState = 'live') {
  return { getAudioTracks: () => [{ enabled: audio, readyState }], getVideoTracks: () => [{ enabled: video, readyState }] } as unknown as MediaStream;
}
test('join and rejoin preserve muted camera and microphone despite server defaults', () => {
  const joined = withLocalJoinMedia(participant, stream(false, false));
  assert.equal(joined.audioEnabled, false);
  assert.equal(joined.videoEnabled, false);
  assert.equal(joined.status, participant.status);
  assert.equal(participant.audioEnabled, true);
});
test('audio-only choices and unavailable devices stay accurate', () => {
  assert.deepEqual(withLocalJoinMedia(participant, stream(true, false)), { ...participant, videoEnabled: false });
  assert.deepEqual(withLocalJoinMedia(participant, null), { ...participant, audioEnabled: false, videoEnabled: false });
  assert.deepEqual(withLocalJoinMedia(participant, stream(true, true, 'ended')), { ...participant, audioEnabled: false, videoEnabled: false });
});
test('service restarts and network failures reconnect even after a clean close', () => {
  for (const code of [1001, 1006, 1011, 1012, 1013]) assert.equal(shouldReconnectSignaling(code, false), true);
});
test('intentional departures, moderation and replaced hosts do not reconnect', () => {
  for (const code of [1000, 1008, 4000, 4001, 4401, 4403]) assert.equal(shouldReconnectSignaling(code, false), false);
  assert.equal(shouldReconnectSignaling(1001, true), false);
});
