import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildInviteEmail, InviteEmailError, validateInviteEmailRequest } from '../dist/services/inviteEmail.js';

const ORIGINS = ['https://studio.arnoldfamini.com', 'http://localhost:5173'];

describe('invite email', () => {
  it('accepts a guest invite that points at the studio', () => {
    const request = validateInviteEmailRequest({
      to: ' nica@example.com ',
      role: 'guest',
      inviteUrl: 'https://studio.arnoldfamini.com/join/abc123?invite=xyz',
      roomName: 'Sabbath Service',
      hostName: 'Arnold',
      expiresAt: '2026-10-01T02:00:00.000Z',
      passwordProtected: true,
    }, ORIGINS);
    assert.equal(request.to, 'nica@example.com');
    assert.equal(request.role, 'guest');
    assert.equal(request.passwordProtected, true);
    assert.equal(request.expiresAt, '2026-10-01T02:00:00.000Z');
  });

  it('refuses bad addresses, roles, and links to other sites', () => {
    const base = { to: 'nica@example.com', role: 'guest', inviteUrl: 'https://studio.arnoldfamini.com/join/abc', roomName: 'X' };
    for (const [patch, code] of [
      [{ to: 'not-an-email' }, 'INVALID_EMAIL'],
      [{ role: 'admin' }, 'INVALID_ROLE'],
      [{ inviteUrl: 'https://evil.example/join/abc' }, 'INVALID_INVITE_URL'],
      [{ inviteUrl: 'javascript:alert(1)' }, 'INVALID_INVITE_URL'],
      [{ inviteUrl: '' }, 'INVALID_INVITE_URL'],
    ]) {
      assert.throws(() => validateInviteEmailRequest({ ...base, ...patch }, ORIGINS), (err) => err instanceof InviteEmailError && err.code === code, code);
    }
  });

  it('writes the invite with the link, role, and timing, escaping HTML', () => {
    const email = buildInviteEmail({
      to: 'nica@example.com',
      role: 'co-host',
      inviteUrl: 'https://studio.arnoldfamini.com/join/abc?x=1&y=2',
      roomName: 'Vespers <Live>',
      hostName: 'Arnold',
      scheduledFor: '2026-10-03T10:00:00.000Z',
      expiresAt: '2026-10-03T14:00:00.000Z',
    });
    assert.equal(email.subject, 'Arnold invited you to join "Vespers <Live>" as a co-host');
    assert.match(email.text, /Join here: https:\/\/studio\.arnoldfamini\.com\/join\/abc\?x=1&y=2/);
    assert.match(email.text, /When: .*October 3, 2026.*6:00 PM \(Manila time\)/i);
    assert.match(email.text, /expires on/);
    assert.match(email.text, /co-host/);
    assert.match(email.html, /Vespers &lt;Live&gt;/);
    assert.match(email.html, /href="https:\/\/studio\.arnoldfamini\.com\/join\/abc\?x=1&amp;y=2"/);
    assert.doesNotMatch(email.html, /<Live>/);
  });
});
