import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SfuClientSession,
  encodingsToWireLayers,
  type SfuClientOutbound,
} from '../src/utils/sfuClient.ts';

function createSession(events = {}) {
  const sent: SfuClientOutbound[] = [];
  const session = new SfuClientSession((message) => sent.push(message), events);
  return { session, sent };
}

describe('encodingsToWireLayers', () => {
  it('maps simulcast encodings to compact wire layers in kbps', () => {
    const layers = encodingsToWireLayers([
      { rid: 'h', maxBitrate: 2_800_000, scaleResolutionDownBy: 1 },
      { rid: 'm', maxBitrate: 1_200_000, scaleResolutionDownBy: 2 },
      { rid: 'l', maxBitrate: 350_000, scaleResolutionDownBy: 4 },
    ]);
    assert.deepEqual(layers, [
      { rid: 'h', bitrateKbps: 2800, scaleResolutionDownBy: 1 },
      { rid: 'm', bitrateKbps: 1200, scaleResolutionDownBy: 2 },
      { rid: 'l', bitrateKbps: 350, scaleResolutionDownBy: 4 },
    ]);
  });

  it('drops encodings without a usable bitrate and defaults rid/scale', () => {
    const layers = encodingsToWireLayers([
      { maxBitrate: 1_000_000 },
      { rid: 'x', maxBitrate: 0 },
      { rid: 'y' } as RTCRtpEncodingParameters,
    ]);
    assert.deepEqual(layers, [{ rid: 's0', bitrateKbps: 1000, scaleResolutionDownBy: 1 }]);
  });
});

describe('SfuClientSession outbound', () => {
  it('sends join with a clamped downlink', () => {
    const { session, sent } = createSession();
    session.join(6000);
    assert.deepEqual(sent, [{ type: 'sfu-join', downlinkKbps: 6000 }]);
  });

  it('publishes wire layers and refuses empty encodings', () => {
    const { session, sent } = createSession();
    assert.equal(session.publish([]), false);
    assert.equal(sent.length, 0);

    const ok = session.publish([{ rid: 'h', maxBitrate: 2_000_000, scaleResolutionDownBy: 1 }]);
    assert.equal(ok, true);
    assert.equal(session.isPublishing(), true);
    assert.equal(sent[0].type, 'sfu-publish');
  });

  it('only re-sends downlink when the estimate moves more than 10%', () => {
    const { session, sent } = createSession();
    session.join(4000);
    sent.length = 0;
    session.reportDownlink(4200); // within 10% -> ignored
    assert.equal(sent.length, 0);
    session.reportDownlink(6000); // >10% -> sent
    assert.deepEqual(sent, [{ type: 'sfu-downlink', downlinkKbps: 6000 }]);
  });

  it('unpublish only fires when publishing', () => {
    const { session, sent } = createSession();
    session.unpublish();
    assert.equal(sent.length, 0);
    session.publish([{ rid: 'h', maxBitrate: 1_000_000, scaleResolutionDownBy: 1 }]);
    sent.length = 0;
    session.unpublish();
    assert.deepEqual(sent, [{ type: 'sfu-unpublish' }]);
  });

  it('leave clears state and only fires when joined', () => {
    const { session, sent } = createSession();
    session.leave();
    assert.equal(sent.length, 0);
    session.join(5000);
    session.handleServerMessage({ type: 'sfu-producers', producers: ['alice'] });
    sent.length = 0;
    session.leave();
    assert.deepEqual(sent, [{ type: 'sfu-leave' }]);
    assert.deepEqual(session.getRemoteProducers(), []);
  });
});

describe('SfuClientSession inbound', () => {
  it('tracks the producer set from the initial list and add/remove events', () => {
    const changes: string[][] = [];
    const { session } = createSession({ onProducersChanged: (p: string[]) => changes.push(p) });
    session.handleServerMessage({ type: 'sfu-producers', producers: ['alice', 'bob'] });
    session.handleServerMessage({ type: 'sfu-producer-added', producerId: 'carol' });
    session.handleServerMessage({ type: 'sfu-producer-removed', producerId: 'alice' });

    assert.deepEqual(session.getRemoteProducers().sort(), ['bob', 'carol']);
    assert.deepEqual(changes[changes.length - 1].sort(), ['bob', 'carol']);
  });

  it('ignores duplicate producer-added and unknown producer-removed', () => {
    let changeCount = 0;
    const { session } = createSession({ onProducersChanged: () => { changeCount += 1; } });
    session.handleServerMessage({ type: 'sfu-producer-added', producerId: 'alice' });
    session.handleServerMessage({ type: 'sfu-producer-added', producerId: 'alice' });
    session.handleServerMessage({ type: 'sfu-producer-removed', producerId: 'ghost' });
    assert.equal(changeCount, 1);
    assert.deepEqual(session.getRemoteProducers(), ['alice']);
  });

  it('records the forwarded layer per producer and emits layer changes', () => {
    const layerChanges: Array<[string, string | null]> = [];
    const { session } = createSession({ onLayerChanged: (id: string, rid: string | null) => layerChanges.push([id, rid]) });
    session.handleServerMessage({ type: 'sfu-layer', producerId: 'alice', rid: 'h' });
    assert.equal(session.getForwardedLayer('alice'), 'h');
    session.handleServerMessage({ type: 'sfu-layer', producerId: 'alice', rid: 'm', reason: 'downgrade' });
    assert.equal(session.getForwardedLayer('alice'), 'm');
    assert.equal(session.getForwardedLayer('bob'), null);
    assert.deepEqual(layerChanges, [['alice', 'h'], ['alice', 'm']]);
  });

  it('surfaces server errors', () => {
    const errors: string[] = [];
    const { session } = createSession({ onError: (message: string) => errors.push(message) });
    session.handleServerMessage({ type: 'sfu-error', message: 'nope' });
    assert.deepEqual(errors, ['nope']);
  });

  it('clears the forwarded layer when its producer is removed', () => {
    const { session } = createSession();
    session.handleServerMessage({ type: 'sfu-producer-added', producerId: 'alice' });
    session.handleServerMessage({ type: 'sfu-layer', producerId: 'alice', rid: 'h' });
    session.handleServerMessage({ type: 'sfu-producer-removed', producerId: 'alice' });
    assert.equal(session.getForwardedLayer('alice'), null);
  });
});
