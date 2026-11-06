import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  acceptDataFrame,
  applyResume,
  base64ToBytes,
  bytesToBase64,
  createLaneReceiveState,
  createLaneSendState,
  DATA_FRAME_HEADER_BYTES,
  decodeDataFrame,
  encodeDataFrame,
  getFramePayloadBytes,
  nextSendRange,
  parseControlMessage,
  serializeControlMessage,
  transferPercent,
} from '../src/utils/recordingTransferProtocol.ts';

describe('recording transfer framing', () => {
  it('round-trips data frames with lane, epoch, sequence and a large offset', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeDataFrame({ lane: 3, epoch: 7, seq: 42, offset: 6 * 1024 ** 3, payload });
    assert.equal(encoded.byteLength, DATA_FRAME_HEADER_BYTES + payload.byteLength);
    const decoded = decodeDataFrame(encoded);
    assert.ok(decoded);
    assert.equal(decoded.lane, 3);
    assert.equal(decoded.epoch, 7);
    assert.equal(decoded.seq, 42);
    assert.equal(decoded.offset, 6 * 1024 ** 3);
    assert.deepEqual([...decoded.payload], [1, 2, 3, 4, 5]);
  });

  it('rejects foreign or truncated binary messages', () => {
    assert.equal(decodeDataFrame(new Uint8Array(10)), null);
    const encoded = new Uint8Array(encodeDataFrame({ lane: 0, epoch: 0, seq: 0, offset: 0, payload: new Uint8Array(1) }));
    encoded[0] = 0;
    assert.equal(decodeDataFrame(encoded), null);
    assert.throws(() => encodeDataFrame({ lane: 70_000, epoch: 0, seq: 0, offset: 0, payload: new Uint8Array(0) }), RangeError);
    assert.throws(() => encodeDataFrame({ lane: 0, epoch: 0, seq: 0, offset: -1, payload: new Uint8Array(0) }), RangeError);
  });

  it('sizes payloads to the negotiated SCTP message size', () => {
    assert.equal(getFramePayloadBytes(262_144), 64 * 1024 - DATA_FRAME_HEADER_BYTES);
    assert.equal(getFramePayloadBytes(16_384), 16_384 - DATA_FRAME_HEADER_BYTES);
    assert.equal(getFramePayloadBytes(undefined), 16 * 1024 - DATA_FRAME_HEADER_BYTES);
  });

  it('validates control messages and drops unknown fields', () => {
    const hello = parseControlMessage(serializeControlMessage({
      t: 'hello', v: 1, participantName: 'María',
      tracks: [{ id: 'take-1', lane: 0, sessionId: 'recording-1', label: 'María audio', kind: 'audio', mimeType: 'audio/webm', available: 10 }],
    }));
    assert.equal(hello?.t, 'hello');
    assert.equal(parseControlMessage('{"t":"ack","id":"bad id","offset":1}'), null);
    assert.equal(parseControlMessage('{"t":"ack","id":"take-1","offset":-1}'), null);
    assert.equal(parseControlMessage('not json'), null);
    assert.deepEqual(parseControlMessage('{"t":"resume","id":"take-1","offset":5,"extra":true}'), { t: 'resume', id: 'take-1', offset: 5 });
    assert.equal(parseControlMessage(JSON.stringify({ t: 'track', track: { id: 'x', lane: 1 } })), null);
  });

  it('encodes WAV headers for the end message as base64', () => {
    const bytes = new Uint8Array([0, 255, 82, 73, 70, 70]);
    assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
  });
});

describe('recording transfer resume logic', () => {
  const frame = (offset: number, length: number, epoch = 0, seq = 0) => ({
    lane: 0, epoch, seq, offset, payload: new Uint8Array(length).fill(offset % 251),
  });

  it('writes contiguous frames and keeps only the new tail of overlaps', () => {
    const state = createLaneReceiveState(0);
    assert.equal(acceptDataFrame(state, frame(0, 10)).action, 'write');
    const overlap = acceptDataFrame(state, frame(5, 10));
    assert.equal(overlap.action, 'write');
    assert.equal(overlap.action === 'write' && overlap.bytes.byteLength, 5);
    assert.equal(state.received, 15);
    assert.equal(acceptDataFrame(state, frame(0, 10)).action, 'ignore');
  });

  it('asks for one resume on a gap instead of a storm', () => {
    const state = createLaneReceiveState(100);
    assert.deepEqual(acceptDataFrame(state, frame(150, 10)), { action: 'resume', offset: 100 });
    assert.deepEqual(acceptDataFrame(state, frame(160, 10)), { action: 'ignore' });
    assert.equal(acceptDataFrame(state, frame(100, 10)).action, 'write');
  });

  it('drops frames from an epoch before the latest resume', () => {
    const state = createLaneReceiveState(0);
    acceptDataFrame(state, frame(0, 10, 2));
    assert.equal(acceptDataFrame(state, frame(10, 10, 1)).action, 'ignore');
    assert.equal(acceptDataFrame(state, frame(10, 10, 2)).action, 'write');
  });

  it('rewinds the sender to the host offset and bumps the epoch', () => {
    const state = createLaneSendState(0);
    assert.equal(nextSendRange(state, 100, 30), null, 'nothing is sent before the host says where to start');
    applyResume(state, 40, 100);
    assert.deepEqual(nextSendRange(state, 100, 30), { start: 40, end: 70 });
    state.sent = 70;
    state.acked = 70;
    applyResume(state, 55, 100);
    assert.equal(state.sent, 55);
    assert.equal(state.acked, 55);
    assert.equal(state.epoch, 2);
    applyResume(state, 500, 100);
    assert.equal(state.sent, 100, 'never past what exists');
  });

  it('reports bounded transfer percentages', () => {
    assert.equal(transferPercent(82, 100), 82);
    assert.equal(transferPercent(150, 100), 100);
    assert.equal(transferPercent(5, 0), 0);
  });
});
