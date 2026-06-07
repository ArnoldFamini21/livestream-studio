import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SCHEDULED_GUEST_EARLY_JOIN_MS,
  buildStudioCalendarInvite,
  getScheduledGuestOpenAtMs,
  isScheduledGuestAccessBlocked,
} from '../dist/index.js';

function unfoldIcs(value) {
  return value.replace(/\r\n[ \t]/g, '');
}

describe('scheduled guest access helpers', () => {
  const scheduledAt = Date.parse('2026-06-07T12:00:00.000Z');
  const scheduledFor = new Date(scheduledAt).toISOString();
  const guestOpenAt = scheduledAt - SCHEDULED_GUEST_EARLY_JOIN_MS;

  it('calculates the guest open time from the scheduled start', () => {
    assert.equal(getScheduledGuestOpenAtMs(scheduledFor), guestOpenAt);
  });

  it('returns null for unscheduled or invalid rooms', () => {
    assert.equal(getScheduledGuestOpenAtMs(undefined), null);
    assert.equal(getScheduledGuestOpenAtMs('not-a-date'), null);
  });

  it('blocks guests before the early join window and opens at the boundary', () => {
    assert.equal(isScheduledGuestAccessBlocked(scheduledFor, guestOpenAt - 1), true);
    assert.equal(isScheduledGuestAccessBlocked(scheduledFor, guestOpenAt), false);
    assert.equal(isScheduledGuestAccessBlocked(scheduledFor, scheduledAt), false);
  });

  it('builds a calendar invite for scheduled studios', () => {
    const invite = buildStudioCalendarInvite({
      roomName: 'Launch Show, Episode 1',
      hostName: 'Arnold',
      inviteUrl: 'https://example.com/join/abc123',
      scheduledFor,
      createdAt: '2026-06-01T00:00:00.000Z',
      durationMinutes: 90,
      uid: 'studio-abc123',
      passwordProtected: true,
    });

    assert.ok(invite);
    const unfolded = unfoldIcs(invite);
    assert.match(unfolded, /BEGIN:VCALENDAR/);
    assert.match(unfolded, /UID:studio-abc123/);
    assert.match(unfolded, /DTSTART:20260607T120000Z/);
    assert.match(unfolded, /DTEND:20260607T133000Z/);
    assert.match(unfolded, /SUMMARY:Launch Show\\, Episode 1/);
    assert.match(unfolded, /DESCRIPTION:Host: Arnold\\nJoin: https:\/\/example.com\/join\/abc123\\nPassword protected/);
    assert.match(unfolded, /END:VCALENDAR/);
  });

  it('does not build a calendar invite without a valid schedule', () => {
    assert.equal(buildStudioCalendarInvite({
      roomName: 'Unscheduled',
      inviteUrl: 'https://example.com/join/abc123',
      scheduledFor: undefined,
    }), null);
  });
});
