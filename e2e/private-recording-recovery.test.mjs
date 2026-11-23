import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
        await write(folder, 'chunk-000000.part', 'abcdef');
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

    await reopened.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('studio-recording-recovery');
      const folder = await root.getDirectoryHandle('take-interrupted');
      const manifest = await folder.getFileHandle('recording.json');
      const metadata = JSON.parse(await (await manifest.getFile()).text());
      const writer = await manifest.createWritable();
      await writer.write(JSON.stringify({ ...metadata, complete: true }));
      await writer.close();
    });
    await reopened.getByRole('button', { name: 'Check this device again' }).click();
    await reopened.getByText('1 track is ready to send to your host.').waitFor();
    await reopened.getByRole('button', { name: 'Finish upload', exact: true }).waitFor();
    await reopened.getByRole('button', { name: 'Check this device again' }).waitFor();
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } finally {
    await fixture.close();
  }
});

test('the original host can see pending guest tracks and download a verified track from Recordings', { timeout: 50_000 }, async () => {
  const fixture = await startHarness();
  const hostToken = 'local-only-host-recovery-credential';
  try {
    const context = await fixture.browser('offline-recording-host', {
      initScript: () => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }); },
    });
    const roomName = 'Offline recovery rehearsal';
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const participants = [
      { participantId: 'guest-a', participantName: 'Camera Operator' },
      { participantId: 'guest-b', participantName: 'Studio Guest' },
    ];
    const tracks = [
      { ...participants[0], trackId: 'take-original-camera', label: 'Camera', kind: 'iso', mimeType: 'video/webm',
        receivedBytes: 6, totalBytes: 6, nextSequence: 2, status: 'verified' },
    ];
    const routeBase = `/recording-recovery/rooms/${grant.roomId}/takes/${grant.takeId}`;
    await context.route('**/recording-recovery/**', async route => {
      const request = route.request();
      const headers = { 'Access-Control-Allow-Origin': fixture.url, 'Access-Control-Allow-Headers': 'x-host-token' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.equal(request.headers()['x-host-token'], hostToken);
      const { pathname } = new URL(request.url());
      if (pathname === routeBase) {
        return route.fulfill({ json: { roomId: grant.roomId, takeId: grant.takeId, expiresAt, participants, tracks }, headers });
      }
      assert.equal(pathname, routeBase + '/participants/guest-a/tracks/take-original-camera');
      return route.fulfill({ contentType: 'video/webm', body: 'abcdef', headers });
    });
    const page = await context.newPage();
    await page.route(`${fixture.url}/recovery-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recovery fixture</title>' }));
    await page.goto(`${fixture.url}/recovery-fixture`);
    await page.evaluate(({ roomId, takeId, roomName, expiresAt, hostToken }) => {
      localStorage.setItem(`studio-private-recovery:take:${roomId}:${takeId}`, JSON.stringify({ roomId, takeId, roomName, expiresAt }));
      localStorage.setItem('livestream-studio:host-studios', JSON.stringify([{ id: roomId, hostName: 'Host', hostToken }]));
    }, { ...grant, roomName, expiresAt, hostToken });
    await page.close();

    const recordings = await context.newPage();
    await recordings.goto(`${fixture.url}/?view=recordings`);
    const recovery = recordings.getByRole('region', { name: 'Recording recovery' });
    await recovery.getByText(roomName, { exact: false }).click();
    await recovery.getByText('Awaiting upload', { exact: true }).waitFor();
    assert.equal(await recordings.getByText('Record a session in your studio to see it here.', { exact: true }).count(), 0);
    const download = recordings.waitForEvent('download');
    await recovery.getByRole('button', { name: 'Download Camera' }).click();
    const exported = await download;
    assert.equal(exported.suggestedFilename(), 'Camera.webm');
    assert.equal(await readFile(await exported.path(), 'utf8'), 'abcdef');
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } finally {
    await fixture.close();
  }
});
