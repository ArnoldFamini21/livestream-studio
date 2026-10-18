import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SfuSignalingHub,
  parseSfuClientMessage,
  type SfuServerMessage,
  type SfuTransportLike,
} from './sfuSignaling.js';
import type { SfuProducerMedia } from './sfuTransport.js';
import { SfuManager } from './sfuManager.js';

const LAYERS = [
  { rid: 'h', bitrateKbps: 2800, scaleResolutionDownBy: 1 },
  { rid: 'm', bitrateKbps: 1200, scaleResolutionDownBy: 2 },
  { rid: 'l', bitrateKbps: 350, scaleResolutionDownBy: 4 },
];

function createHub() {
  const sent: Array<{ to: string; message: SfuServerMessage }> = [];
  const hub = new SfuSignalingHub((to, message) => sent.push({ to, message }));
  return { hub, sent };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeSfuTransport implements SfuTransportLike {
  readonly subscribeOffers: Array<{ consumerId: string; producerIds: string[] }> = [];
  readonly forwardedLayers: Array<{ consumerId: string; producerId: string; rid: string | null }> = [];

  async createPublishOffer() {
    return { type: 'offer' as const, sdp: 'publish-offer' };
  }

  async setPublishAnswer() {}
  async addPublishIceCandidate() {}
  async closePublisher() {}

  async createSubscribeOffer(consumerId: string, producers: SfuProducerMedia[]) {
    const producerIds = producers.map((producer) => producer.producerId);
    this.subscribeOffers.push({ consumerId, producerIds: [...producerIds] });
    return {
      description: { type: 'offer' as const, sdp: `subscribe-${this.subscribeOffers.length}` },
      producerMids: Object.fromEntries(producers.map((producer, index) => [producer.producerId, {
        ...(producer.hasVideo ? { video: `video-${index}` } : {}),
        ...(producer.hasAudio ? { audio: `audio-${index}` } : {}),
      }])),
    };
  }

  async setSubscribeAnswer() {}
  async addSubscribeIceCandidate() {}
  setForwardedLayer(consumerId: string, producerId: string, rid: string | null) {
    this.forwardedLayers.push({ consumerId, producerId, rid });
  }
  removeProducer() {}
  async closeParticipant() {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type Deferred<T> = ReturnType<typeof deferred<T>>;
type PublishOffer = Awaited<ReturnType<FakeSfuTransport['createPublishOffer']>>;
type SubscribeOffer = Awaited<ReturnType<FakeSfuTransport['createSubscribeOffer']>>;

class DeferredSfuTransport extends FakeSfuTransport {
  deferPublish = false;
  deferSubscribe = false;
  deferAnswers = false;
  readonly pendingPublishes: Array<Deferred<PublishOffer>> = [];
  readonly pendingSubscriptions: Array<Deferred<SubscribeOffer>> = [];
  readonly pendingAnswers: Array<Deferred<void>> = [];

  async createPublishOffer() {
    if (!this.deferPublish) return super.createPublishOffer();
    const operation = deferred<Awaited<ReturnType<FakeSfuTransport['createPublishOffer']>>>();
    this.pendingPublishes.push(operation);
    return operation.promise;
  }

  async createSubscribeOffer(consumerId: string, producers: SfuProducerMedia[]) {
    const result = await super.createSubscribeOffer(consumerId, producers);
    if (!this.deferSubscribe) return result;
    const operation = deferred<typeof result>();
    this.pendingSubscriptions.push(operation);
    return operation.promise;
  }

  async setSubscribeAnswer() {
    if (!this.deferAnswers) return;
    const operation = deferred<void>();
    this.pendingAnswers.push(operation);
    await operation.promise;
  }
}

function createReplacementHarness(transport: DeferredSfuTransport) {
  const manager = new SfuManager({}, () => transport);
  const sent: Array<{ to: string; message: SfuServerMessage }> = [];
  const connect = (id: string) => manager.connect('room-1', id, (message) => sent.push({ to: id, message }));
  const bob = connect('bob');
  manager.handleMessage('bob', { type: 'sfu-join' }, bob);
  return { manager, sent, connect, close: () => {
    manager.disconnect('alice');
    manager.disconnect('bob');
    manager.disconnect('carol');
  } };
}

describe('SFU replacement negotiation isolation', () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`ignores a stale publish offer ${outcome} after the replacement publishes`, async () => {
      const transport = new DeferredSfuTransport();
      transport.deferPublish = true;
      const { manager, sent, connect, close } = createReplacementHarness(transport);
      try {
        const old = connect('alice');
        manager.handleMessage('alice', { type: 'sfu-join' }, old);
        manager.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS }, old);
        const replacement = connect('alice');
        manager.handleMessage('alice', { type: 'sfu-join' }, replacement);
        manager.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS }, replacement);
        transport.pendingPublishes[1].resolve({ type: 'offer', sdp: 'current-offer' });
        await flushAsyncWork();
        sent.length = 0;

        if (outcome === 'resolve') transport.pendingPublishes[0].resolve({ type: 'offer', sdp: 'stale-offer' });
        else transport.pendingPublishes[0].reject(new Error('stale offer failed'));
        await flushAsyncWork();
        assert.equal(sent.some(({ to }) => to === 'alice'), false);
        assert.equal(manager.handleMessage('alice', { type: 'sfu-downlink', downlinkKbps: 1000 }, replacement), true);
      } finally { close(); }
    });
  }

  it('does not deliver an old subscription offer to a replacement socket', async () => {
    const transport = new DeferredSfuTransport();
    transport.deferSubscribe = true;
    const { manager, sent, connect, close } = createReplacementHarness(transport);
    try {
      manager.handleMessage('bob', { type: 'sfu-publish', layers: LAYERS });
      const old = connect('alice');
      manager.handleMessage('alice', { type: 'sfu-join' }, old);
      await flushAsyncWork();
      const replacement = connect('alice');
      manager.handleMessage('alice', { type: 'sfu-join' }, replacement);
      await flushAsyncWork();
      transport.pendingSubscriptions[1].resolve({
        description: { type: 'offer', sdp: 'current-subscribe' }, producerMids: {},
      });
      await flushAsyncWork();
      sent.length = 0;
      transport.pendingSubscriptions[0].resolve({
        description: { type: 'offer', sdp: 'stale-subscribe' }, producerMids: {},
      });
      await flushAsyncWork();
      assert.equal(sent.some(({ to }) => to === 'alice'), false);
    } finally { close(); }
  });

  it('does not finish a new negotiation when an old answer completes', async () => {
    const transport = new DeferredSfuTransport();
    transport.deferAnswers = true;
    const { manager, connect, close } = createReplacementHarness(transport);
    try {
      manager.handleMessage('bob', { type: 'sfu-publish', layers: LAYERS });
      const old = connect('alice');
      manager.handleMessage('alice', { type: 'sfu-join' }, old);
      await flushAsyncWork();
      manager.handleMessage('alice', { type: 'sfu-transport-answer', side: 'subscribe', sdp: 'old-answer' }, old);
      const replacement = connect('alice');
      manager.handleMessage('alice', { type: 'sfu-join' }, replacement);
      await flushAsyncWork();
      const carol = connect('carol');
      manager.handleMessage('carol', { type: 'sfu-join' }, carol);
      manager.handleMessage('carol', { type: 'sfu-publish', layers: LAYERS }, carol);
      await flushAsyncWork();
      const aliceOffers = () => transport.subscribeOffers.filter(({ consumerId }) => consumerId === 'alice').length;
      assert.equal(aliceOffers(), 2);

      transport.pendingAnswers[0].resolve();
      await flushAsyncWork();
      assert.equal(aliceOffers(), 2);
      manager.handleMessage('alice', { type: 'sfu-transport-answer', side: 'subscribe', sdp: 'new-answer' }, replacement);
      transport.pendingAnswers[1].resolve();
      await flushAsyncWork();
      assert.equal(aliceOffers(), 3);
    } finally { close(); }
  });

  it('clears old subscription deadlines and resets only the lifecycle whose answer times out', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const transport = new DeferredSfuTransport();
    const { manager, sent, connect, close } = createReplacementHarness(transport);
    try {
      manager.handleMessage('bob', { type: 'sfu-publish', layers: LAYERS });
      const old = connect('alice');
      manager.handleMessage('alice', { type: 'sfu-join' }, old);
      await flushAsyncWork();
      context.mock.timers.tick(1000);
      const replacement = connect('alice');
      manager.handleMessage('alice', { type: 'sfu-join' }, replacement);
      await flushAsyncWork();
      sent.length = 0;

      context.mock.timers.tick(14_000);
      assert.equal(sent.some(({ message }) => message.type === 'sfu-error'), false);
      context.mock.timers.tick(1000);
      assert.equal(sent.filter(({ to, message }) => to === 'alice' && message.type === 'sfu-error').length, 1);
      // A fresh join succeeds after reset; the timed-out lifecycle has no
      // queued negotiation capable of finishing underneath it.
      assert.equal(manager.handleMessage('alice', { type: 'sfu-join' }, replacement), true);
      await flushAsyncWork();
      assert.equal(transport.subscribeOffers.filter(({ consumerId }) => consumerId === 'alice').length, 3);
    } finally { close(); }
  });
});

