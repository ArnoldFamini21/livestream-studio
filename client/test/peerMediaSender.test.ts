import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replacePeerMediaTrack } from '../src/utils/peerMediaSender.ts';

function track(kind: 'audio' | 'video', enabled = true): MediaStreamTrack {
  return {
    kind, enabled, readyState: 'live',
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
  } as MediaStreamTrack;
}

function sender(initial: MediaStreamTrack | null = null) {
  return {
    track: initial,
    async replaceTrack(next: MediaStreamTrack | null) { this.track = next; },
  } as unknown as RTCRtpSender;
}

function peer() {
  const calls: Array<{ trackOrKind: MediaStreamTrack | string; init?: RTCRtpTransceiverInit }> = [];
  const senders = new Map<'audio' | 'video', RTCRtpSender>();
  const screenSender = sender(track('video'));
  return {
    calls, senders, screenSender,
    connection: {
      // addTrack could reuse this inactive screen sender. The device path must
      // allocate its own transceiver and leave the screen stream untouched.
      addTrack: () => { throw new Error('Must not reuse a screen transceiver.'); },
      addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
        calls.push({ trackOrKind, init });
        return { sender: sender(typeof trackOrKind === 'string' ? null : trackOrKind) } as RTCRtpTransceiver;
      },
    },
  };
}

describe('late peer media devices', () => {
  for (const kind of ['audio', 'video'] as const) {
    it(`publishes a ${kind} device that was absent when the peer connected`, async () => {
      const current = peer();
      const device = track(kind);
      const stream = {} as MediaStream;
      const screenTrack = current.screenSender.track;

      const published = await replacePeerMediaTrack(current, device, stream, true);

      assert.equal(published.track, device);
      assert.equal(current.senders.get(kind), published);
      assert.equal(current.calls.length, 1);
      assert.equal(current.calls[0].init?.direction, 'sendrecv');
      assert.deepEqual(current.calls[0].init?.streams, [stream]);
      assert.equal(current.screenSender.track, screenTrack);
      if (kind === 'video') assert.equal(current.calls[0].init?.sendEncodings?.length, 3);
    });

    it(`allocates a silent ${kind} sender while the SFU owns forwarding`, async () => {
      const current = peer();
      const device = track(kind);

      const published = await replacePeerMediaTrack(current, device, {} as MediaStream, false);

      assert.equal(published.track, null);
      assert.equal(current.calls[0].trackOrKind, kind);
      assert.equal(device.enabled, true);
    });
  }

  it('keeps a muted camera muted while allocating its first sender', async () => {
    const current = peer();
    const camera = track('video', false);

    const published = await replacePeerMediaTrack(current, camera, {} as MediaStream, true);

    assert.equal(published.track?.enabled, false);
  });

  it('reuses the camera sender for later switches without changing the screen sender', async () => {
    const current = peer();
    const stream = {} as MediaStream;
    const first = await replacePeerMediaTrack(current, track('video'), stream, true);
    const nextCamera = track('video');
    const second = await replacePeerMediaTrack(current, nextCamera, stream, true);

    assert.equal(second, first);
    assert.equal(second.track, nextCamera);
    assert.equal(current.calls.length, 1);
  });

  it('leaves an existing mesh sender silent when devices change during SFU forwarding', async () => {
    const current = peer();
    const first = await replacePeerMediaTrack(current, track('video'), {} as MediaStream, false);

    await replacePeerMediaTrack(current, track('video'), {} as MediaStream, false);

    assert.equal(first.track, null);
    assert.equal(current.calls.length, 1);
  });

  it('retries a fresh transceiver without simulcast when encoding setup is unsupported', async () => {
    const current = peer();
    const add = current.connection.addTransceiver.bind(current.connection);
    let attempts = 0;
    current.connection.addTransceiver = (trackOrKind, init) => {
      attempts++;
      if (init?.sendEncodings) throw new Error('Simulcast unsupported');
      return add(trackOrKind, init);
    };

    const published = await replacePeerMediaTrack(current, track('video'), {} as MediaStream, true);

    assert.equal(attempts, 2);
    assert.ok(published.track);
    assert.equal(current.calls[0].init?.sendEncodings, undefined);
  });
});
