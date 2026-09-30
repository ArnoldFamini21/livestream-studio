import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARRIVAL_CHIME_MIN_GAP_MS, planArrivalAlert } from '../src/utils/guestArrivalAlert.ts';

describe('guest arrival alert', () => {
  const base = { tabHidden: false, notificationPermission: 'granted' as const, lastChimeAt: null, now: 10_000 };

  it('chimes for the first arrival and for arrivals after a pause', () => {
    assert.equal(planArrivalAlert(base).chime, true);
    assert.equal(planArrivalAlert({ ...base, lastChimeAt: base.now - ARRIVAL_CHIME_MIN_GAP_MS }).chime, true);
  });

  it('chimes once for guests arriving together', () => {
    assert.equal(planArrivalAlert({ ...base, lastChimeAt: base.now - 500 }).chime, false);
  });

  it('notifies only when the studio tab is hidden and notifications are allowed', () => {
    assert.equal(planArrivalAlert(base).notify, false);
    assert.equal(planArrivalAlert({ ...base, tabHidden: true }).notify, true);
    for (const notificationPermission of ['default', 'denied', 'unsupported'] as const) {
      assert.equal(planArrivalAlert({ ...base, tabHidden: true, notificationPermission }).notify, false);
    }
  });
});
