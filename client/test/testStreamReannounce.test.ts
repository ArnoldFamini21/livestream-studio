import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldReannounceTest, type TestReannounceInput } from '../src/utils/testStreamReannounce.ts';

const base: TestReannounceInput = { testRunningHere: true, relayActive: true, isHost: true, roomLive: false, serverKnowsTest: false };

describe('announcing a running test again after the host rejoins', () => {
  it('announces a test that is still running in this browser', () => {
    assert.equal(shouldReannounceTest(base), true);
  });

  it('never announces while the room is live', () => {
    assert.equal(shouldReannounceTest({ ...base, roomLive: true }), false);
  });

  it('never announces from a browser that did not start a test', () => {
    assert.equal(shouldReannounceTest({ ...base, testRunningHere: false }), false);
  });

  it('never announces from a guest or a co-host', () => {
    assert.equal(shouldReannounceTest({ ...base, isHost: false }), false);
  });

  it('does not announce a test whose media connection is gone', () => {
    assert.equal(shouldReannounceTest({ ...base, relayActive: false }), false);
  });

  it('does not announce what the server already lists', () => {
    assert.equal(shouldReannounceTest({ ...base, serverKnowsTest: true }), false);
  });
});
