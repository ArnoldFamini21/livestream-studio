import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { screenshot, startHarness } from './harness.mjs';

const run = promisify(execFile);

function serveMp4(route, mp4, headers) {
  const range = route.request().headers().range;
  const mediaHeaders = { ...headers, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' };
  if (!range) return route.fulfill({ headers: { ...mediaHeaders, 'Content-Length': String(mp4.length) }, body: mp4 });
  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  const start = match ? Number(match[1]) : mp4.length;
  const end = match?.[2] ? Math.min(Number(match[2]), mp4.length - 1) : mp4.length - 1;
  if (start > end) return route.fulfill({ status: 416, headers: { ...headers, 'Content-Range': `bytes */${mp4.length}` } });
  return route.fulfill({
    status: 206,
    headers: { ...mediaHeaders, 'Content-Range': `bytes ${start}-${end}/${mp4.length}`, 'Content-Length': String(end - start + 1) },
    body: mp4.subarray(start, end + 1),
  });
}

test('a private premiere plays from the live offset and ends at its scheduled cutoff', { timeout: 60_000 }, async () => {
  const fixture = await startHarness({
    artifactDir: path.join(process.env.E2E_ARTIFACT_DIR || path.resolve('output/e2e'), 'premiere-watch'),
  });
  let viewer;
  try {
    const source = path.join(fixture.artifactDir, 'premiere-fixture.mp4');
    await run(process.env.FFMPEG_BIN || ffmpegStatic || 'ffmpeg', [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=20',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', source,
    ], { timeout: 20_000 });
    const mp4 = await readFile(source);
    const watchId = 'premiereViewer01';
    const invite = `fixtureInvite.${'A'.repeat(43)}`;
    const watchToken = `fixturePlayback.${'B'.repeat(43)}`;
    const startsAt = Date.now() + 60_000;
    const durationMs = 12_000;
    const cutoff = startsAt + durationMs;
    let serverTime = startsAt - 300;
    const watchUrl = `${fixture.url}/watch/${watchId}`;
    const signaling = `${fixture.apiUrl}/api/watch/${watchId}`;
    const media = `${fixture.apiUrl}/premieres/${watchId}`;
    const headers = {
      'Access-Control-Allow-Origin': fixture.url,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Cache-Control': 'no-store',
    };
    const requests = [];
    const registrations = [];
    viewer = await (await fixture.browser('premiere-viewer', { viewport: { width: 390, height: 844 } })).newPage();
    await viewer.route(watchUrl, async (route) => {
      const response = await route.fetch();
      const policy = response.headers()['content-security-policy'];
      assert.match(policy, /media-src 'self'/);
      await route.fulfill({
        response,
        // The production media URL uses HTTPS. Add only this HTTP fixture origin.
        headers: { ...response.headers(), 'content-security-policy': policy.replace("media-src 'self'", `media-src 'self' ${fixture.apiUrl}`) },
      });
    });
    // The shared harness disables durable room storage. Mock the one room
    // that would have a persisted premiere and its private invite exchange.
    await viewer.route(signaling, (route) => route.fulfill({
      headers,
      json: { id: watchId, name: 'Offline premiere', status: 'scheduled', scheduledFor: new Date(startsAt).toISOString(),
        premiere: true, registration: { enabled: true, inviteOnly: true } },
    }));
    await viewer.route(`${signaling}/registrants`, (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const body = route.request().postDataJSON();
      registrations.push(body);
      if (body.invite !== invite) return route.fulfill({ status: 403, headers, json: { error: 'The private fixture invite is required.' } });
      return route.fulfill({
        status: 201, headers,
        json: { access: { token: watchToken, expiresAt: new Date(cutoff + 60_000).toISOString() } },
      });
    });
    await viewer.route(`${fixture.apiUrl}/watch/${watchId}/status*`, (route) => route.fulfill({
      headers, json: { live: false, viewers: 0 },
    }));
    await viewer.route(`${media}/**`, (route) => {
      const url = new URL(route.request().url());
      const action = url.pathname.split('/').at(-1);
      const token = url.searchParams.get('watchToken');
      requests.push({ action, token, time: serverTime, range: route.request().headers().range });
      if (token !== watchToken) return route.fulfill({ status: 401, headers });
      const phase = serverTime < startsAt ? 'scheduled' : serverTime < cutoff ? 'playing' : 'ended';
      if (action === 'status') return route.fulfill({ headers, json: { phase, startsAt, durationMs, serverTime } });
      if (action !== 'video' || phase !== 'playing') return route.fulfill({ status: 404, headers });
      return serveMp4(route, mp4, headers);
    });

    await viewer.goto(watchUrl);
    await viewer.getByText('Ask the host for a private viewing link for this event.').waitFor();
    assert.deepEqual(requests, [], 'gated viewers never request the premiere');
    await viewer.goto(`${watchUrl}#watchInvite=${invite}`);
    await viewer.getByLabel('Your name', { exact: true }).fill('Riley');
    await viewer.getByLabel('Email', { exact: true }).fill('riley@watch.example');
    await viewer.getByRole('button', { name: 'Register and watch', exact: true }).click();
    await viewer.getByRole('heading', { name: 'Premiere starts soon', exact: true }).waitFor();
    assert.equal(new URL(viewer.url()).hash, '');
    assert.deepEqual(registrations, [{ invite, name: 'Riley', email: 'riley@watch.example' }]);
    assert.ok(requests.every(({ action }) => action === 'status'), 'the player stays unloaded before the start');

    const video = viewer.locator('video');
    await video.evaluate((node) => {
      node.addEventListener('playing', () => { node.dataset.firstPlayTime = String(node.currentTime); }, { once: true });
    });
    serverTime = startsAt + 4_000;
    await viewer.waitForFunction(() => {
      const node = document.querySelector('video');
      return node?.dataset.firstPlayTime && node.readyState >= 2 && node.videoWidth > 0;
    });
    const playing = await video.evaluate((node) => ({ time: Number(node.dataset.firstPlayTime), width: node.videoWidth, height: node.videoHeight }));
    assert.ok(playing.time >= 3.6 && playing.time < 6, `late viewer started at ${playing.time}s`);
    assert.deepEqual([playing.width, playing.height], [160, 90]);
    assert.ok(requests.some(({ action, range }) => action === 'video' && range), 'Chromium requested actual byte ranges');

    serverTime = cutoff;
    await viewer.getByRole('heading', { name: 'This broadcast has ended', exact: true }).waitFor();
    await viewer.waitForFunction(() => {
      const node = document.querySelector('video');
      return node?.paused && !node.getAttribute('src');
    });
    assert.ok(requests.every(({ token }) => token === watchToken));
    assert.ok(requests.some(({ action, time }) => action === 'status' && time === cutoff));
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } catch (error) {
    if (viewer && !viewer.isClosed()) await screenshot(viewer, fixture.artifactDir, 'premiere-watch-failure').catch(() => {});
    throw error;
  } finally {
    await fixture.close();
  }
});