describe('parseSfuClientMessage', () => {
  it('parses valid client messages', () => {
    assert.deepEqual(parseSfuClientMessage({ type: 'sfu-join', downlinkKbps: 5000 }), {
      type: 'sfu-join',
      downlinkKbps: 5000,
    });
    assert.deepEqual(parseSfuClientMessage({ type: 'sfu-unpublish' }), { type: 'sfu-unpublish' });
    assert.deepEqual(parseSfuClientMessage({ type: 'sfu-leave' }), { type: 'sfu-leave' });
  });

  it('normalizes downlink and rejects bad publish payloads', () => {
    assert.equal(parseSfuClientMessage({ type: 'sfu-join', downlinkKbps: -5 })?.type, 'sfu-join');
    assert.deepEqual(parseSfuClientMessage({ type: 'sfu-join' }), { type: 'sfu-join', downlinkKbps: 0 });
    assert.equal(parseSfuClientMessage({ type: 'sfu-publish', layers: [] }), null);
    assert.deepEqual(parseSfuClientMessage({ type: 'sfu-publish', layers: [], audio: true }), {
      type: 'sfu-publish',
      layers: [],
      audio: true,
    });
    assert.equal(parseSfuClientMessage({ type: 'sfu-publish', layers: [{ rid: '', bitrateKbps: 100 }] }), null);
    assert.equal(parseSfuClientMessage({ type: 'sfu-publish' }), null);
  });

  it('filters invalid layers and caps the layer count', () => {
    const parsed = parseSfuClientMessage({
      type: 'sfu-publish',
      layers: [
        { rid: 'h', bitrateKbps: 2800, scaleResolutionDownBy: 1 },
        { rid: 'bad', bitrateKbps: 'x' },
        { rid: 'm', bitrateKbps: 1200 },
      ],
    });
    assert.equal(parsed?.type, 'sfu-publish');
    if (parsed?.type === 'sfu-publish') {
      assert.equal(parsed.layers.length, 2);
      assert.equal(parsed.layers[1].scaleResolutionDownBy, 1); // defaulted
    }
  });

  it('parses bounded transport answers and ICE candidates', () => {
    assert.deepEqual(parseSfuClientMessage({
      type: 'sfu-transport-answer',
      side: 'publish',
      sdp: 'v=0\\r\\n',
    }), {
      type: 'sfu-transport-answer',
      side: 'publish',
      sdp: 'v=0\\r\\n',
    });
    assert.deepEqual(parseSfuClientMessage({
      type: 'sfu-transport-ice',
      side: 'subscribe',
      candidate: { candidate: 'candidate:1', sdpMLineIndex: 0, sdpMid: '0' },
    }), {
      type: 'sfu-transport-ice',
      side: 'subscribe',
      candidate: { candidate: 'candidate:1', sdpMLineIndex: 0, sdpMid: '0' },
    });
    assert.equal(parseSfuClientMessage({ type: 'sfu-transport-answer', side: 'bad', sdp: 'v=0' }), null);
    assert.equal(parseSfuClientMessage({ type: 'sfu-transport-ice', side: 'publish', candidate: {} }), null);
  });

  it('rejects unknown or malformed messages', () => {
    assert.equal(parseSfuClientMessage(null), null);
    assert.equal(parseSfuClientMessage({ type: 'nope' }), null);
    assert.equal(parseSfuClientMessage('sfu-join'), null);
  });
});

