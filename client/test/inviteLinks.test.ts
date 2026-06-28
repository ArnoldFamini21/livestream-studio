import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGuestInviteDetails,
  buildGuestInviteEmailHref,
  buildGuestInviteUrl,
  getInviteStudioName,
  normalizeInviteEmailRecipient,
  normalizeInviteStudioName,
} from '../src/utils/inviteLinks.ts';

describe('guest invite links', () => {
  it('embeds the studio name in guest join links', () => {
    assert.equal(
      buildGuestInviteUrl('https://studio.example.com/', 'room 1', 'Launch Show: Episode 1'),
      'https://studio.example.com/join/room%201?studio=Launch%20Show%3A%20Episode%201'
    );
  });

  it('omits empty studio names and normalizes unsafe labels', () => {
    assert.equal(
      buildGuestInviteUrl('https://studio.example.com', 'abc123', ' \n\t '),
      'https://studio.example.com/join/abc123'
    );
    assert.equal(
      normalizeInviteStudioName('  Launch\x00\nShow   '),
      'Launch Show'
    );
  });

  it('reads bounded studio labels from search params', () => {
    const params = new URLSearchParams({
      studio: `${'A'.repeat(90)}\nHidden`,
    });

    assert.equal(getInviteStudioName(params), 'A'.repeat(80));
  });

  it('builds reusable guest invite email details', () => {
    assert.equal(
      buildGuestInviteDetails({
        roomName: 'Launch Show',
        hostName: 'Arnold',
        status: 'Upcoming',
        scheduledLabel: 'Jun 28, 2026, 8:00 PM',
        inviteUrl: 'https://studio.example.com/join/abc123',
        passwordProtected: true,
      }),
      [
        'Launch Show',
        'Host: Arnold',
        'Status: Upcoming',
        'Time: Jun 28, 2026, 8:00 PM',
        'Join: https://studio.example.com/join/abc123',
        'Password protected. Ask the host for the password.',
      ].join('\n')
    );
  });

  it('builds recipient-aware mailto links for guest invites', () => {
    const href = buildGuestInviteEmailHref({
      roomName: 'Launch Show',
      hostName: 'Arnold',
      status: 'Studio waiting room',
      inviteUrl: 'https://studio.example.com/join/abc123',
      recipientEmail: ' guest@example.com ',
    });

    assert.match(href, /^mailto:guest%40example\.com\?/);
    assert.match(href, /subject=Join%20Launch%20Show/);
    assert.match(decodeURIComponent(href), /Join: https:\/\/studio\.example\.com\/join\/abc123/);
  });

  it('normalizes guest invite email recipients without preserving whitespace', () => {
    assert.equal(normalizeInviteEmailRecipient(' guest \n@example.com '), 'guest@example.com');
    assert.equal(normalizeInviteEmailRecipient(null), '');
  });
});
