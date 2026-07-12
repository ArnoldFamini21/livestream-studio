import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SfuSignalingHub,
  parseSfuClientMessage,
  type SfuServerMessage,
  type SfuTransportLike,
} from './sfuSignaling.js';
import type { SfuProducerMedia } from './sfuTransport.js';

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