describe('SfuSignalingHub', () => {
  it('sends the existing producer list to a joiner', () => {
    const { hub, sent } = createHub();
    hub.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });
    sent.length = 0;

    hub.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    const producersMsg = sent.find((s) => s.to === 'bob' && s.message.type === 'sfu-producers');
    assert.ok(producersMsg);
    assert.deepEqual((producersMsg!.message as { producers: string[] }).producers, ['alice']);
  });

  it('notifies existing participants when a new producer publishes', () => {
    const { hub, sent } = createHub();
    hub.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    sent.length = 0;

    hub.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });
    const added = sent.filter((s) => s.message.type === 'sfu-producer-added');
    assert.equal(added.length, 1);
    assert.equal(added[0].to, 'bob');
  });

  it('emits per-consumer layer selections', () => {
    const { hub, sent } = createHub();
    hub.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });

    const layerMsg = sent.find((s) => s.to === 'bob' && s.message.type === 'sfu-layer');
    assert.ok(layerMsg);
    const payload = layerMsg!.message as { producerId: string; rid: string | null };
    assert.equal(payload.producerId, 'alice');
    assert.equal(payload.rid, 'h');
  });

  it('re-selects layers when a consumer reports a lower downlink', () => {
    const { hub, sent } = createHub();
    hub.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });
    sent.length = 0;

    hub.handleMessage('bob', { type: 'sfu-downlink', downlinkKbps: 1500 });
    const layerMsg = sent.find((s) => s.to === 'bob' && s.message.type === 'sfu-layer');
    assert.ok(layerMsg);
    assert.equal((layerMsg!.message as { rid: string | null }).rid, 'm');
  });

  it('broadcasts producer-removed when a publisher leaves', () => {
    const { hub, sent } = createHub();
    hub.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });
    sent.length = 0;

    hub.handleMessage('alice', { type: 'sfu-leave' });
    const removed = sent.filter((s) => s.message.type === 'sfu-producer-removed');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].to, 'bob');
    assert.equal(hub.getRoom().hasParticipant('alice'), false);
  });

  it('treats disconnect like a leave for publishers', () => {
    const { hub, sent } = createHub();
    hub.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });
    sent.length = 0;

    hub.handleDisconnect('alice');
    assert.ok(sent.some((s) => s.to === 'bob' && s.message.type === 'sfu-producer-removed'));
    assert.equal(hub.getRoom().hasParticipant('alice'), false);
  });

  it('returns an error for malformed messages', () => {
    const { hub, sent } = createHub();
    const handled = hub.handleMessage('alice', { type: 'garbage' });
    assert.equal(handled, false);
    assert.ok(sent.some((s) => s.to === 'alice' && s.message.type === 'sfu-error'));
  });

  it('surfaces coordinator errors as sfu-error (publish before join)', () => {
    const { hub, sent } = createHub();
    const handled = hub.handleMessage('ghost', { type: 'sfu-publish', layers: LAYERS });
    assert.equal(handled, false);
    const error = sent.find((s) => s.to === 'ghost' && s.message.type === 'sfu-error');
    assert.ok(error);
    assert.match((error!.message as { message: string }).message, /join before publishing/);
  });

  it('queues subscription renegotiation until the prior offer is answered', async () => {
    const sent: Array<{ to: string; message: SfuServerMessage }> = [];
    const transport = new FakeSfuTransport();
    const hub = new SfuSignalingHub((to, message) => sent.push({ to, message }), {}, transport);

    hub.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });
    await flushAsyncWork();
    assert.equal(transport.subscribeOffers.filter((offer) => offer.consumerId === 'bob').length, 1);

    hub.handleMessage('carol', { type: 'sfu-join', downlinkKbps: 6000 });
    hub.handleMessage('carol', { type: 'sfu-publish', layers: LAYERS });
    await flushAsyncWork();
    assert.equal(transport.subscribeOffers.filter((offer) => offer.consumerId === 'bob').length, 1);

    hub.handleMessage('bob', { type: 'sfu-transport-answer', side: 'subscribe', sdp: 'answer-1' });
    await flushAsyncWork();
    const bobOffers = transport.subscribeOffers.filter((offer) => offer.consumerId === 'bob');
    assert.equal(bobOffers.length, 2);
    assert.deepEqual(bobOffers[1].producerIds.sort(), ['alice', 'carol']);
    assert.ok(transport.forwardedLayers.some((selection) => (
      selection.consumerId === 'bob' && selection.producerId === 'carol' && selection.rid !== null
    )));

    hub.handleDisconnect('alice');
    hub.handleDisconnect('bob');
    hub.handleDisconnect('carol');
    assert.ok(sent.some(({ to, message }) => to === 'bob' && message.type === 'sfu-transport-offer'));
  });
});
