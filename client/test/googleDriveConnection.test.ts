import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDriveAuthorizer, createDriveRecordingFolder, DRIVE_FILE_SCOPE, normalizeDriveFolder, validateDriveFolder } from '../src/utils/googleDriveConnection.ts';

describe('Google Drive authorization', () => {
  it('starts from the button gesture, shares in-flight requests, validates scope, and reuses a fresh token', async () => {
    let calls = 0;
    let callback: (data: any) => void = () => {};
    const auth = createDriveAuthorizer(() => ({ initTokenClient(config) {
      assert.equal(config.scope, DRIVE_FILE_SCOPE);
      assert.equal(config.include_granted_scopes, false);
      callback = config.callback;
      return { requestAccessToken() { calls++; } };
    } }), 'client');
    const first = auth.authorize();
    assert.equal(calls, 1);
    const second = auth.authorize();
    assert.equal(first, second);
    callback({ access_token: 'test-only-token', expires_in: 3600, scope: DRIVE_FILE_SCOPE });
    assert.equal(await first, 'test-only-token');
    assert.equal(await auth.authorize(), 'test-only-token');
    assert.equal(calls, 1);
  });
  it('recovers after a closed popup and rejects missing Drive consent', async () => {
    let callbacks: any;
    const auth = createDriveAuthorizer(() => ({ initTokenClient(config) {
      callbacks = config; return { requestAccessToken() {} };
    } }), 'client');
    const first = auth.authorize();
    callbacks.error_callback({ type: 'popup_closed' });
    await assert.rejects(first, /closed/);
    const next = auth.authorize();
    callbacks.callback({ access_token: 'test-only', expires_in: 3600, scope: 'unrelated' });
    await assert.rejects(next, /Allow access/);
    const final = auth.authorize();
    callbacks.callback({ access_token: 'allowed', expires_in: 3600, scope: DRIVE_FILE_SCOPE });
    assert.equal(await final, 'allowed');
  });
  it('settles requests that never callback and ignores late responses', async () => {
    let callbacks: any;
    const auth = createDriveAuthorizer(() => ({ initTokenClient(config) {
      callbacks = config; return { requestAccessToken() {} };
    } }), 'client', 5);
    await assert.rejects(auth.authorize(), /timed out/);
    callbacks.callback({ access_token: 'too-late', expires_in: 3600, scope: DRIVE_FILE_SCOPE });
    const retry = auth.authorize();
    callbacks.callback({ access_token: 'new', expires_in: 3600, scope: DRIVE_FILE_SCOPE });
    assert.equal(await retry, 'new');
  });
  it('clearing the connection invalidates an outstanding sign-in', async () => {
    let callbacks: any;
    const auth = createDriveAuthorizer(() => ({ initTokenClient(config) {
      callbacks = config; return { requestAccessToken() {} };
    } }), 'client');
    const request = auth.authorize();
    auth.clear();
    callbacks.callback({ access_token: 'old', expires_in: 3600, scope: DRIVE_FILE_SCOPE });
    await assert.rejects(request, /cleared/);
  });
});

describe('Google Drive recording destinations', () => {
  const folder = { id: 'folder_123', name: 'AF Studio' };
  const metadata = { ...folder, mimeType: 'application/vnd.google-apps.folder', trashed: false, capabilities: { canAddChildren: true } };
  it('stores only a valid folder identity', () => {
    assert.deepEqual(normalizeDriveFolder({ ...folder, access_token: 'never-store' }), folder);
    assert.equal(normalizeDriveFolder({ id: '../bad', name: 'bad' }), null);
    assert.equal(normalizeDriveFolder({ id: 'folder_123', name: '' }), null);
  });
  it('checks folder type, edit capability, deletion, and account access', async () => {
    const fake = (data: unknown, status=200) => (async () => new Response(JSON.stringify(data), { status })) as typeof fetch;
    assert.deepEqual(await validateDriveFolder('token', folder.id, fake(metadata)), folder);
    for (const data of [{ ...metadata, mimeType: 'video/mp4' }, { ...metadata, trashed: true }, { ...metadata, capabilities: { canAddChildren: false } }, { ...metadata, id: 'wrong_id' }]) {
      await assert.rejects(validateDriveFolder('token', folder.id, fake(data)), /Choose a folder/);
    }
    await assert.rejects(validateDriveFolder('token', folder.id, fake({}, 404)), /Reconnect/);
  });
  it('creates the recording inside the selected parent without changing permissions', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = (async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"id":"recording_folder"}', { status: 200 }); }) as typeof fetch;
    assert.equal(await createDriveRecordingFolder('token', folder, 'Interview', fake), 'recording_folder');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { name: 'Interview', mimeType: 'application/vnd.google-apps.folder', parents: [folder.id] });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes('/permissions'));
    await assert.rejects(createDriveRecordingFolder('token', {id:'', name:''}, 'Interview', fake), /Choose/);
    assert.equal(calls.length, 1);
  });
});
