import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getStagePresenceTransitionDelayMs,
  getStagePresenceWrapperStyle,
  reconcileStagePresenceItems,
} from '../src/utils/stagePresenceTransitions.ts';

const host = { id: 'host', name: 'Host' };
const guest = { id: 'guest', name: 'Guest' };

describe('stage presence transitions', () => {
  it('marks new stage items as entering and then settles them as present', () => {
    const entering = reconcileStagePresenceItems([host], [], 1000);
    assert.deepEqual(entering.map((item) => item.phase), ['entering']);

    const present = reconcileStagePresenceItems([host], entering, 1400);
    assert.deepEqual(present.map((item) => item.phase), ['present']);
    assert.equal(present[0].item.name, 'Host');
  });

  it('keeps removed items alive while they animate out, then drops them', () => {
    const previous = reconcileStagePresenceItems([host, guest], [], 1000);
    const settled = reconcileStagePresenceItems([host, guest], previous, 1400);
    const leaving = reconcileStagePresenceItems([host], settled, 1450);

    assert.deepEqual(leaving.map((item) => `${item.item.id}:${item.phase}`), ['host:present', 'guest:leaving']);
    assert.equal(leaving[1].item.name, 'Guest');

    const dropped = reconcileStagePresenceItems([host], leaving, 1800);
    assert.deepEqual(dropped.map((item) => item.item.id), ['host']);
  });

  it('restarts the entrance animation when a leaving item returns', () => {
    const previous = reconcileStagePresenceItems([host], [], 1000);
    const leaving = reconcileStagePresenceItems([], previous, 1100);
    const returned = reconcileStagePresenceItems([{ id: 'host', name: 'Host returned' }], leaving, 1120);

    assert.equal(returned.length, 1);
    assert.equal(returned[0].phase, 'entering');
    assert.equal(returned[0].item.name, 'Host returned');
  });

  it('reports the next timer delay for active transitions', () => {
    const entering = reconcileStagePresenceItems([host], [], 1000);
    assert.equal(getStagePresenceTransitionDelayMs(entering, 1200), 136);

    const present = reconcileStagePresenceItems([host], entering, 1400);
    assert.equal(getStagePresenceTransitionDelayMs(present, 1400), 0);
  });

  it('builds bounded animation styles for entering and leaving tiles', () => {
    const entering = getStagePresenceWrapperStyle('entering', { enterMs: 10 });
    assert.match(String(entering.animation), /stage-presence-enter 120ms/);
    assert.equal(entering.pointerEvents, undefined);

    const leaving = getStagePresenceWrapperStyle('leaving', { exitMs: 2000 });
    assert.match(String(leaving.animation), /stage-presence-leave 1500ms/);
    assert.equal(leaving.pointerEvents, 'none');

    assert.deepEqual(getStagePresenceWrapperStyle('present'), {});
  });
});
