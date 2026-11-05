import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIO_DUCKING_TRIGGER_LEVEL,
  INITIAL_MUSIC_DUCKING_STATE,
  MUSIC_DUCKING_HOLD_MS,
  getMusicDuckingReleaseDelay,
  isSpeechPresent,
  nextMusicDuckingState,
} from '../src/utils/audioDucking.ts';

describe('music ducking policy', () => {
  it('detects speech from anyone on stage, ignoring people off stage', () => {
    const levels = { host: 4, guest: AUDIO_DUCKING_TRIGGER_LEVEL + 10, backstage: 80 };
    assert.equal(isSpeechPresent(levels, ['host', 'guest']), true);
    assert.equal(isSpeechPresent(levels, ['host']), false);
    assert.equal(isSpeechPresent({ host: Number.NaN }, ['host']), false);
  });

  it('ducks on speech, holds between words, then releases', () => {
    let state = nextMusicDuckingState(INITIAL_MUSIC_DUCKING_STATE, { enabled: true, speaking: true, now: 1_000 });
    assert.equal(state.ducked, true);
    state = nextMusicDuckingState(state, { enabled: true, speaking: false, now: 1_000 + MUSIC_DUCKING_HOLD_MS / 2 });
    assert.equal(state.ducked, true);
    assert.equal(getMusicDuckingReleaseDelay(state, 1_000 + MUSIC_DUCKING_HOLD_MS / 2), MUSIC_DUCKING_HOLD_MS / 2);
    state = nextMusicDuckingState(state, { enabled: true, speaking: false, now: 1_000 + MUSIC_DUCKING_HOLD_MS });
    assert.equal(state.ducked, false);
    assert.equal(getMusicDuckingReleaseDelay(state, 5_000), null);
  });

  it('never ducks while disabled', () => {
    const ducked = nextMusicDuckingState(INITIAL_MUSIC_DUCKING_STATE, { enabled: true, speaking: true, now: 0 });
    assert.deepEqual(nextMusicDuckingState(ducked, { enabled: false, speaking: true, now: 10 }), INITIAL_MUSIC_DUCKING_STATE);
  });
});
