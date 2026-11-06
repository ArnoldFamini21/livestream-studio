import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Participant } from '@studio/shared';
import {
  invitesToRevoke,
  isTransferParticipant,
  participantsToInvite,
  readyRequestTargets,
  trackAdmissionError,
} from '../src/utils/recordingTransferPolicy.ts';

const person = (id: string, role: Participant['role'], status: Participant['status']): Participant => (
  { id, name: id, role, status } as Participant
);

describe('recording transfer policy', () => {
  const host = person('host', 'host', 'on-stage');
  const coHost = person('co', 'co-host', 'backstage');
  const guest = person('guest', 'guest', 'on-stage');
  const backstage = person('back', 'guest', 'backstage');
  const waiting = person('waiting', 'guest', 'green-room');

  it('invites admitted participants only, never operators or the green room', () => {
    assert.equal(isTransferParticipant(guest), true);
    assert.equal(isTransferParticipant(backstage), true);
    assert.equal(isTransferParticipant(waiting), false);
    assert.equal(isTransferParticipant(host), false);
    assert.equal(isTransferParticipant(coHost), false);
    assert.deepEqual(participantsToInvite([host, coHost, guest, backstage, waiting], new Set(['back'])), ['guest']);
  });

  it('revokes invites for seats that left or went back to the green room', () => {
    const participants = new Map([[guest.id, guest], [waiting.id, waiting]]);
    assert.deepEqual(invitesToRevoke(participants, ['guest', 'waiting', 'gone']), ['waiting', 'gone']);
  });

  it('asks the operators for a fresh invite after a resumed seat', () => {
    const participants = [host, coHost, guest, waiting];
    assert.deepEqual(readyRequestTargets({ participant: guest, participants, resumed: true }), ['host', 'co']);
    assert.deepEqual(readyRequestTargets({ participant: guest, participants, resumed: false }), [], 'a new seat is invited on join');
    assert.deepEqual(readyRequestTargets({ participant: guest, participants }), []);
    assert.deepEqual(readyRequestTargets({ participant: waiting, participants, resumed: true }), [], 'the green room never asks');
    assert.deepEqual(readyRequestTargets({ participant: host, participants, resumed: true }), [], 'operators are not invited');
  });

  it('caps how many tracks and recordings one participant may write', () => {
    const limits = { maxTracks: 2, maxSessions: 1, maxBytes: 1_000 };
    const entries = [
      { id: 'a', participantId: 'guest', announcement: { sessionId: 's1' } },
      { id: 'x', participantId: 'other', announcement: { sessionId: 's9' } },
    ];
    assert.equal(trackAdmissionError(entries, 'guest', { id: 'b', sessionId: 's1' }, limits), null);
    assert.match(trackAdmissionError(entries, 'guest', { id: 'b', sessionId: 's2' }, limits) || '', /more recordings/);
    assert.equal(trackAdmissionError(entries, 'guest', { id: 'a', sessionId: 's1' }, limits), null, 'a known track is always accepted');
    const full = [...entries, { id: 'b', participantId: 'guest', announcement: { sessionId: 's1' } }];
    assert.match(trackAdmissionError(full, 'guest', { id: 'c', sessionId: 's1' }, limits) || '', /more tracks/);
    assert.equal(trackAdmissionError(full, 'other', { id: 'y', sessionId: 's9' }, limits), null, 'caps are per participant');
  });
});
