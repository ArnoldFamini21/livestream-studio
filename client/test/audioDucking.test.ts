import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIO_DUCKING_ATTENUATION,
  getAudioDuckingSpeakerId,
  getDuckedParticipantVolumes,
} from '../src/utils/audioDucking.ts';

describe('audio ducking policy', () => {
  it('selects a dominant speaker above the trigger threshold', () => {
    assert.equal(
      getAudioDuckingSpeakerId({
        participantAudioLevels: { host: 12, guest: 34, producer: 7 },
      }),
      'guest'
    );
  });

  it('does not duck when speakers are too close in level', () => {
    assert.equal(
      getAudioDuckingSpeakerId({
        participantAudioLevels: { host: 31, guest: 29, producer: 4 },
      }),
      null
    );
  });

  it('keeps base volumes when disabled or below threshold', () => {
    assert.deepEqual(
      getDuckedParticipantVolumes({
        enabled: false,
        participantVolumes: { host: 0.8, guest: 0.6 },
        participantAudioLevels: { host: 42, guest: 3 },
      }),
      { host: 0.8, guest: 0.6 }
    );

    assert.deepEqual(
      getDuckedParticipantVolumes({
        enabled: true,
        participantVolumes: { host: 0.8, guest: 0.6 },
        participantAudioLevels: { host: 12, guest: 3 },
      }),
      { host: 0.8, guest: 0.6 }
    );
  });

  it('attenuates non-speaking participants while preserving manual mix levels', () => {
    const volumes = getDuckedParticipantVolumes({
      enabled: true,
      participantVolumes: { host: 0.9, guest: 0.5, producer: 0 },
      participantAudioLevels: { host: 46, guest: 8, producer: 2 },
    });

    assert.equal(volumes.host, 0.9);
    assert.equal(volumes.guest, Math.round(0.5 * AUDIO_DUCKING_ATTENUATION * 1000) / 1000);
    assert.equal(volumes.producer, 0);
  });
});
