import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTransferReceiver,
  createTransferSender,
  HostTransferRegistry,
  type ReceivedTrackSink,
  type TransferChannel,
  type TransferSourceTrack,
} from '../src/utils/recordingTransferSession.ts';
import { parseControlMessage } from '../src/utils/recordingTransferProtocol.ts';

type Listener = (event?: { data: unknown }) => void;

class FakeChannel implements TransferChannel {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'blob';
  maxMessageSize = 1024;
  peer: FakeChannel | null = null;
  readonly sent: Array<string | ArrayBuffer> = [];
  /** Drop binary frames whose index matches (simulates a lost connection mid-flight). */
  dropBinary: (index: number) => boolean = () => false;
  private binaryCount = 0;
  private listeners = new Map<string, Set<Listener>>();

  send(data: string | ArrayBuffer) {
    if (this.readyState !== 'open') throw new Error('Channel is not open');
    this.sent.push(data);
    if (typeof data !== 'string' && this.dropBinary(this.binaryCount++)) return;
    const peer = this.peer;
    setTimeout(() => { if (peer?.readyState === 'open') peer.emit('message', { data }); }, 0);
  }
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event?: { data: unknown }) { for (const listener of this.listeners.get(type) || []) listener(event); }
  close() {
    this.readyState = 'closed';
    if (this.peer) this.peer.readyState = 'closed';
  }
}

function channelPair() {
  const guest = new FakeChannel();
  const host = new FakeChannel();
  guest.peer = host;
  host.peer = guest;
  return { guest, host };
}

function memorySink() {
  const sinks: Array<{ chunks: Uint8Array[]; finished?: Uint8Array; header?: Uint8Array }> = [];
  const open = async (): Promise<ReceivedTrackSink> => {
    const state: { chunks: Uint8Array[]; finished?: Uint8Array; header?: Uint8Array } = { chunks: [] };
    sinks.push(state);
    const size = () => state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    return {
      write: async (bytes) => { state.chunks.push(bytes); },
      accepted: size,
      finish: async ({ header }) => {
        const all = new Uint8Array(size());
        let offset = 0;
        for (const chunk of state.chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
        if (header) all.set(header.subarray(0, Math.min(header.byteLength, all.byteLength)), 0);
        state.finished = all;
        return { bytes: all.byteLength, path: 'Studio/take/Maria/Maria audio.webm', file: new Blob([all]) };
      },
    };
  };
  return { sinks, open };
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, timeoutMs = 3_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the transfer');
    await wait(5);
  }
}

function bytes(length: number, seed = 0) {
  return Uint8Array.from({ length }, (_, index) => (index * 7 + seed) % 256);
}

function growingTrack(id: string, total: Uint8Array): TransferSourceTrack & { grow(to: number): void; finish(header?: Uint8Array): void } {
  let available = 0;
  const track: TransferSourceTrack & { grow(to: number): void; finish(header?: Uint8Array): void } = {
    id,
    sessionId: 'recording-1',
    label: 'Maria audio',
    kind: 'audio',
    mimeType: 'audio/webm',
    read: async () => new Blob([total.slice(0, available)]),
    grow(to) { available = to; },
    finish(header) {
      available = total.byteLength;
      track.finished = { totalBytes: total.byteLength, ...(header ? { header } : {}), capture: { sourceId: 'maria-audio' } };
    },
  };
  return track;
}

