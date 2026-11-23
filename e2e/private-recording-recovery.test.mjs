import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { startHarness } from './harness.mjs';

const grant = { roomId: 'test-room', takeId: 'recording-private-test', participantId: 'guest-a', token: 'local-only-guest-recovery-grant' };

test('a guest can reopen and verify saved tracks after the studio is gone', { timeout: 50_000 }, async () => {
  const fixture = await startHarness();
  try {
    const context = await fixture.browser('offline-recording-guest', { viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.route(`${fixture.url}/recovery-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recovery fixture</title>' }));
    await page.goto(`${fixture.url}/recovery-fixture`);
    await page.evaluate(async auth => {
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      localStorage.setItem(`studio-private-recovery:grant:${auth.roomId}:${auth.takeId}:${auth.participantId}`, JSON.stringify({ ...auth, expiresAt }));
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('studio-recording-recovery', { create: true });
      const write = async (directory, filename, data) => {
        const file = await directory.getFileHandle(filename, { create: true });
        const writer = await file.createWritable();
        await writer.write(data);
        await writer.close();
      };
      for (const [id, participantId, complete] of [['take-original-camera', 'guest-a', true], ['take-other-guest', 'guest-b', true], ['take-interrupted', 'guest-a', false]]) {
        const folder = await root.getDirectoryHandle(id, { create: true });
        const { roomId, takeId } = auth;
        await write(folder, 'recording.json', JSON.stringify({ id, roomName: 'Offline recovery rehearsal', label: 'Camera', kind: 'iso',
          mimeType: 'video/webm', createdAt: new Date().toISOString(), complete, deliveredToHost: true,
          transfer: { roomId, sessionId: takeId, participantId, participantName: 'Guest' } }));
        await write(folder, 'chunk-000001.part', 'abcdef');
      }
    }, grant);
    await page.close();

    const sent = [];
    const state = { trackId: 'take-original-camera', participantId: 'guest-a', participantName: 'Guest', label: 'Camera', kind: 'iso',
      mimeType: 'video/webm', receivedBytes: 3, nextSequence: 1, status: 'uploading' };
    await context.route('**/recording-recovery/**', async route => {
      const request = route.request();
      const headers = { 'Access-Control-Allow-Origin': fixture.url, 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(request.headers().authorization, `Bearer ${grant.token}`);
      const url = new URL(request.url());
      assert.ok(url.pathname.startsWith(`/recording-recovery/rooms/${grant.roomId}/takes/${grant.takeId}/upload`));
      if (url.pathname.endsWith('/upload')) return route.fulfill({ json: { tracks: [state] }, headers });
      if (url.pathname.endsWith('/chunks')) {
        assert.equal(url.searchParams.get('offset'), '3');
        assert.equal(url.searchParams.get('sha256'), createHash('sha256').update('def').digest('hex'));
        sent.push(request.postDataBuffer().toString());
        return route.fulfill({ json: { ...state, nextSequence: 2, receivedBytes: 6 }, headers });
      }
      assert.ok(url.pathname.endsWith('/take-original-camera/complete'));
      assert.deepEqual(request.postDataJSON(), { totalBytes: 6, chunkCount: 2 });
      return route.fulfill({ json: { ...state, nextSequence: 2, receivedBytes: 6, totalBytes: 6, status: 'verified' }, headers });
    });
    const reopened = await context.newPage();
    await reopened.goto(`${fixture.url}/finish-upload`);
    await reopened.getByRole('heading', { name: 'Offline recovery rehearsal' }).waitFor();
    await reopened.getByText('Interrupted tracks are still available for local recovery.').waitFor();
    await reopened.getByRole('button', { name: 'Finish upload', exact: true }).click();
    await reopened.getByText('1 track verified.').waitFor();
    assert.deepEqual(sent, ['def']);
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } finally {
    await fixture.close();
  }
});
