import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterHealthChecksForAudience, summarizeHealthChecks, type HealthCheckLike } from '../src/utils/sessionHealthSummary.ts';
import { describeStudioStatusChange } from '../src/utils/studioStatusAnnouncements.ts';

const check = (id: string, status: HealthCheckLike['status'], label = id): HealthCheckLike => ({ id, label, status, detail: '' });

const allGood = () => [
  check('browser-media', 'good'),
  check('encoding', 'good'),
  check('signaling', 'good'),
  check('turn-relay', 'good'),
  check('media-server', 'good'),
  check('network', 'good'),
  check('audio', 'good'),
  check('video', 'good'),
  check('storage', 'good'),
  check('capacity', 'good'),
  check('participant-connections', 'good'),
];

function replace(checks: HealthCheckLike[], id: string, status: HealthCheckLike['status']) {
  return checks.map((item) => (item.id === id ? { ...item, status } : item));
}

describe('session health status', () => {
  it('reads Good when everything is fine', () => {
    const summary = summarizeHealthChecks(allGood());
    assert.equal(summary.status, 'good');
    assert.equal(summary.label, 'Good');
    assert.equal(summary.score, 100);
  });

  it('never averages away a blocked mic and camera', () => {
    // The old average gave 80 ("Ready") for exactly this.
    let checks = replace(replace(allGood(), 'audio', 'bad'), 'video', 'bad');
    checks = [...checks, check('media-error', 'warning', 'Media warning')];
    const summary = summarizeHealthChecks(checks);
    assert.equal(summary.status, 'bad');
    assert.equal(summary.label, 'Check mic');
    assert.equal(summary.focusCheckId, 'audio');
  });

  it('puts a lost connection ahead of device problems', () => {
    const summary = summarizeHealthChecks(replace(replace(allGood(), 'audio', 'bad'), 'signaling', 'bad'));
    assert.equal(summary.label, 'Not connected');
  });

  it('names a non-essential problem for the host', () => {
    const summary = summarizeHealthChecks(replace(replace(replace(allGood(), 'turn-relay', 'bad'), 'media-server', 'bad'), 'storage', 'bad'));
    assert.equal(summary.status, 'warning');
    assert.equal(summary.label, 'Check relay');
  });

  it('keeps relay and server details away from guests', () => {
    const checks = replace(replace(allGood(), 'turn-relay', 'bad'), 'media-server', 'warning');
    const guest = summarizeHealthChecks(checks, 'guest');
    assert.equal(guest.status, 'good');
    assert.equal(guest.label, 'All set');
    const visible = filterHealthChecksForAudience(checks, 'guest').map((item) => item.id);
    assert.ok(!visible.includes('turn-relay'));
    assert.ok(!visible.includes('media-server'));
    assert.ok(visible.includes('audio'));
    assert.equal(summarizeHealthChecks(replace(checks, 'video', 'bad'), 'guest').label, 'Check camera');
  });
});

describe('recording and live announcements', () => {
  it('announces starts, stops, pauses and going live', () => {
    const idle = { recording: false, paused: false, live: false };
    assert.equal(describeStudioStatusChange(null, idle), null);
    assert.equal(describeStudioStatusChange(idle, { ...idle, recording: true }), 'Recording started.');
    assert.equal(describeStudioStatusChange({ ...idle, recording: true }, { ...idle, recording: true, paused: true }), 'Recording paused.');
    assert.equal(describeStudioStatusChange({ ...idle, recording: true, paused: true }, { ...idle, recording: true }), 'Recording resumed.');
    assert.equal(describeStudioStatusChange({ ...idle, recording: true }, idle), 'Recording stopped.');
    assert.equal(describeStudioStatusChange(idle, { ...idle, live: true }), 'You are live.');
    assert.equal(describeStudioStatusChange({ ...idle, live: true }, idle), 'The live stream has ended.');
    assert.equal(describeStudioStatusChange(idle, idle), null);
  });
});
