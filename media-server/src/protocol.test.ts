import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseControlMessage } from './protocol.js';

describe('RTMP relay control protocol', () => {
  it('parses bounded heartbeat ping messages', () => {
    assert.deepEqual(
      parseControlMessage(Buffer.from(JSON.stringify({
        type: 'ping',
        payload: { sentAt: 1_000, sequence: 7 },
      }))),
      { type: 'ping', payload: { sentAt: 1_000, sequence: 7 } }
    );

    assert.equal(
      parseControlMessage(Buffer.from(JSON.stringify({
        type: 'ping',
        payload: { sentAt: 1_000, sequence: 1.5 },
      }))),
      null
    );
    assert.equal(
      parseControlMessage(Buffer.from(JSON.stringify({
        type: 'ping',
        payload: { sentAt: -1, sequence: 1 },
      }))),
      null
    );
  });

  it('parses start and stop control messages without accepting malformed JSON', () => {
    assert.deepEqual(parseControlMessage(Buffer.from(JSON.stringify({ type: 'stop' }))), { type: 'stop' });
    assert.equal(parseControlMessage(Buffer.from('not json')), null);
    assert.equal(parseControlMessage(Buffer.from(JSON.stringify({ type: 'start', payload: {} }))), null);

    const start = parseControlMessage(Buffer.from(JSON.stringify({
      type: 'start',
      payload: {
        token: 'token',
        destinations: [],
        video: {},
        audio: {},
      },
    })));
    assert.equal(start?.type, 'start');
  });
});
