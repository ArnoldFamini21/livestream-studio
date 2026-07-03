import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkspaceStudioCatalogEntry } from '@studio/shared';
import type { SavedHostStudio } from '../src/utils/hostSession.ts';
import {
  buildWorkspaceStudioCatalogUpsertRequest,
  catalogStudioToSavedHostStudio,
  deleteAccountWorkspaceStudioCatalogEntry,
  fetchAccountWorkspaceStudioCatalog,
  mergeWorkspaceStudioCatalogEntries,
  syncAccountWorkspaceStudioCatalogEntry,
} from '../src/utils/workspaceStudioCatalog.ts';
import { ACCOUNT_SESSION_STORAGE_KEY } from '../src/utils/accountAuth.ts';

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

class LocalStorageMock {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) || null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

  it('uses account auth for account-scoped saved studio catalog calls', async () => {
    const token = 'AccountSessionToken_123456789012345678901234567890';
    const localStorageMock = new LocalStorageMock();
    localStorageMock.setItem(ACCOUNT_SESSION_STORAGE_KEY, token);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (init.method === 'DELETE') return new Response(null, { status: 204 });
        if (init.method === 'POST') {
          return jsonResponse({
            ...savedStudio,
            updatedAt: '2026-07-02T10:05:00.000Z',
          }, 201);
        }
        return jsonResponse({
          roomId: 'account:account-1',
          exportedAt: '2026-07-02T10:05:00.000Z',
          studios: [{
            ...savedStudio,
            updatedAt: '2026-07-02T10:05:00.000Z',
          }],
        });
      },
      configurable: true,
    });

    const listed = await fetchAccountWorkspaceStudioCatalog();
    const synced = await syncAccountWorkspaceStudioCatalogEntry(savedStudio);
    await deleteAccountWorkspaceStudioCatalogEntry(savedStudio.id);

    assert.equal(listed.studios[0].id, savedStudio.id);
    assert.equal(synced.id, savedStudio.id);
    assert.deepEqual(calls.map((call) => call.url), [
      '/api/workspace-studios/account/catalog',
      '/api/workspace-studios/account/catalog',
      '/api/workspace-studios/account/catalog/studio-1',
    ]);
    for (const call of calls) {
      assert.equal(call.init.credentials, 'include');
      assert.equal((call.init.headers as Headers).get('Authorization'), `Bearer ${token}`);
    }
  });
});
