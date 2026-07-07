import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SfuManager, type SfuParticipantSend } from './sfuManager.js';
import type { SfuServerMessage } from './sfuSignaling.js';

const LAYERS = [
  { rid: 'h', bitrateKbps: 2800, scaleResolutionDownBy: 1 },
  { rid: 'm', bitrateKbps: 1200, scaleResolutionDownBy: 2 },
  { rid: 'l', bitrateKbps: 350, scaleResolutionDownBy: 4 },
];

function recorder(): { send: SfuParticipantSend; messages: SfuServerMessage[] } {
  const messages: SfuServerMessage[] = [];
  return { send: (message) => messages.push(message), messages };
}

describe('SfuManager', () => {
  it('creates a room lazily and tracks participants', () => {
    const manager = new SfuManager();
    const alice = recorder();
    const bob = recorder();
    manager.connect('room-1', 'alice', alice.send);
    manager.connect('room-1', 'bob', bob.send);

    assert.equal(manager.getRoomCount(), 1);
    assert.equal(manager.getParticipantCount(), 2);
    assert.equal(manager.getRoomParticipantCount('room-1'), 2);
  });

  it('routes messages to the participant room and delivers hub output to sockets', () => {
    const manager = new SfuManager();
    const alice = recorder();
    const bob = recorder();
    manager.connect('room-1', 'alice', alice.send);
    manager.connect('room-1', 'bob', bob.send);

    manager.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    manager.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    manager.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });

    // Bob is told a new producer appeared and given a layer to consume.
    assert.ok(bob.messages.some((m) => m.type === 'sfu-producer-added'));
    const layer = bob.messages.find((m) => m.type === 'sfu-layer');
    assert.ok(layer);
    assert.equal((layer as { producerId: string; rid: string | null }).producerId, 'alice');
    assert.equal((layer as { rid: string | null }).rid, 'h');
  });

  it('isolates rooms from each other', () => {
    const manager = new SfuManager();
    const alice = recorder();
    const carol = recorder();
    manager.connect('room-1', 'alice', alice.send);
    manager.connect('room-2', 'carol', carol.send);
    manager.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    manager.handleMessage('carol', { type: 'sfu-join', downlinkKbps: 6000 });
    manager.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });

    // Carol is in a different room and hears nothing about alice.
    assert.equal(carol.messages.some((m) => m.type === 'sfu-producer-added'), false);
    assert.equal(manager.getRoomCount(), 2);
  });

  it('ignores messages from unknown participants', () => {
    const manager = new SfuManager();
    assert.equal(manager.handleMessage('nobody', { type: 'sfu-join' }), false);
  });

  it('tears down a room when the last participant disconnects', () => {
    const manager = new SfuManager();
    const alice = recorder();
    manager.connect('room-1', 'alice', alice.send);
    manager.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    assert.equal(manager.getRoomCount(), 1);

    manager.disconnect('alice');
    assert.equal(manager.getRoomCount(), 0);
    assert.equal(manager.getParticipantCount(), 0);
  });

  it('broadcasts producer-removed to peers when a publisher disconnects', () => {
    const manager = new SfuManager();
    const alice = recorder();
    const bob = recorder();
    manager.connect('room-1', 'alice', alice.send);
    manager.connect('room-1', 'bob', bob.send);
    manager.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    manager.handleMessage('bob', { type: 'sfu-join', downlinkKbps: 6000 });
    manager.handleMessage('alice', { type: 'sfu-publish', layers: LAYERS });
    bob.messages.length = 0;

    manager.disconnect('alice');
    assert.ok(bob.messages.some((m) => m.type === 'sfu-producer-removed'));
    assert.equal(manager.getRoomParticipantCount('room-1'), 1);
  });

  it('moves a reconnecting participant out of its previous room', () => {
    const manager = new SfuManager();
    const alice = recorder();
    manager.connect('room-1', 'alice', alice.send);
    manager.handleMessage('alice', { type: 'sfu-join', downlinkKbps: 6000 });
    assert.equal(manager.getRoomParticipantCount('room-1'), 1);

    manager.connect('room-2', 'alice', alice.send);
    assert.equal(manager.getRoomCount(), 1);
    assert.equal(manager.getRoomParticipantCount('room-1'), 0);
    assert.equal(manager.getRoomParticipantCount('room-2'), 1);
  });

  it('requires a room and participant id to connect', () => {
    const manager = new SfuManager();
    const alice = recorder();
    assert.throws(() => manager.connect('', 'alice', alice.send), /required/);
    assert.throws(() => manager.connect('room-1', '', alice.send), /required/);
  });
});
