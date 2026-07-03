import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkspaceStudioCatalogEntry } from '@studio/shared';
import type { SavedHostStudio } from '../src/utils/hostSession.ts';
import {
  buildWorkspaceStudioCatalogUpsertRequest,
  catalogStudioToSavedHostStudio,
  mergeWorkspaceStudioCatalogEntries,
} from '../src/utils/workspaceStudioCatalog.ts';

const savedStudio: SavedHostStudio = {
  id: 'studio-1',
  name: 'Sermon Studio',
  hostName: 'Arnold',
  hostToken: 'StudioHostToken_1234567890',
  createdAt: '2026-07-02T10:00:00.000Z',
  scheduledFor: '2026-07-05T18:00:00.000Z',
  passwordProtected: true,
  registrationEnabled: true,
  status: 'scheduled',
};

describe('workspace studio catalog client helpers', () => {
  it('builds bounded server upsert payloads from saved studios', () => {
    assert.deepEqual(buildWorkspaceStudioCatalogUpsertRequest(savedStudio), {
      id: 'studio-1',
      name: 'Sermon Studio',
      hostName: 'Arnold',
      hostToken: 'StudioHostToken_1234567890',
      createdAt: '2026-07-02T10:00:00.000Z',
      scheduledFor: '2026-07-05T18:00:00.000Z',
      passwordProtected: true,
      registrationEnabled: true,
      status: 'scheduled',
    });
  });

  it('converts server catalog entries back to local saved host studios', () => {
    const entry: WorkspaceStudioCatalogEntry = {
      ...savedStudio,
      name: savedStudio.name || 'Sermon Studio',
      updatedAt: '2026-07-02T10:05:00.000Z',
    };

    assert.deepEqual(catalogStudioToSavedHostStudio(entry), savedStudio);
  });

  it('merges cloud studios into the dashboard while preserving local edits', () => {
    const merged = mergeWorkspaceStudioCatalogEntries([
      {
        ...savedStudio,
        name: 'Local Sermon Studio',
      },
    ], [
      {
        ...savedStudio,
        name: 'Cloud Sermon Studio',
        updatedAt: '2026-07-02T10:05:00.000Z',
      },
      {
        id: 'studio-2',
        name: 'Workshop',
        hostName: 'Arnold',
        hostToken: 'WorkshopHostToken_1234567890',
        createdAt: '2026-07-03T10:00:00.000Z',
        passwordProtected: false,
        registrationEnabled: false,
        status: 'waiting',
        updatedAt: '2026-07-03T10:05:00.000Z',
      },
    ]);

    assert.deepEqual(merged.map((studio) => studio.id), ['studio-2', 'studio-1']);
    assert.equal(merged[0].name, 'Workshop');
    assert.equal(merged[0].hostToken, 'WorkshopHostToken_1234567890');
    assert.equal(merged[1].name, 'Local Sermon Studio');
  });

  it('does not merge cloud studios without valid private host access', () => {
    const merged = mergeWorkspaceStudioCatalogEntries([], [
      {
        ...savedStudio,
        hostToken: 'short',
        updatedAt: '2026-07-02T10:05:00.000Z',
      },
    ]);

    assert.deepEqual(merged, []);
  });
});
