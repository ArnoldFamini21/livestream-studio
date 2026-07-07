import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SfuSignalingHub,
  parseSfuClientMessage,
  type SfuServerMessage,
} from './sfuSignaling.js';

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
});
