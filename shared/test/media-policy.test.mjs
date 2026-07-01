import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canExchangeStudioMedia } from '../dist/index.js';

const participant = (role, status) => ({ role, status });

describe('studio media routing policy', () => {
  it('allows public stage media between on-stage participants', () => {
    assert.equal(canExchangeStudioMedia(participant('host', 'on-stage'), participant('guest', 'on-stage')), true);
    assert.equal(canExchangeStudioMedia(participant('guest', 'on-stage'), participant('guest', 'on-stage')), true);
  });

  it('keeps green-room participants isolated from media exchange', () => {
    assert.equal(canExchangeStudioMedia(participant('host', 'on-stage'), participant('guest', 'green-room')), false);
    assert.equal(canExchangeStudioMedia(participant('guest', 'green-room'), participant('host', 'on-stage')), false);
    assert.equal(canExchangeStudioMedia(participant('host', 'green-room'), participant('guest', 'backstage')), false);
  });

  it('allows private backstage media with operators and other backstage guests', () => {
    assert.equal(canExchangeStudioMedia(participant('host', 'on-stage'), participant('guest', 'backstage')), true);
    assert.equal(canExchangeStudioMedia(participant('guest', 'backstage'), participant('host', 'on-stage')), true);
    assert.equal(canExchangeStudioMedia(participant('co-host', 'backstage'), participant('guest', 'backstage')), true);
    assert.equal(canExchangeStudioMedia(participant('guest', 'backstage'), participant('guest', 'backstage')), true);
  });

  it('blocks regular stage guests from backstage private media', () => {
    assert.equal(canExchangeStudioMedia(participant('guest', 'on-stage'), participant('guest', 'backstage')), false);
    assert.equal(canExchangeStudioMedia(participant('guest', 'backstage'), participant('guest', 'on-stage')), false);
  });
});
