import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Participant } from '@studio/shared';
import { applyParticipantMediaState, withLocalMediaChoice } from '../src/utils/joinMediaState.ts';
import { replaceFallbackMediaTrack } from '../src/utils/mediaDeviceFallback.ts';

function participant(): Participant {
  return {
    id: 'local', name: 'Local', role: 'guest', status: 'on-stage',
    audioEnabled: true, videoEnabled: true, screenSharing: false, joinedAt: '',
  };
}

function track(kind: 'audio' | 'video', enabled = true): MediaStreamTrack {
  return { kind, enabled, readyState: 'live', stop() {} } as MediaStreamTrack;
}

function stream(audio: MediaStreamTrack, video: MediaStreamTrack): MediaStream {
  const tracks = [audio, video];
  return {
    getAudioTracks: () => tracks.filter((item) => item.kind === 'audio'),
    getVideoTracks: () => tracks.filter((item) => item.kind === 'video'),
    removeTrack: (removed) => tracks.splice(tracks.indexOf(removed), 1),
    addTrack: (added) => tracks.push(added),
  } as MediaStream;
}

function synchronize(current: Participant, media: MediaStream) {
  applyParticipantMediaState(current, media,
    (enabled) => { media.getAudioTracks()[0].enabled = enabled; },
    (enabled) => { media.getVideoTracks()[0].enabled = enabled; });
}

describe('participant media state after device replacement', () => {
  for (const kind of ['audio', 'video'] as const) {
    for (const automatic of [false, true]) {
      it(`keeps ${kind} off after a local toggle and ${automatic ? 'automatic fallback' : 'manual device switch'}`, () => {
        const audio = track('audio');
        const video = track('video');
        const media = stream(audio, video);
        const previous = kind === 'audio' ? audio : video;
        previous.enabled = false; // toggleAudio/toggleVideo changes the actual track.
        const current = withLocalMediaChoice(participant(), kind, false);

        const replacement = track(kind);
        if (automatic) {
          replaceFallbackMediaTrack(media, previous, replacement);
        } else {
          replacement.enabled = previous.enabled;
          media.removeTrack(previous);
          media.addTrack(replacement);
        }
        synchronize(current, media);

        assert.equal(replacement.enabled, false);
        assert.equal(kind === 'audio' ? current.audioEnabled : current.videoEnabled, false);
      });
    }
  }

  it('honors a host mute after an enabled device is replaced', () => {
    const audio = track('audio');
    const video = track('video');
    const media = stream(audio, video);
    const remotelyMuted = { ...participant(), audioEnabled: false, videoEnabled: false };

    synchronize(remotelyMuted, media);

    assert.equal(audio.enabled, false);
    assert.equal(video.enabled, false);
  });

  it('does not disturb the camera when the host changes only microphone state', () => {
    const audio = track('audio');
    const video = track('video');
    const media = stream(audio, video);

    synchronize({ ...participant(), audioEnabled: false }, media);

    assert.equal(audio.enabled, false);
    assert.equal(video.enabled, true);
  });

  it('mutes both raw camera capture and a separate virtual-background output track', () => {
    const rawVideo = track('video');
    const processedVideo = track('video');
    const audio = track('audio');
    const media = stream(audio, processedVideo);
    rawVideo.enabled = false; // The device toggle changes the raw capture track.
    const current = withLocalMediaChoice(participant(), 'video', false);

    applyParticipantMediaState(current, media,
      (enabled) => { audio.enabled = enabled; },
      (enabled) => { rawVideo.enabled = enabled; });

    assert.equal(rawVideo.enabled, false);
    assert.equal(processedVideo.enabled, false);
    assert.equal(current.videoEnabled, false);
  });

  it('resumes a separate virtual-background output when the camera is explicitly turned on', () => {
    const rawVideo = track('video', true);
    const processedVideo = track('video', false);
    const audio = track('audio');
    const media = stream(audio, processedVideo);
    const current = withLocalMediaChoice({ ...participant(), videoEnabled: false }, 'video', true);

    applyParticipantMediaState(current, media,
      (enabled) => { audio.enabled = enabled; },
      (enabled) => { rawVideo.enabled = enabled; });

    assert.equal(rawVideo.enabled, true);
    assert.equal(processedVideo.enabled, true);
  });
});
