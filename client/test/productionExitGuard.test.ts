import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getProductionExitGuardDecision } from '../src/utils/productionExitGuard.ts';

describe('production exit guard', () => {
  it('does not block when the room is idle', () => {
    assert.deepEqual(getProductionExitGuardDecision({
      isLive: false,
      isMixedRecording: false,
      isLocalRecording: false,
      isSessionRecording: false,
    }), {
      shouldBlock: false,
      reason: null,
      message: '',
    });
  });

  it('blocks browser exits while live', () => {
    assert.deepEqual(getProductionExitGuardDecision({
      isLive: true,
      isMixedRecording: false,
      isLocalRecording: false,
      isSessionRecording: false,
    }), {
      shouldBlock: true,
      reason: 'live',
      message: 'A live stream is active. Leaving now may stop the broadcast.',
    });
  });

  it('blocks browser exits for every recording mode', () => {
    for (const state of [
      { isMixedRecording: true, isLocalRecording: false, isSessionRecording: false },
      { isMixedRecording: false, isLocalRecording: true, isSessionRecording: false },
      { isMixedRecording: false, isLocalRecording: false, isSessionRecording: true },
    ]) {
      assert.deepEqual(getProductionExitGuardDecision({
        isLive: false,
        ...state,
      }), {
        shouldBlock: true,
        reason: 'recording',
        message: 'A recording is active. Leaving now may lose recording chunks.',
      });
    }
  });

  it('prioritizes the combined warning when live and recording', () => {
    assert.deepEqual(getProductionExitGuardDecision({
      isLive: true,
      isMixedRecording: false,
      isLocalRecording: true,
      isSessionRecording: false,
    }), {
      shouldBlock: true,
      reason: 'live-and-recording',
      message: 'Live streaming and recording are active. Leaving now may stop the broadcast or lose recording chunks.',
    });
  });
});
