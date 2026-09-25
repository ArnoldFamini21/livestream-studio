import assert from 'node:assert/strict';
import { it } from 'node:test';
import { sendScreenOnConnection, stopScreenOnConnection } from '../src/utils/screenTransceiver.ts';

class FakeSender {
  track: unknown = null;
  streams: unknown[] = [];
  async replaceTrack(track: unknown) { this.track = track; }
  setStreams(...streams: unknown[]) { this.streams = streams; }
}

class FakeTransceiver {
  sender = new FakeSender();
  direction: RTCRtpTransceiverDirection;
  currentDirection: RTCRtpTransceiverDirection | null = null;
  constructor(track: unknown, direction: RTCRtpTransceiverDirection, streams: unknown[]) {
    this.direction = direction;
    this.sender.track = track;
    this.sender.streams = streams;
  }
}

function fakePc() {
  const calls: Array<{ track: unknown; init: RTCRtpTransceiverInit }> = [];
  return {
    calls,
    addTrack() { throw new Error('addTrack would reuse the peer camera transceiver'); },
    addTransceiver(track: unknown, init: RTCRtpTransceiverInit) {
      calls.push({ track, init });
      return new FakeTransceiver(track, init.direction || 'sendrecv', init.streams || []);
    },
  };
}

const asPc = (pc: ReturnType<typeof fakePc>) => pc as unknown as RTCPeerConnection;
const track = (id: string) => ({ id, kind: 'video' }) as unknown as MediaStreamTrack;
const stream = (id: string) => ({ id }) as unknown as MediaStream;

it('sends the screen on a new send-only transceiver, never through addTrack', async () => {
  const pc = fakePc();
  const transceiver = await sendScreenOnConnection(asPc(pc), null, track('screen-1'), stream('s1'));
  assert.equal(pc.calls.length, 1);
  assert.equal(pc.calls[0].init.direction, 'sendonly');
  assert.deepEqual(pc.calls[0].init.streams, [{ id: 's1' }]);
  assert.equal(transceiver.direction, 'sendonly');
});

it('stops by going inactive, and the next share reuses the transceiver with the new stream id', async () => {
  const pc = fakePc();
  const first = await sendScreenOnConnection(asPc(pc), null, track('screen-1'), stream('s1'));
  await stopScreenOnConnection(first);
  assert.equal(first.direction, 'inactive');
  assert.equal(first.sender.track, null);

  const second = await sendScreenOnConnection(asPc(pc), first, track('screen-2'), stream('s2'));
  assert.equal(second, first);
  assert.equal(pc.calls.length, 1);
  assert.equal(second.direction, 'sendonly');
  assert.deepEqual(second.sender.track, { id: 'screen-2', kind: 'video' });
  assert.deepEqual((second.sender as unknown as FakeSender).streams, [{ id: 's2' }]);
});

it('adds a fresh transceiver when the previous one was stopped', async () => {
  const pc = fakePc();
  const first = await sendScreenOnConnection(asPc(pc), null, track('screen-1'), stream('s1'));
  (first as unknown as FakeTransceiver).currentDirection = 'stopped';
  const second = await sendScreenOnConnection(asPc(pc), first, track('screen-2'), stream('s2'));
  assert.notEqual(second, first);
  assert.equal(pc.calls.length, 2);
});
