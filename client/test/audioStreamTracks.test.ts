import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLiveAudioTracks, hasLiveAudioTracks } from '../src/utils/audioStreamTracks.ts';

function streamWithTrackStates(states: MediaStreamTrackState[]) {
  return {
    getAudioTracks: () => states.map((readyState, index) => ({
      id: `track-${index}`,
      readyState,
    } as MediaStreamTrack)),
  };
}

describe('audio stream track helpers', () => {
  it('returns only live audio tracks', () => {
    const stream = streamWithTrackStates(['live', 'ended', 'live']);

    assert.deepEqual(getLiveAudioTracks(stream).map((track) => track.id), ['track-0', 'track-2']);
  });

  it('treats missing streams and ended tracks as silent', () => {
    assert.equal(hasLiveAudioTracks(null), false);
    assert.equal(hasLiveAudioTracks(streamWithTrackStates(['ended'])), false);
  });

  it('detects streams that can contribute to the broadcast mix', () => {
    assert.equal(hasLiveAudioTracks(streamWithTrackStates(['ended', 'live'])), true);
  });
});
