import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGuestInviteUrl,
  getInviteStudioName,
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
});
