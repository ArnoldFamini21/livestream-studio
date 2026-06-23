import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canControlStudioRecording,
  canUseAdmittedOperatorControls,
  isStudioOperator,
} from '../src/utils/studioAccess.ts';

describe('studio access helpers', () => {
  it('treats hosts and co-hosts as studio operators', () => {
    assert.equal(isStudioOperator({ role: 'host' }), true);
    assert.equal(isStudioOperator({ role: 'co-host' }), true);
    assert.equal(isStudioOperator({ role: 'guest' }), false);
    assert.equal(isStudioOperator(null), false);
  });

  it('allows admitted hosts and co-hosts to use operator controls', () => {
    assert.equal(canUseAdmittedOperatorControls({ role: 'host', status: 'on-stage' }), true);
    assert.equal(canUseAdmittedOperatorControls({ role: 'co-host', status: 'backstage' }), true);
  });

  it('keeps green-room operators and guests out of recording controls', () => {
    assert.equal(canControlStudioRecording({ role: 'host', status: 'green-room' }), false);
    assert.equal(canControlStudioRecording({ role: 'co-host', status: 'green-room' }), false);
    assert.equal(canControlStudioRecording({ role: 'guest', status: 'on-stage' }), false);
    assert.equal(canControlStudioRecording(undefined), false);
  });
});
