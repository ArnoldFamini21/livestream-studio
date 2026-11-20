import assert from 'node:assert/strict';
import test from 'node:test';
import type { StreamDestination } from '@studio/shared';
import { getDualOutputSupport, getSecondaryProgramRects, planBroadcastDestinations } from '../src/utils/dualOutput.ts';
import { restoreStreamDestinations, serializeStreamDestinations } from '../src/utils/streamDestinationStorage.ts';

const wide: StreamDestination = {
  id: 'main', platform: 'custom', name: 'Main', rtmpUrl: 'rtmp://example.org/live', streamKey: 'wide',
  enabled: true, status: 'idle',
};
const portrait: StreamDestination = { ...wide, id: 'second', name: 'Second', streamKey: 'tall', orientation: 'portrait' };

test('separates enabled destinations by orientation without changing single-program output', () => {
  const input = [wide, portrait, { ...wide, id: 'off', enabled: false }];
  const dual = planBroadcastDestinations(input, 'landscape', true);
  assert.deepEqual(dual.primary.map(({ id, orientation }) => [id, orientation]), [['main', 'landscape']]);
  assert.deepEqual(dual.secondary.map(({ id, orientation }) => [id, orientation]), [['second', 'portrait']]);
  assert.equal(dual.issue, null);
  const single = planBroadcastDestinations(input, 'landscape', false);
  assert.deepEqual(single.primary.map(({ id, orientation }) => [id, orientation]), [['main', undefined], ['second', undefined]]);
  assert.deepEqual(single.secondary, []);
  assert.match(planBroadcastDestinations(input, 'portrait', true).issue || '', /at least one/);
  assert.match(planBroadcastDestinations([wide, { ...portrait, streamKey: '/wide' }], 'landscape', true).issue || '', /different/);
});

test('restores destination orientation without remembering a stream key by default', () => {
  const saved = serializeStreamDestinations([portrait]);
  assert.equal(saved[0].streamKey, undefined);
  const restored = restoreStreamDestinations(saved);
  assert.equal(restored[0].orientation, 'portrait');
  assert.equal(restored[0].enabled, false);
});

test('enables dual output only with a copy encoder and a supporting media server', () => {
  const health = { status: 'ready' as const, mediaHttpUrl: '', message: '', checkedAt: null };
  assert.match(getDualOutputSupport(health, true) || '', /does not support/);
  const capable = { ...health, dualOutput: { ready: true, message: '' } };
  assert.equal(getDualOutputSupport(capable, true), null);
  assert.match(getDualOutputSupport(capable, false) || '', /H.264/);
});

test('places alternate-grid and spotlight tiles in the correct canvas independently of the main layout', () => {
  const portraitGrid = getSecondaryProgramRects('portrait', 'grid', 3);
  assert.equal(portraitGrid.length, 3);
  assert.equal(portraitGrid[0].left, portraitGrid[1].left);
  assert.ok(portraitGrid[0].top < portraitGrid[1].top);
  const spotlight = getSecondaryProgramRects('landscape', 'spotlight', 6);
  assert.ok(spotlight[0].width > spotlight[1].width);
  assert.ok(spotlight[0].left < spotlight[1].left);
  for (const rect of [...portraitGrid, ...spotlight]) {
    assert.ok(rect.left >= 0 && rect.top >= 0 && rect.left + rect.width <= 1 && rect.top + rect.height <= 1);
  }
  assert.equal(getSecondaryProgramRects('landscape', 'solo', 5).length, 1);
});
