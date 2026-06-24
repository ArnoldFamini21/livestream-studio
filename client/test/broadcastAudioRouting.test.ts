import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_BROADCAST_AUDIO_ROUTING,
  normalizeBroadcastAudioRouting,
} from '../src/utils/broadcastAudioRouting.ts';

describe('broadcast audio routing', () => {
  it('defaults producer audio to both stream and monitor', () => {
    assert.deepEqual(normalizeBroadcastAudioRouting(), DEFAULT_BROADCAST_AUDIO_ROUTING);
  });

  it('preserves explicit stream-only routing', () => {
    assert.deepEqual(normalizeBroadcastAudioRouting({
      stream: true,
      monitor: false,
    }), {
      stream: true,
      monitor: false,
    });
  });

  it('preserves explicit monitor-only routing', () => {
    assert.deepEqual(normalizeBroadcastAudioRouting({
      stream: false,
      monitor: true,
    }), {
      stream: false,
      monitor: true,
    });
  });
});
