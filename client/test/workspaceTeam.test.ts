import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildWorkspaceTeamStudioInviteDetails,
  buildWorkspaceTeamStudioInviteEmailHref,
  canUseWorkspaceOperatorLink,
  createWorkspaceTeamMember,
  getWorkspaceTeamRoleLabel,
  normalizeWorkspaceTeamMembers,
  parseSavedWorkspaceTeamMembers,
  removeWorkspaceTeamMember,
  serializeWorkspaceTeamMembers,
  upsertWorkspaceTeamMember,
} from '../src/utils/workspaceTeam.ts';

describe('workspace team roster', () => {
  it('creates sanitized team members with stable roles', () => {
    assert.deepEqual(createWorkspaceTeamMember({
      id: 'producer-1',
      name: '  Arnold Famini  ',
      email: 'ARNOLD@example.COM',
      role: 'producer',
      createdAt: '2026-07-02T10:00:00.000Z',
    }), {
      id: 'producer-1',
      name: 'Arnold Famini',
      email: 'arnold@example.com',
      role: 'producer',
      createdAt: '2026-07-02T10:00:00.000Z',
    });

    assert.equal(createWorkspaceTeamMember({ name: '' }), null);
    assert.equal(getWorkspaceTeamRoleLabel('guest-manager'), 'Guest Manager');
    assert.equal(canUseWorkspaceOperatorLink('owner'), true);
    assert.equal(canUseWorkspaceOperatorLink('producer'), true);
    assert.equal(canUseWorkspaceOperatorLink('editor'), false);
    assert.equal(canUseWorkspaceOperatorLink('guest-manager'), false);
  });

  it('normalizes, dedupes, serializes, and parses roster members', () => {
    const members = normalizeWorkspaceTeamMembers([
      {
        id: 'b',
        name: 'Blake',
        email: 'bad email',
        role: 'invalid',
        createdAt: '2026-07-03T10:00:00.000Z',
      },
      {
        id: 'a',
        name: 'Ari',
        email: 'ari@example.com',
        role: 'owner',
        createdAt: '2026-07-02T10:00:00.000Z',
      },
      {
        id: 'a',
        name: 'Ari Updated',
        email: 'ari@studio.example',
        role: 'editor',
        createdAt: '2026-07-04T10:00:00.000Z',
      },
      { id: '', name: '' },
    ]);

    assert.deepEqual(members.map((member) => [member.id, member.name, member.email, member.role]), [
      ['b', 'Blake', '', 'producer'],
      ['a', 'Ari Updated', 'ari@studio.example', 'editor'],
    ]);

    assert.deepEqual(parseSavedWorkspaceTeamMembers(serializeWorkspaceTeamMembers(members)), members);
    assert.deepEqual(parseSavedWorkspaceTeamMembers('not-json'), []);
  });

  it('upserts and removes members through normalized roster operations', () => {
    const owner = createWorkspaceTeamMember({
      id: 'owner-1',
      name: 'Owner',
      role: 'owner',
      createdAt: '2026-07-02T10:00:00.000Z',
    });
    const producer = createWorkspaceTeamMember({
      id: 'producer-1',
      name: 'Producer',
      role: 'producer',
      createdAt: '2026-07-03T10:00:00.000Z',
    });

    assert.ok(owner);
    assert.ok(producer);

    const roster = upsertWorkspaceTeamMember([owner], producer);
    assert.deepEqual(roster.map((member) => member.id), ['owner-1', 'producer-1']);
    assert.deepEqual(removeWorkspaceTeamMember(roster, 'owner-1').map((member) => member.id), ['producer-1']);
  });

  it('builds role-aware team invite email links for a studio', () => {
    const owner = createWorkspaceTeamMember({
      id: 'owner-1',
      name: 'Owner',
      email: 'owner@example.com',
      role: 'owner',
      createdAt: '2026-07-02T10:00:00.000Z',
    });
    const producer = createWorkspaceTeamMember({
      id: 'producer-1',
      name: 'Producer',
      email: 'owner@example.com',
      role: 'producer',
      createdAt: '2026-07-02T11:00:00.000Z',
    });
    const editor = createWorkspaceTeamMember({
      id: 'editor-1',
      name: 'Editor',
      email: 'editor@example.com',
      role: 'editor',
      createdAt: '2026-07-02T12:00:00.000Z',
    });
    const guestManager = createWorkspaceTeamMember({
      id: 'guest-manager-1',
      name: 'Guest Manager',
      email: 'guest@example.com',
      role: 'guest-manager',
      createdAt: '2026-07-02T13:00:00.000Z',
    });

    assert.ok(owner);
    assert.ok(producer);
    assert.ok(editor);
    assert.ok(guestManager);

    const input = {
      roomName: 'Launch Studio',
      hostName: 'Arnold',
      scheduledLabel: 'July 5, 2026, 6:00 PM',
      passwordProtected: true,
      guestInviteUrl: 'https://studio.example.com/join/room-1',
      hostEntryUrl: 'https://studio.example.com/join/room-1?role=host#hostToken=private-token',
      members: [editor, owner, producer, guestManager],
    };
    const details = buildWorkspaceTeamStudioInviteDetails(input);

    assert.match(details, /Owner \(Owner\): https:\/\/studio\.example\.com\/join\/room-1\?role=host#hostToken=private-token/);
    assert.match(details, /Producer \(Producer\): https:\/\/studio\.example\.com\/join\/room-1\?role=host#hostToken=private-token/);
    assert.match(details, /Editor \(Editor\): https:\/\/studio\.example\.com\/join\/room-1$/m);
    assert.match(details, /Guest Manager \(Guest Manager\): https:\/\/studio\.example\.com\/join\/room-1$/m);
    assert.match(details, /private operator access/);

    const href = buildWorkspaceTeamStudioInviteEmailHref(input);
    assert.match(href, /^mailto:owner%40example\.com,editor%40example\.com,guest%40example\.com\?/);
    assert.match(decodeURIComponent(href), /subject=Production team invite: Launch Studio/);
    assert.match(decodeURIComponent(href), /Owner \(Owner\): https:\/\/studio\.example\.com\/join\/room-1\?role=host#hostToken=private-token/);
  });

  it('drops unsafe team invite urls before composing details', () => {
    const producer = createWorkspaceTeamMember({
      id: 'producer-1',
      name: 'Producer',
      email: 'producer@example.com',
      role: 'producer',
      createdAt: '2026-07-02T10:00:00.000Z',
    });
    assert.ok(producer);

    const details = buildWorkspaceTeamStudioInviteDetails({
      roomName: 'Security Check',
      guestInviteUrl: 'javascript:alert(1)',
      hostEntryUrl: 'ftp://example.com/private',
      members: [producer],
    });

    assert.doesNotMatch(details, /javascript:/);
    assert.doesNotMatch(details, /ftp:/);
  });
});
