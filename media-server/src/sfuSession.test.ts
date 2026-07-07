import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SfuSessionCoordinator } from './sfuSession.js';
import type { SimulcastLayer } from './sfuRouter.js';

const LAYERS: SimulcastLayer[] = [
  { rid: 'h', bitrateKbps: 2800, scaleResolutionDownBy: 1 },
  { rid: 'm', bitrateKbps: 1200, scaleResolutionDownBy: 2 },
  { rid: 'l', bitrateKbps: 350, scaleResolutionDownBy: 4 },
];

describe('SfuSessionCoordinator', () => {
  it('tracks participants joining and leaving', () => {
    const room = new SfuSessionCoordinator();
    room.join('alice', 5000);
    room.join('bob', 5000);
    assert.equal(room.getParticipantCount(), 2);
    assert.ok(room.hasParticipant('alice'));
    room.leave('alice');
    assert.equal(room.getParticipantCount(), 1);
    assert.equal(room.hasParticipant('alice'), false);
  });

  it('subscribes every participant to every publisher', () => {
    const room = new SfuSessionCoordinator();
    room.join('alice', 6000);
    room.join('bob', 6000);
    room.join('carol', 6000);
    room.publish('alice', LAYERS);
    room.publish('bob', LAYERS);

    const changes = room.pullLayerChanges();
    // carol consumes alice + bob; alice consumes bob; bob consumes alice => 4 streams.
    assert.equal(changes.length, 4);
    const carolStreams = changes.filter((c) => c.consumerId === 'carol').map((c) => c.producerId).sort();
    assert.deepEqual(carolStreams, ['alice', 'bob']);
    // Publishers never consume themselves.
    assert.equal(changes.some((c) => c.consumerId === c.producerId), false);
  });

  it('emits only changed decisions on subsequent pulls', () => {
    const room = new SfuSessionCoordinator();
    room.join('alice', 6000);
    room.join('bob', 6000);
    room.publish('alice', LAYERS);

    assert.equal(room.pullLayerChanges().length, 1); // bob starts consuming alice
    assert.equal(room.pullLayerChanges().length, 0); // nothing changed
  });

  it('downgrades a consumer when its downlink drops', () => {
    const room = new SfuSessionCoordinator();
    room.join('alice', 6000);
    room.join('bob', 6000);
    room.publish('alice', LAYERS);

    const initial = room.pullLayerChanges();
    assert.equal(initial[0].rid, 'h');

    room.setDownlink('bob', 1500);
    const changed = room.pullLayerChanges();
    assert.equal(changed.length, 1);
    assert.equal(changed[0].consumerId, 'bob');
    assert.equal(changed[0].rid, 'm');
    assert.equal(changed[0].reason, 'downgrade');
  });

  it('lets a participant publish after others have joined and subscribes them', () => {
    const room = new SfuSessionCoordinator();
    room.join('alice', 6000);
    room.join('bob', 6000);
    room.pullLayerChanges();

    room.publish('bob', LAYERS);
    const changes = room.pullLayerChanges();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].consumerId, 'alice');
    assert.equal(changes[0].producerId, 'bob');
  });

  it('stops forwarding a producer that unpublishes but keeps the viewer', () => {
    const room = new SfuSessionCoordinator();
    room.join('alice', 6000);
    room.join('bob', 6000);
    room.publish('alice', LAYERS);
    room.pullLayerChanges();

    room.unpublish('alice');
    assert.deepEqual(room.pullLayerChanges(), []);
    assert.equal(room.hasParticipant('alice'), true);
    assert.equal(room.listParticipants().find((p) => p.participantId === 'alice')?.publishing, false);
  });

  it('removes all forwarding when a publisher leaves', () => {
    const room = new SfuSessionCoordinator();
    room.join('alice', 6000);
    room.join('bob', 6000);
    room.publish('alice', LAYERS);
    room.pullLayerChanges();

    room.leave('alice');
    assert.deepEqual(room.pullLayerChanges(), []);
    assert.equal(room.getParticipantCount(), 1);
  });

  it('rejects publishing before joining', () => {
    const room = new SfuSessionCoordinator();
    assert.throws(() => room.publish('ghost', LAYERS), /join before publishing/);
  });

  it('treats a repeat join as a downlink update', () => {
    const room = new SfuSessionCoordinator();
    room.join('alice', 6000);
    room.join('alice', 1500);
    assert.equal(room.getParticipantCount(), 1);
    assert.equal(room.listParticipants()[0].downlinkKbps, 1500);
  });
});
