import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Participant } from '@studio/shared';
import type { LocalRecordingSource } from '../src/hooks/useLocalRecording.ts';
import {
  buildLocalRecordingSources,
  getRecordingSourceId,
} from '../src/utils/localRecordingSources.ts';

class FakeMediaStream {
  private readonly tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}

function track(id: string, kind: 'audio' | 'video', readyState: MediaStreamTrackState = 'live'): MediaStreamTrack {
  return {
    id,
    kind,
    readyState,
  } as unknown as MediaStreamTrack;
}

function stream(...tracks: MediaStreamTrack[]): MediaStream {
  return new FakeMediaStream(tracks) as unknown as MediaStream;
}

function participant(input: Partial<Participant> & Pick<Participant, 'id' | 'name'>): Participant {
  return {
    role: 'guest',
    audioEnabled: true,
    videoEnabled: true,
    screenSharing: false,
    joinedAt: '2026-06-11T10:00:00.000Z',
    status: 'on-stage',
    ...input,
  };
}

describe('local recording source planner', () => {
  const originalMediaStream = globalThis.MediaStream;

  beforeEach(() => {
    globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;
  });

  afterEach(() => {
    globalThis.MediaStream = originalMediaStream;
  });

  it('sanitizes participant ids for stable recording source ids', () => {
    assert.equal(getRecordingSourceId('guest/user 42!!!'), 'guest-user-42');
    assert.equal(getRecordingSourceId('***'), 'track');
    assert.equal(getRecordingSourceId('x'.repeat(80)), 'x'.repeat(64));
  });

  it('plans high-quality local and remote per-participant sources', () => {
    const programSource: LocalRecordingSource = {
      id: 'program-mix',
      label: 'Program mix',
      kind: 'program',
      stream: stream(track('program-video', 'video'), track('program-audio', 'audio')),
      bitsPerSecond: 10_000_000,
    };
    const localParticipant = participant({ id: 'host 1', name: 'Host', role: 'host' });
    const remoteParticipant = participant({ id: 'guest/alpha', name: 'Guest Alpha' });
    const greenRoomParticipant = participant({ id: 'guest-waiting', name: 'Waiting', status: 'green-room' });

    const sources = buildLocalRecordingSources({
      localParticipant,
      localStream: stream(track('local-video', 'video'), track('local-audio', 'audio')),
      participants: new Map([
        [remoteParticipant.id, remoteParticipant],
        [greenRoomParticipant.id, greenRoomParticipant],
      ]),
      remoteStreams: new Map([
        [remoteParticipant.id, stream(track('remote-video', 'video'), track('remote-audio', 'audio'))],
        [greenRoomParticipant.id, stream(track('waiting-video', 'video'), track('waiting-audio', 'audio'))],
      ]),
      screenStream: null,
      isScreenSharing: false,
      programSource,
    });

    assert.deepEqual(
      sources.map((source) => [source.id, source.label, source.kind, source.bitsPerSecond]),
      [
        ['program-mix', 'Program mix', 'program', 10_000_000],
        ['host-1-iso', 'Host ISO', 'iso', 8_500_000],
        ['host-1-audio', 'Host audio', 'audio', 256_000],
        ['host-1-camera', 'Host camera', 'video', 8_000_000],
        ['guest-alpha-iso', 'Guest Alpha ISO', 'iso', 8_500_000],
        ['guest-alpha-audio', 'Guest Alpha audio', 'audio', 256_000],
        ['guest-alpha-camera', 'Guest Alpha camera', 'video', 8_000_000],
      ]
    );
    assert.equal(sources.find((source) => source.id === 'host-1-iso')?.stream.getTracks().length, 2);
    assert.equal(sources.find((source) => source.id === 'guest-alpha-camera')?.stream.getVideoTracks().length, 1);
  });

  it('records screen-share participants as screen/video tracks without duplicate ISO', () => {
    const screenParticipant = participant({
      id: 'guest-screen',
      name: 'Guest Screen',
      screenSharing: true,
    });

    const sources = buildLocalRecordingSources({
      localParticipant: participant({ id: 'host', name: 'Host', status: 'backstage', role: 'host' }),
      localStream: stream(track('local-video', 'video'), track('local-audio', 'audio')),
      participants: new Map([[screenParticipant.id, screenParticipant]]),
      remoteStreams: new Map([[screenParticipant.id, stream(track('screen-video', 'video'), track('screen-audio', 'audio'))]]),
      screenStream: null,
      isScreenSharing: false,
    });

    assert.deepEqual(
      sources.map((source) => [source.id, source.kind]),
      [
        ['guest-screen-audio', 'audio'],
        ['guest-screen-screen', 'screen'],
      ]
    );
  });

  it('adds local screen share and PiP sources when the host is sharing', () => {
    const pipSource: LocalRecordingSource = {
      id: 'host-screen-pip',
      label: 'Host screen PiP',
      kind: 'screen',
      stream: stream(track('pip-video', 'video'), track('pip-audio', 'audio')),
      bitsPerSecond: 8_500_000,
    };
    const pipRequests: unknown[] = [];

    const sources = buildLocalRecordingSources({
      localParticipant: participant({ id: 'host', name: 'Host', role: 'host' }),
      localStream: stream(track('local-video', 'video'), track('local-audio', 'audio')),
      participants: new Map(),
      remoteStreams: new Map(),
      screenStream: stream(track('screen-video', 'video'), track('screen-audio', 'audio')),
      isScreenSharing: true,
      createScreenPictureInPictureSource: (request) => {
        pipRequests.push(request);
        return pipSource;
      },
    });

    assert.deepEqual(
      sources.map((source) => [source.id, source.kind]),
      [
        ['host-iso', 'iso'],
        ['host-audio', 'audio'],
        ['host-camera', 'video'],
        ['host-screen', 'screen'],
        ['host-screen-pip', 'screen'],
        ['host-screen-audio', 'audio'],
      ]
    );
    assert.equal(pipRequests.length, 1);
  });

  it('skips ended tracks and returns no participant sources when nobody is on stage', () => {
    const sources = buildLocalRecordingSources({
      localParticipant: participant({ id: 'host', name: 'Host', role: 'host', status: 'green-room' }),
      localStream: stream(track('ended-video', 'video', 'ended'), track('ended-audio', 'audio', 'ended')),
      participants: new Map(),
      remoteStreams: new Map(),
      screenStream: stream(track('ended-screen', 'video', 'ended')),
      isScreenSharing: true,
    });

    assert.deepEqual(sources, []);
  });
});

