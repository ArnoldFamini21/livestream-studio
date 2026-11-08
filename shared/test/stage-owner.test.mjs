import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getStageOwnerId, isValidProgramReturnStreamId } from '../dist/index.js';

const person = (id, role, status = 'on-stage', joinedAt = '2026-11-07T10:00:00.000Z') => ({ id, role, status, joinedAt });

describe('stage owner', () => {
  it('is the host whenever the host is in the studio', () => {
    assert.equal(getStageOwnerId([
      person('co', 'co-host', 'on-stage', '2026-11-07T09:00:00.000Z'),
      person('guest', 'guest'),
      person('host', 'host', 'on-stage', '2026-11-07T11:00:00.000Z'),
    ]), 'host');
  });

  it('falls back to the co-host who joined first, ignoring the green room', () => {
    assert.equal(getStageOwnerId([
      person('late', 'co-host', 'on-stage', '2026-11-07T10:05:00.000Z'),
      person('early', 'co-host', 'backstage', '2026-11-07T10:01:00.000Z'),
      person('waiting', 'co-host', 'green-room', '2026-11-07T09:00:00.000Z'),
    ]), 'early');
    assert.equal(getStageOwnerId([person('b', 'co-host'), person('a', 'co-host')]), 'a', 'ties break by id');
  });

  it('is nobody without an admitted host or co-host', () => {
    assert.equal(getStageOwnerId([person('guest', 'guest'), person('host', 'host', 'green-room')]), null);
    assert.equal(getStageOwnerId([]), null);
  });
});

describe('program return stream ids', () => {
  it('accepts Chrome and Firefox MediaStream ids only', () => {
    assert.equal(isValidProgramReturnStreamId('3f1c2a7e-8b1d-4d7a-9a51-0f6c3e2b1d4a'), true);
    assert.equal(isValidProgramReturnStreamId('{3f1c2a7e-8b1d-4d7a-9a51-0f6c3e2b1d4a}'), true);
    assert.equal(isValidProgramReturnStreamId(''), false);
    assert.equal(isValidProgramReturnStreamId('a b'), false);
    assert.equal(isValidProgramReturnStreamId('x'.repeat(81)), false);
    assert.equal(isValidProgramReturnStreamId(42), false);
  });
});
