import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getToastDurationMs,
  getToastRole,
  pauseToastTimer,
  resumeToastTimer,
  selectToastsToKeep,
} from '../src/utils/toastPolicy.ts';

describe('toast policy', () => {
  it('keeps errors until dismissed and gives warnings longer to read', () => {
    assert.equal(getToastDurationMs('error'), 0);
    assert.equal(getToastDurationMs('warning'), 8_000);
    assert.equal(getToastDurationMs('info'), 5_000);
    assert.equal(getToastDurationMs('error', 6_000), 6_000);
    assert.equal(getToastDurationMs('info', -1), 5_000);
  });

  it('only interrupts screen readers for errors', () => {
    assert.equal(getToastRole('error'), 'alert');
    assert.equal(getToastRole('warning'), 'status');
    assert.equal(getToastRole('success'), 'status');
  });

  it('pauses the countdown on hover or focus and resumes with time to read', () => {
    const paused = pauseToastTimer({ remainingMs: 5_000, startedAt: 1_000 }, 3_000);
    assert.deepEqual(paused, { remainingMs: 3_000, startedAt: null });
    assert.deepEqual(pauseToastTimer(paused, 9_000), paused);
    assert.deepEqual(resumeToastTimer(paused, 10_000), { remainingMs: 3_000, startedAt: 10_000 });
    assert.equal(resumeToastTimer({ remainingMs: 100, startedAt: null }, 0).remainingMs, 2_000);
  });

  it('drops the oldest dismissible toast before a persistent error', () => {
    const toasts = [
      { id: 'e1', persistent: true },
      { id: 'i1', persistent: false },
      { id: 'i2', persistent: false },
      { id: 'e2', persistent: true },
      { id: 'i3', persistent: false },
    ];
    assert.deepEqual(selectToastsToKeep(toasts, 4).map((toast) => toast.id), ['e1', 'i2', 'e2', 'i3']);
    const allPersistent = [{ id: 'a', persistent: true }, { id: 'b', persistent: true }];
    assert.deepEqual(selectToastsToKeep(allPersistent, 1).map((toast) => toast.id), ['b']);
  });
});
