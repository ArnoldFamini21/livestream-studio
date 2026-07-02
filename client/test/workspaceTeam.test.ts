import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
});
