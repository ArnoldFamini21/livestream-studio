import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SfuRouter,
  selectSimulcastLayer,
  type SimulcastLayer,
} from './sfuRouter.js';

const LAYERS: SimulcastLayer[] = [
  { rid: 'h', bitrateKbps: 2800, scaleResolutionDownBy: 1 },
  { rid: 'm', bitrateKbps: 1200, scaleResolutionDownBy: 2 },
  { rid: 'l', bitrateKbps: 350, scaleResolutionDownBy: 4 },
];

describe('selectSimulcastLayer', () => {
  it('returns null when a producer has no layers', () => {
    assert.deepEqual(selectSimulcastLayer([], 5000), { rid: null, reason: 'no-layers' });
  });

  it('picks the highest layer that fits the budget for a fresh consumer', () => {
    assert.deepEqual(selectSimulcastLayer(LAYERS, 5000), { rid: 'h', reason: 'fits' });
    assert.deepEqual(selectSimulcastLayer(LAYERS, 1500), { rid: 'm', reason: 'fits' });
    assert.deepEqual(selectSimulcastLayer(LAYERS, 400), { rid: 'l', reason: 'fits' });
  });

  it('forwards the lowest layer when starved by default', () => {
    assert.deepEqual(selectSimulcastLayer(LAYERS, 100), { rid: 'l', reason: 'degraded' });
  });

  it('pauses instead of degrading when configured', () => {
    assert.deepEqual(
      selectSimulcastLayer(LAYERS, 100, null, { forwardLowestWhenStarved: false }),
      { rid: null, reason: 'paused' }
    );
  });

  it('downgrades immediately when the current layer no longer fits', () => {
    // Budget 1500 fits 'm' (1200) but not 'h' (2800), so 'h' downgrades to 'm'.
    assert.deepEqual(selectSimulcastLayer(LAYERS, 1500, 'h'), { rid: 'm', reason: 'downgrade' });
  });

  it('holds the current layer until the budget clears the upgrade margin', () => {
    // 'h' (2800) nominally fits at 2900 but not past the 1.15 margin, so stay on 'm'.
    assert.deepEqual(selectSimulcastLayer(LAYERS, 2900, 'm'), { rid: 'm', reason: 'held' });
    // At 3220 (2800 * 1.15) the upgrade to 'h' is allowed.
    assert.deepEqual(selectSimulcastLayer(LAYERS, 3220, 'm'), { rid: 'h', reason: 'fits' });
  });

  it('stays on the current layer when it is already the best fit', () => {
    assert.deepEqual(selectSimulcastLayer(LAYERS, 1500, 'm'), { rid: 'm', reason: 'held' });
  });

  it('takes the best fit when the current rid no longer exists', () => {
    assert.deepEqual(selectSimulcastLayer(LAYERS, 1500, 'x'), { rid: 'm', reason: 'fits' });
  });
});

describe('SfuRouter', () => {
  it('tracks producers and consumers', () => {
    const router = new SfuRouter();
    router.addProducer('alice', LAYERS);
    router.addProducer('bob', LAYERS);
    router.addConsumer('carol', 5000);
    assert.equal(router.getProducerCount(), 2);
    assert.equal(router.getConsumerCount(), 1);
  });

  it('produces no decisions without subscriptions', () => {
    const router = new SfuRouter();
    router.addProducer('alice', LAYERS);
    router.addConsumer('carol', 5000);
    assert.deepEqual(router.computeForwardingDecisions(), []);
  });

  it('forwards the best-fit layer per subscription and marks changes once', () => {
    const router = new SfuRouter();
    router.addProducer('alice', LAYERS);
    router.addConsumer('carol', 5000);
    router.subscribe('carol', 'alice');

    const first = router.computeForwardingDecisions();
    assert.equal(first.length, 1);
    assert.equal(first[0].rid, 'h');
    assert.equal(first[0].changed, true);

    // Recomputing with no change should report changed = false.
    const second = router.computeForwardingDecisions();
    assert.equal(second[0].rid, 'h');
    assert.equal(second[0].changed, false);
  });

  it('splits a consumer downlink evenly across subscriptions', () => {
    const router = new SfuRouter();
    router.addProducer('alice', LAYERS);
    router.addProducer('bob', LAYERS);
    router.addConsumer('carol', 2400); // 1200 per stream -> 'm' each
    router.subscribe('carol', 'alice');
    router.subscribe('carol', 'bob');

    const decisions = router.computeForwardingDecisions();
    assert.equal(decisions.length, 2);
    assert.ok(decisions.every((decision) => decision.rid === 'm'));
  });

  it('downgrades forwarded layers when the downlink drops', () => {
    const router = new SfuRouter();
    router.addProducer('alice', LAYERS);
    router.addConsumer('carol', 5000);
    router.subscribe('carol', 'alice');
    assert.equal(router.computeForwardingDecisions()[0].rid, 'h');

    router.setConsumerDownlink('carol', 1500);
    const decisions = router.computeForwardingDecisions();
    assert.equal(decisions[0].rid, 'm');
    assert.equal(decisions[0].reason, 'downgrade');
    assert.equal(decisions[0].changed, true);
  });

  it('drops subscriptions and active layers when a producer leaves', () => {
    const router = new SfuRouter();
    router.addProducer('alice', LAYERS);
    router.addConsumer('carol', 5000);
    router.subscribe('carol', 'alice');
    router.computeForwardingDecisions();

    router.removeProducer('alice');
    assert.deepEqual(router.computeForwardingDecisions(), []);
  });

  it('unsubscribes a single producer without affecting others', () => {
    const router = new SfuRouter();
    router.addProducer('alice', LAYERS);
    router.addProducer('bob', LAYERS);
    router.addConsumer('carol', 6000);
    router.subscribe('carol', 'alice');
    router.subscribe('carol', 'bob');
    router.computeForwardingDecisions();

    router.unsubscribe('carol', 'alice');
    const decisions = router.computeForwardingDecisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].producerId, 'bob');
  });
});