describe('peer-to-peer recording transfer', () => {
  it('streams a growing track during the take and verifies the final size', async () => {
    const { guest, host } = channelPair();
    const sink = memorySink();
    const completed: string[] = [];
    const registry = new HostTransferRegistry(sink.open, (entry) => completed.push(entry.id));
    const receiver = createTransferReceiver({ channel: host, participantId: 'guest-1', registry, pingIntervalMs: 60_000 });
    const payload = bytes(10_000);
    const track = growingTrack('take-maria', payload);
    track.grow(3_000);
    const delivered: string[] = [];
    const sender = createTransferSender({
      channel: guest, participantName: 'Maria', getTracks: () => [track], pollMs: 20, onDelivered: (id) => delivered.push(id),
    });

    await until(() => (registry.tracks.get('take-maria')?.received ?? 0) >= 3_000);
    const [summary] = registry.summaries();
    assert.equal(summary.participantName, 'Maria');
    assert.ok(summary.percent > 0 && summary.percent <= 100);

    track.grow(7_000);
    sender.refresh();
    await until(() => (registry.tracks.get('take-maria')?.received ?? 0) >= 7_000);

    const header = new Uint8Array([9, 9, 9, 9]);
    track.finish(header);
    sender.refresh();
    await until(() => delivered.length === 1);
    const expected = payload.slice();
    expected.set(header, 0);
    assert.deepEqual([...sink.sinks[0].finished!], [...expected]);
    assert.deepEqual(completed, ['take-maria']);
    assert.equal(registry.tracks.get('take-maria')?.status, 'complete');
    assert.equal(registry.isSettled(), true);
    assert.equal(registry.summaries()[0].percent, 100);
    assert.equal(sender.progress().deliveredAll, true);
    sender.close();
    receiver.close();
  });

  it('resumes from the bytes the host already saved after a reconnect, without duplicates', async () => {
    const sink = memorySink();
    const registry = new HostTransferRegistry(sink.open);
    const payload = bytes(8_000, 3);
    const track = growingTrack('take-resume', payload);
    track.grow(8_000);

    // First connection loses every frame after the third one, then drops.
    const first = channelPair();
    first.guest.dropBinary = (index) => index >= 3;
    const receiver1 = createTransferReceiver({ channel: first.host, participantId: 'guest-1', registry, pingIntervalMs: 60_000 });
    const sender1 = createTransferSender({ channel: first.guest, participantName: 'Maria', getTracks: () => [track], pollMs: 20 });
    await until(() => (registry.tracks.get('take-resume')?.received ?? 0) > 0);
    await wait(50);
    const savedBeforeDrop = registry.tracks.get('take-resume')!.received;
    assert.ok(savedBeforeDrop > 0 && savedBeforeDrop < payload.byteLength);
    sender1.close();
    first.guest.close();
    receiver1.close();
    assert.equal(registry.summaries()[0].connected, false);

    // The guest reloads and sends again from its browser backup.
    track.finish();
    const second = channelPair();
    const receiver2 = createTransferReceiver({ channel: second.host, participantId: 'guest-1b', registry, pingIntervalMs: 60_000 });
    const delivered: string[] = [];
    const sender2 = createTransferSender({ channel: second.guest, participantName: 'Maria', getTracks: () => [track], pollMs: 20, onDelivered: (id) => delivered.push(id) });
    await until(() => delivered.length === 1);
    const resume = second.host.sent.map((message) => typeof message === 'string' ? parseControlMessage(message) : null)
      .find((message) => message?.t === 'resume');
    assert.deepEqual(resume, { t: 'resume', id: 'take-resume', offset: savedBeforeDrop });
    assert.deepEqual([...sink.sinks[0].finished!], [...payload]);
    assert.equal(sink.sinks.length, 1, 'the same file continues');
    sender2.close();
    receiver2.close();
  });

  it('measures the guest clock offset with ping/pong', async () => {
    const { guest, host } = channelPair();
    const registry = new HostTransferRegistry(memorySink().open);
    let hostClock = 1_000_000;
    const receiver = createTransferReceiver({ channel: host, participantId: 'guest-1', registry, now: () => hostClock, pingIntervalMs: 60_000 });
    const sender = createTransferSender({ channel: guest, participantName: 'Maria', getTracks: () => [], now: () => hostClock + 4_000, pollMs: 1_000 });
    await until(() => registry.getClockOffset('guest-1') !== undefined, 2_000);
    hostClock += 1;
    assert.equal(registry.getClockOffset('guest-1'), 4_000);
    sender.close();
    receiver.close();
  });

  it('tells the guest when the host cannot save a track so it keeps its copy', async () => {
    const { guest, host } = channelPair();
    const registry = new HostTransferRegistry(async () => { throw new Error('Drive unplugged'); });
    const receiver = createTransferReceiver({ channel: host, participantId: 'guest-1', registry, pingIntervalMs: 60_000 });
    const track = growingTrack('take-fail', bytes(100));
    track.finish();
    const failures: string[] = [];
    const sender = createTransferSender({ channel: guest, participantName: 'Maria', getTracks: () => [track], pollMs: 20, onFailed: (_id, error) => failures.push(error) });
    await until(() => failures.length === 1);
    assert.match(failures[0], /Drive unplugged/);
    assert.equal(registry.summaries()[0].failedTracks, 1);
    sender.close();
    receiver.close();
  });

  it('keeps two guests with the same name apart in progress and files', async () => {
    const opened: Array<{ participantId: string; participantName: string }> = [];
    const registry = new HostTransferRegistry(async (input) => {
      opened.push({ participantId: input.participantId, participantName: input.participantName });
      return memorySink().open();
    });
    const announce = (id: string) => ({ id, lane: 1, sessionId: 'rec-1', label: 'mic', kind: 'audio', mimeType: 'audio/webm', available: 10 });
    registry.ensureTrack('guest-a', 'Maria', announce('a-mic'));
    registry.ensureTrack('guest-b', 'Maria', announce('b-mic'));
    const rows = registry.summaries();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.participantId).sort(), ['guest-a', 'guest-b']);
    assert.deepEqual(opened.map((input) => input.participantId), ['guest-a', 'guest-b'], 'each file knows whose it is');
  });

  const controlMessages = (channel: FakeChannel) => channel.sent
    .map((message) => typeof message === 'string' ? parseControlMessage(message) : null)
    .filter((message): message is NonNullable<typeof message> => Boolean(message));

  it('writes a failed track into a fresh file when the guest reconnects', async () => {
    const memory = memorySink();
    let opened = 0;
    // The first file stops accepting bytes after one write (e.g. disk full).
    const registry = new HostTransferRegistry(async () => {
      opened += 1;
      const sink = await memory.open();
      if (opened > 1) return sink;
      let writes = 0;
      return { ...sink, write: async (chunk) => { if (++writes > 1) throw new Error('Disk full'); await sink.write(chunk); } };
    });
    const payload = bytes(6_000, 5);
    const track = growingTrack('take-retry', payload);
    track.finish();

    const first = channelPair();
    const receiver1 = createTransferReceiver({ channel: first.host, participantId: 'guest-1', registry, pingIntervalMs: 60_000 });
    const failures: string[] = [];
    const sender1 = createTransferSender({ channel: first.guest, participantName: 'Maria', getTracks: () => [track], pollMs: 20, onFailed: (_id, error) => failures.push(error) });
    await until(() => failures.length === 1);
    await wait(60);
    assert.match(failures[0], /Disk full/);
    assert.equal(controlMessages(first.host).filter((message) => message.t === 'done').length, 1, 'one refusal per connection');
    assert.equal(registry.tracks.get('take-retry')!.status, 'failed');
    sender1.close();
    first.guest.close();
    receiver1.close();

    const second = channelPair();
    const receiver2 = createTransferReceiver({ channel: second.host, participantId: 'guest-1', registry, pingIntervalMs: 60_000 });
    const delivered: string[] = [];
    const sender2 = createTransferSender({ channel: second.guest, participantName: 'Maria', getTracks: () => [track], pollMs: 20, onDelivered: (id) => delivered.push(id) });
    await until(() => delivered.length === 1);
    assert.equal(opened, 2, 'a fresh file was opened for the retry');
    assert.deepEqual([...memory.sinks[1].finished!], [...payload]);
    assert.equal(registry.tracks.get('take-retry')!.status, 'complete');
    sender2.close();
    receiver2.close();
  });

  it('stops writing once a participant reaches the byte cap and refuses extra tracks', async () => {
    const memory = memorySink();
    const registry = new HostTransferRegistry(memory.open);
    const { guest, host } = channelPair();
    const limits = { maxTracks: 1, maxSessions: 1, maxBytes: 2_000 };
    const receiver = createTransferReceiver({ channel: host, participantId: 'guest-1', registry, pingIntervalMs: 60_000, limits });
    const big = growingTrack('take-big', bytes(5_000, 1));
    big.finish();
    const extra = growingTrack('take-extra', bytes(10, 2));
    extra.finish();
    const failures: string[] = [];
    const sender = createTransferSender({ channel: guest, participantName: 'Maria', getTracks: () => [big, extra], pollMs: 20, onFailed: (id) => failures.push(id) });
    await until(() => failures.length === 2);
    await wait(60);
    const written = memory.sinks.reduce((sum, sink) => sum + sink.chunks.reduce((total, chunk) => total + chunk.byteLength, 0), 0);
    assert.ok(written <= limits.maxBytes, `wrote ${written} bytes`);
    assert.deepEqual(failures.sort(), ['take-big', 'take-extra']);
    assert.equal(registry.tracks.has('take-extra'), false, 'no file is opened for a refused track');
    assert.equal(memory.sinks.length, 1);
    sender.close();
    receiver.close();
  });

  it('refuses a failed track once, without a resend loop, when no file can be opened', async () => {
    const memory = memorySink();
    let opened = 0;
    const registry = new HostTransferRegistry(async () => {
      opened += 1;
      if (opened > 1) throw new Error('Folder access was revoked');
      const sink = await memory.open();
      return { ...sink, write: async () => { throw new Error('Folder access was revoked'); } };
    });
    const track = growingTrack('take-gone', bytes(3_000, 9));
    track.finish();

    const first = channelPair();
    const receiver1 = createTransferReceiver({ channel: first.host, participantId: 'guest-1', registry, pingIntervalMs: 60_000 });
    const sender1 = createTransferSender({ channel: first.guest, participantName: 'Maria', getTracks: () => [track], pollMs: 20 });
    await until(() => controlMessages(first.host).some((message) => message.t === 'done'));
    await wait(150);
    const firstMessages = controlMessages(first.host);
    assert.equal(firstMessages.filter((message) => message.t === 'done').length, 1);
    assert.equal(firstMessages.filter((message) => message.t === 'resume').length, 1, 'only the initial resume, no resend loop');
    sender1.close();
    first.guest.close();
    receiver1.close();

    const second = channelPair();
    const receiver2 = createTransferReceiver({ channel: second.host, participantId: 'guest-1', registry, pingIntervalMs: 60_000 });
    const failures: string[] = [];
    const sender2 = createTransferSender({ channel: second.guest, participantName: 'Maria', getTracks: () => [track], pollMs: 20, onFailed: (_id, error) => failures.push(error) });
    await until(() => failures.length === 1);
    await wait(150);
    const secondMessages = controlMessages(second.host);
    assert.equal(secondMessages.filter((message) => message.t === 'done' && !message.ok).length, 1);
    assert.equal(secondMessages.filter((message) => message.t === 'resume').length, 0, 'a lane that cannot accept data is never resumed');
    assert.equal(second.guest.sent.filter((message) => typeof message !== 'string').length, 0, 'the guest sends no data');
    sender2.close();
    receiver2.close();
  });
});
