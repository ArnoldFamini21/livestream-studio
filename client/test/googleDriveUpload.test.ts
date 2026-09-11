import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDriveFolderUrl,
  createDriveUploadResumeKey,
  getDriveFolderLinkRequest,
  getDriveUploadResumeOffset,
  isFreshDriveUploadResumeState,
  parseDriveUploadRangeEnd,
  queryDriveResumableUploadStatus,
} from '../src/hooks/useGoogleDriveUpload.ts';

describe('Google Drive upload sharing helpers', () => {
  it('returns the Drive folder link without making recordings public', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/permissions')) {
        return new Response(JSON.stringify({ id: 'permission-1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ webViewLink: 'https://drive.google.com/drive/folders/folder_123' }), { status: 200 });
    };

    const result = await getDriveFolderLinkRequest('token-1', 'folder_123', fetchImpl as typeof fetch);

    assert.deepEqual(result, {
      folderId: 'folder_123',
      webViewLink: 'https://drive.google.com/drive/folders/folder_123',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.method, undefined);
    assert.ok(!calls[0].url.includes('/permissions'));
    assert.equal(calls[0].init?.body, undefined);
  });

  it('falls back to a deterministic folder URL when Drive does not return webViewLink', async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      if (String(url).includes('/permissions')) {
        return new Response('{}', { status: 409 });
      }
      return new Response('missing', { status: 500 });
    };

    const result = await getDriveFolderLinkRequest('token-1', 'folder_abc', fetchImpl as typeof fetch);

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

    assert.equal(await getDriveFolderLinkRequest('', 'folder_abc', fetchImpl as typeof fetch), null);
    assert.equal(await getDriveFolderLinkRequest('token-1', '../bad', fetchImpl as typeof fetch), null);
    assert.equal(callCount, 0);
  });

  it('builds escaped fallback folder links', () => {
    assert.equal(
      buildDriveFolderUrl('folder id'),
      'https://drive.google.com/drive/folders/folder%20id'
    );
  });
});

describe('Google Drive resumable upload helpers', () => {
  it('builds stable resume keys without exposing file names', () => {
    const first = createDriveUploadResumeKey('Launch Demo 4K.webm', 15_000_000, 'folder_123');
    const second = createDriveUploadResumeKey('Launch Demo 4K.webm', 15_000_000, 'folder_123');
    const differentFolder = createDriveUploadResumeKey('Launch Demo 4K.webm', 15_000_000, 'folder_456');

    assert.equal(first, second);
    assert.notEqual(first, differentFolder);
    assert.match(first, /^livestream-studio:drive-upload-session:[a-z0-9]+$/);
    assert.doesNotMatch(first, /Launch|Demo|webm/);
  });

  it('parses committed byte ranges into resume offsets', () => {
    assert.equal(parseDriveUploadRangeEnd('bytes=0-5242879'), 5_242_879);
    assert.equal(getDriveUploadResumeOffset('bytes=0-5242879'), 5_242_880);
    assert.equal(getDriveUploadResumeOffset(null), 0);
    assert.equal(parseDriveUploadRangeEnd('bytes=200-100'), null);
    assert.equal(parseDriveUploadRangeEnd('items=0-100'), null);
  });

  it('bounds stored upload session freshness', () => {
    const state = {
      uploadUri: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=abc',
      fileName: 'recording.webm',
      fileSize: 10_000,
      updatedAt: 1_000,
    };

    assert.equal(isFreshDriveUploadResumeState(state, 2_000, 5_000), true);
    assert.equal(isFreshDriveUploadResumeState(state, 8_000, 5_000), false);
    for (const uploadUri of ['http://example.com', 'https://attacker.example/upload/drive/v3/files', 'https://www.googleapis.com.attacker.example/upload/drive/v3/files', 'https://www.googleapis.com/other']) {
      assert.equal(isFreshDriveUploadResumeState({ ...state, uploadUri }, 2_000, 5_000), false);
    }
  });

  it('queries Google resumable upload sessions for the next byte offset', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('', {
        status: 308,
        headers: { Range: 'bytes=0-5242879' },
      });
    };

    const result = await queryDriveResumableUploadStatus(
      'https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1',
      'access-token',
      20_000_000,
      fetchImpl as typeof fetch
    );

    assert.deepEqual(result, { status: 'resume', offset: 5_242_880 });
    assert.equal(calls[0].init?.method, 'PUT');
    assert.equal((calls[0].init?.headers as Record<string, string>)['Content-Range'], 'bytes */20000000');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer access-token');
  });

  it('detects resumable uploads that Google already completed', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ id: 'drive-file-123' }), { status: 200 });

    const result = await queryDriveResumableUploadStatus(
      'https://www.googleapis.com/upload/drive/v3/files?upload_id=session-2',
      'access-token',
      20_000_000,
      fetchImpl as typeof fetch
    );

    assert.deepEqual(result, { status: 'complete', fileId: 'drive-file-123' });
  });
});

it('does not send credentials to an untrusted saved upload URL', async () => {
  let calls = 0;
  const fake = (async () => { calls++; return new Response('{}'); }) as typeof fetch;
  assert.deepEqual(await queryDriveResumableUploadStatus('https://untrusted.example', 'token', 100, fake), { status: 'invalid' });
  assert.equal(calls, 0);
});
