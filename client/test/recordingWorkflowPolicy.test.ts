import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { describeGuestTransfer, planParticipantRecording, shouldPauseOwnUploadWhileLive } from '../src/utils/recordingWorkflowPolicy.ts';
import { makeParticipantRecordingFileName } from '../src/utils/toolbarRecording.ts';
import { buildLosslessMicrophoneSource } from '../src/utils/localRecordingSources.ts';
import { describeTransfer } from '../src/components/RecordingDestinationPanel.tsx';

describe('participant recording plan', () => {
  it('keeps the host off the media-server when a recording folder takes the tracks', () => {
    assert.deepEqual(planParticipantRecording({ isOperator: true, hostFolderTake: true, invitedByHost: false, cloudUpload: false }),
      { progressiveUpload: false, uploadAfterStop: false, sendToHost: false });
    assert.deepEqual(planParticipantRecording({ isOperator: true, hostFolderTake: true, invitedByHost: false, cloudUpload: true }),
      { progressiveUpload: true, uploadAfterStop: true, sendToHost: false });
    assert.deepEqual(planParticipantRecording({ isOperator: true, hostFolderTake: false, invitedByHost: false, cloudUpload: false }),
      { progressiveUpload: true, uploadAfterStop: true, sendToHost: false });
  });

  it('sends a guest’s tracks peer-to-peer when the host collects them, with the cloud copy opt-in', () => {
    assert.deepEqual(planParticipantRecording({ isOperator: false, hostFolderTake: false, invitedByHost: true, cloudUpload: false }),
      { progressiveUpload: false, uploadAfterStop: false, sendToHost: true });
    assert.deepEqual(planParticipantRecording({ isOperator: false, hostFolderTake: false, invitedByHost: true, cloudUpload: true }),
      { progressiveUpload: true, uploadAfterStop: true, sendToHost: true });
    assert.deepEqual(planParticipantRecording({ isOperator: false, hostFolderTake: false, invitedByHost: false, cloudUpload: false }),
      { progressiveUpload: true, uploadAfterStop: true, sendToHost: false });
  });

  it('holds only the host’s own upload while live', () => {
    assert.equal(shouldPauseOwnUploadWhileLive({ isOperator: true, isLive: true }), true);
    assert.equal(shouldPauseOwnUploadWhileLive({ isOperator: true, isLive: false }), false);
    assert.equal(shouldPauseOwnUploadWhileLive({ isOperator: false, isLive: true }), false);
  });
});

describe('transfer progress wording', () => {
  it('tells guests where their recording is', () => {
    assert.equal(describeGuestTransfer({ state: 'sending', pendingTracks: 2, percent: 82 }, true), 'Sending your tracks to the host — 82%');
    assert.match(describeGuestTransfer({ state: 'waiting', pendingTracks: 1, percent: 40 }, true) || '', /safe in this browser/);
    assert.equal(describeGuestTransfer({ state: 'delivered', pendingTracks: 0, percent: 100 }, true), null);
    assert.equal(describeGuestTransfer({ state: 'sending', pendingTracks: 1, percent: 10 }, false), null);
  });

  it('shows per-guest progress to the host', () => {
    const base = { participantId: 'g', participantName: 'Maria', received: 82, available: 100, tracks: 2, completeTracks: 0, failedTracks: 0, connected: true };
    assert.equal(describeTransfer({ ...base, percent: 82 }), 'Receiving Maria\'s tracks — 82%');
    assert.equal(describeTransfer({ ...base, percent: 82, connected: false }), 'Receiving Maria\'s tracks — 82% (waiting to reconnect)');
    assert.equal(describeTransfer({ ...base, percent: 100, completeTracks: 2 }), 'Maria\'s tracks saved to your folder');
    assert.match(describeTransfer({ ...base, percent: 50, failedTracks: 1 }), /kept in their browser/);
  });
});

describe('unicode-safe participant file names', () => {
  it('keeps accented and non-Latin names', () => {
    const blob = new Blob([], { type: 'audio/webm' });
    assert.equal(makeParticipantRecordingFileName('José Niño', 'audio', 2, blob, '2026-11-05-21-30-00'), 'José_Niño_audio_2_2026-11-05-21-30-00.webm');
    assert.equal(makeParticipantRecordingFileName('王/小明', 'iso', 1, new Blob([], { type: 'video/webm' }), 't'), '王_小明_iso_1_t.webm');
    assert.equal(makeParticipantRecordingFileName('***', 'audio', 1, blob, 't'), 'participant_audio_1_t.webm');
  });
});

describe('lossless microphone source', () => {
  const originalMediaStream = globalThis.MediaStream;
  beforeEach(() => {
    globalThis.MediaStream = class {
      constructor(private readonly tracks: MediaStreamTrack[] = []) {}
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
      getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
    } as unknown as typeof MediaStream;
  });
  afterEach(() => { globalThis.MediaStream = originalMediaStream; });

  it('records the selected microphone as a WAV source while on stage', () => {
    const mic = { id: 'mic', kind: 'audio', readyState: 'live', getSettings: () => ({ deviceId: 'usb-mic' }) } as unknown as MediaStreamTrack;
    const stream = new MediaStream([mic]);
    const participant = { id: 'guest 1', name: 'María', status: 'on-stage' } as never;
    const source = buildLosslessMicrophoneSource({ localParticipant: participant, localStream: stream });
    assert.equal(source?.id, 'guest-1-wav');
    assert.equal(source?.format, 'wav');
    assert.equal(source?.rawDeviceId, 'usb-mic');
    assert.equal(source?.kind, 'audio');
    assert.equal(buildLosslessMicrophoneSource({ localParticipant: { ...(participant as object), status: 'backstage' } as never, localStream: stream }), null);
    assert.equal(buildLosslessMicrophoneSource({ localParticipant: participant, localStream: null }), null);
  });
});
