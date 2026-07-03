import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkspaceTeamCatalogMember } from '@studio/shared';
import type { SavedWorkspaceTeamMember } from '../src/utils/workspaceTeam.ts';
import {
  buildWorkspaceTeamCatalogUpsertRequest,
  catalogMemberToSavedWorkspaceTeamMember,
  mergeWorkspaceTeamCatalogMembers,
} from '../src/utils/workspaceTeamCatalog.ts';

const savedMember: SavedWorkspaceTeamMember = {
  id: 'member-1',
  name: 'Producer',
  email: 'producer@example.com',
  role: 'producer',
  createdAt: '2026-07-02T10:00:00.000Z',
};

describe('workspace team catalog client helpers', () => {
  it('builds bounded server upsert payloads from saved team members', () => {
    assert.deepEqual(buildWorkspaceTeamCatalogUpsertRequest(savedMember), {
      id: 'member-1',
      name: 'Producer',
      email: 'producer@example.com',
      role: 'producer',
      createdAt: '2026-07-02T10:00:00.000Z',
    });
  });

  it('converts server catalog entries back to local dashboard team members', () => {
    const entry: WorkspaceTeamCatalogMember = {
      ...savedMember,
      roomId: 'room-1',
      updatedAt: '2026-07-02T10:05:00.000Z',
    };

    assert.deepEqual(catalogMemberToSavedWorkspaceTeamMember(entry), savedMember);
  });

  it('merges cloud members into the local roster while preserving local edits', () => {
    const merged = mergeWorkspaceTeamCatalogMembers([
      {
        ...savedMember,
        name: 'Local Producer',
      },
    ], [
      {
        ...savedMember,
        roomId: 'room-1',
        updatedAt: '2026-07-02T10:05:00.000Z',
      },
      {
        id: 'member-2',
        roomId: 'room-1',
        name: 'Guest Manager',
        email: 'guest-manager@example.com',
        role: 'guest-manager',
        createdAt: '2026-07-02T11:00:00.000Z',
        updatedAt: '2026-07-02T11:05:00.000Z',
      },
    ]);

    assert.deepEqual(merged.map((member) => member.id), ['member-1', 'member-2']);
    assert.equal(merged[0].name, 'Local Producer');
    assert.equal(merged[1].role, 'guest-manager');
  });
});
