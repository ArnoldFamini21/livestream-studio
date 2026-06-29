import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDriveFolderUrl,
  createDriveFolderShareLinkRequest,
} from '../src/hooks/useGoogleDriveUpload.ts';

describe('Google Drive upload sharing helpers', () => {
  it('creates an anyone-with-link folder permission and returns the Drive web view link', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/permissions')) {
        return new Response(JSON.stringify({ id: 'permission-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ webViewLink: 'https://drive.google.com/drive/folders/folder_123' }), { status: 200 });
    };

    const result = await createDriveFolderShareLinkRequest('token-1', 'folder_123', fetchImpl as typeof fetch);

    assert.deepEqual(result, {
      folderId: 'folder_123',
      webViewLink: 'https://drive.google.com/drive/folders/folder_123',
      permissionId: 'permission-1',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init?.method, 'POST');
    assert.match(String(calls[0].init?.body), /"type":"anyone"/);
    assert.match(String(calls[0].init?.body), /"role":"reader"/);
  });

  it('falls back to a deterministic folder URL when Drive does not return webViewLink', async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).includes('/permissions')) {
        return new Response('{}', { status: 409 });
      }
      return new Response('missing', { status: 500 });
    };

    const result = await createDriveFolderShareLinkRequest('token-1', 'folder_abc', fetchImpl as typeof fetch);

    assert.deepEqual(result, {
      folderId: 'folder_abc',
      webViewLink: 'https://drive.google.com/drive/folders/folder_abc',
    });
  });

  it('rejects missing tokens and malformed folder ids before making API calls', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      return new Response('{}', { status: 200 });
    };

    assert.equal(await createDriveFolderShareLinkRequest('', 'folder_abc', fetchImpl as typeof fetch), null);
    assert.equal(await createDriveFolderShareLinkRequest('token-1', '../bad', fetchImpl as typeof fetch), null);
    assert.equal(callCount, 0);
  });

  it('builds escaped fallback folder links', () => {
    assert.equal(
      buildDriveFolderUrl('folder id'),
      'https://drive.google.com/drive/folders/folder%20id'
    );
  });
});
