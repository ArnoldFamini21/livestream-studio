import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Participant } from '@studio/shared';
import {
  mergeSfuMediaWithMeshFallback,
  shouldUseSfuMedia,
} from '../src/utils/sfuRuntime.ts';

function participant(id: string, status: Participant['status'] = 'on-stage'): Participant {
  return {
    id,
    name: id,
    role: id === 'host' ? 'host' : 'guest',
    status,
    audioEnabled: true,
    videoEnabled: true,
    screenSharing: false,
    joinedAt: new Date(0).toISOString(),
  };
}

function track(kind: 'audio' | 'video', id: string): MediaStreamTrack {
  return { kind, id, readyState: 'live' } as MediaStreamTrack;
}

function stream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter((item) => item.kind === 'video'),
  } as MediaStream;
}

describe('shouldUseSfuMedia', () => {
  it('enables SFU video for five on-stage participants when the media server is ready', () => {
    assert.equal(shouldUseSfuMedia({
      localParticipant: participant('host'),
      remoteParticipants: [participant('a'), participant('b'), participant('c'), participant('d')],
      mediaServerReady: true,
    }), true);
  });

  it('keeps mesh for smaller stages, unavailable media, and backstage participants', () => {
    const remotes = [participant('a'), participant('b'), participant('c'), participant('d')];
    assert.equal(shouldUseSfuMedia({ localParticipant: participant('host'), remoteParticipants: remotes.slice(0, 3), mediaServerReady: true }), false);
    assert.equal(shouldUseSfuMedia({ localParticipant: participant('host'), remoteParticipants: remotes, mediaServerReady: false }), false);
    assert.equal(shouldUseSfuMedia({ localParticipant: participant('host', 'backstage'), remoteParticipants: remotes, mediaServerReady: true }), false);
    assert.equal(shouldUseSfuMedia({
      localParticipant: participant('host'),
      remoteParticipants: [participant('a'), participant('b'), participant('c'), participant('d', 'backstage')],
      mediaServerReady: true,
    }), false);
  });
});

describe('mergeSfuMediaWithMeshFallback', () => {
  it('combines SFU video with mesh audio and leaves mesh-only peers untouched', () => {
    const meshVideo = track('video', 'mesh-video');
    const meshAudio = track('audio', 'mesh-audio');
    const sfuVideo = track('video', 'sfu-video');
    const meshAlice = stream([meshVideo, meshAudio]);
    const meshBob = stream([track('video', 'bob-video'), track('audio', 'bob-audio')]);
    const created: MediaStreamTrack[][] = [];

    const merged = mergeSfuMediaWithMeshFallback(
      new Map([['alice', meshAlice], ['bob', meshBob]]),
      new Map([['alice', stream([sfuVideo])]]),
      (tracks) => {
        created.push(tracks);
        return stream(tracks);
      }
    );

    assert.deepEqual(created, [[sfuVideo, meshAudio]]);
    assert.deepEqual(merged.get('alice')?.getVideoTracks(), [sfuVideo]);
    assert.deepEqual(merged.get('alice')?.getAudioTracks(), [meshAudio]);
    assert.equal(merged.get('bob'), meshBob);
  });

  it('falls back to mesh until a live SFU video track exists', () => {
    const mesh = stream([track('video', 'mesh-video'), track('audio', 'mesh-audio')]);
    const endedVideo = { kind: 'video', id: 'ended', readyState: 'ended' } as MediaStreamTrack;
    const merged = mergeSfuMediaWithMeshFallback(
      new Map([['alice', mesh]]),
      new Map([['alice', stream([endedVideo])]])
    );
    assert.equal(merged.get('alice'), mesh);
  });

  it('uses SFU audio with mesh video for audio-only producers', () => {
    const meshVideo = track('video', 'mesh-video');
    const meshAudio = track('audio', 'mesh-audio');
    const sfuAudio = track('audio', 'sfu-audio');
    const merged = mergeSfuMediaWithMeshFallback(
      new Map([['alice', stream([meshVideo, meshAudio])]]),
      new Map([['alice', stream([sfuAudio])]]),
      stream
    );

    assert.deepEqual(merged.get('alice')?.getVideoTracks(), [meshVideo]);
    assert.deepEqual(merged.get('alice')?.getAudioTracks(), [sfuAudio]);
  });
});
