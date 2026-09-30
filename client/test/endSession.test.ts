import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RecordingUploadProgressPayload } from '@studio/shared';
import {
  describePendingGuestUploads,
  getEndSessionPrompt,
  getPendingGuestUploads,
} from '../src/utils/endSession.ts';

function report(overrides: Partial<RecordingUploadProgressPayload>): RecordingUploadProgressPayload {
  return {
    sessionId: 'session-1',
    participantId: 'guest-1',
    participantName: 'Nica',
    status: 'uploading',
    recordedBytes: 1000,
    uploadedBytes: 500,
    trackCount: 2,
    completedTrackCount: 0,
    ...overrides,
  };
}

describe('end session prompt', () => {
  it('names what ending stops, most serious first', () => {
    assert.equal(getEndSessionPrompt({ isLive: true, isRecording: true, otherParticipantCount: 2 }).title, 'End the broadcast and the recording?');
    assert.equal(getEndSessionPrompt({ isLive: true, isRecording: false, otherParticipantCount: 0 }).confirmLabel, 'End broadcast');
    assert.equal(getEndSessionPrompt({ isLive: false, isRecording: true, otherParticipantCount: 1 }).confirmLabel, 'Save and end');
    assert.equal(getEndSessionPrompt({ isLive: false, isRecording: false, otherParticipantCount: 0 }).title, 'End the session?');
  });

  it('says who else leaves', () => {
    assert.match(getEndSessionPrompt({ isLive: false, isRecording: false, otherParticipantCount: 1 }).message, /1 other person/);
    assert.match(getEndSessionPrompt({ isLive: true, isRecording: false, otherParticipantCount: 3 }).message, /3 other people/);
    assert.doesNotMatch(getEndSessionPrompt({ isLive: true, isRecording: false, otherParticipantCount: 0 }).message, /other/);
  });
});

describe('pending guest uploads', () => {
  const present = new Set(['guest-1', 'guest-2']);

  it('waits only for unfinished uploads of the stopped session from people still here', () => {
    const uploads = {
      'guest-1': report({}),
      'guest-2': report({ participantId: 'guest-2', status: 'complete' }),
      'guest-3': report({ participantId: 'guest-3', participantName: 'Gone' }),
      'guest-4': report({ participantId: 'guest-4', sessionId: 'older-session' }),
    };
    const pending = getPendingGuestUploads(uploads, 'session-1', new Set([...present, 'guest-4']));
    assert.deepEqual(pending.map((entry) => entry.participantId), ['guest-1']);
  });

  it('treats paused and finishing uploads as unfinished, failed ones as settled', () => {
    for (const status of ['paused', 'finishing'] as const) {
      assert.equal(getPendingGuestUploads({ 'guest-1': report({ status }) }, 'session-1', present).length, 1);
    }
    assert.equal(getPendingGuestUploads({ 'guest-1': report({ status: 'error' }) }, 'session-1', present).length, 0);
  });

  it('waits for nothing without a session', () => {
    assert.deepEqual(getPendingGuestUploads({ 'guest-1': report({}) }, null, present), []);
  });

  it('describes who is still uploading', () => {
    assert.match(describePendingGuestUploads([report({})]), /^Nica's recording is still uploading/);
    assert.match(describePendingGuestUploads([report({}), report({ participantName: 'Ben' })]), /^Nica's and Ben's recordings are/);
    assert.match(describePendingGuestUploads([report({}), report({}), report({})]), /^3 guests' recordings are/);
    assert.match(describePendingGuestUploads([report({ participantName: undefined })]), /^A guest's recording/);
  });
});
