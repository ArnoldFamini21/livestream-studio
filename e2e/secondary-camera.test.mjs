import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { admitGuest, createStudio, eventually, screenshot, stageGuest, startHarness, openStudioTool } from './harness.mjs';

function observeCamera() {
  try { sessionStorage.setItem('preferredVideoQuality', '720p'); } catch { /* Blank page before navigation. */ }
  window.__cameraRequests = [];
  window.__cameraCaptures = [];
  if (!navigator.mediaDevices) return;
  const startMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = constraints => {
    window.__cameraRequests.push({ audio: Boolean(constraints.audio), video: Boolean(constraints.video) });
    return startMedia(constraints);
  };

  const NativeRecorder = window.MediaRecorder;
  window.MediaRecorder = class extends NativeRecorder {
    constructor(stream, options) {
      super(stream, options);
      const record = { kinds: stream.getTracks().map(track => track.kind), bytes: 0 };
      this.addEventListener('start', () => { window.__cameraCaptures.push(record); });
      this.addEventListener('dataavailable', event => { record.bytes += event.data.size; });
      this.addEventListener('stop', () => { record.stopped = true; });
    }
  };
}

async function savedCameraIso(host, cameraName) {
  return host.evaluate(async name => {
    const root = await navigator.storage.getDirectory();
    const destination = await root.getDirectoryHandle('camera-iso-check');
    for await (const studio of destination.values()) {
      if (studio.kind !== 'directory') continue;
      for await (const take of studio.values()) {
        if (take.kind !== 'directory') continue;
        try {
          const manifestFile = await (await take.getFileHandle('take-manifest.json')).getFile();
          const manifest = JSON.parse(await manifestFile.text());
          const expected = (manifest.expectedTracks || []).filter(track => track.participantName === name);
          const received = manifest.tracks.filter(track => track.participantName === name && track.origin === 'guest-transfer');
          const iso = received.find(track => track.kind === 'iso' && track.status === 'complete' && track.bytes > 0);
          if (!iso) continue;
          const segments = iso.path.slice(manifest.folder.length + 1).split('/');
          if (segments.length !== 2) throw new Error('Unexpected track path in the take manifest');
          const person = await take.getDirectoryHandle(segments[0]);
          const file = await (await person.getFileHandle(segments[1])).getFile();
          return { expected, received, size: file.size };
        } catch (error) {
          if (error.name !== 'NotFoundError') throw error;
        }
      }
    }
    return null;
  }, cameraName);
}

test('a secondary camera joins on a phone viewport and delivers a video-only ISO to the host', { timeout: 180_000 }, async () => {
  const fixture = await startHarness({
    ...(process.env.E2E_SECONDARY_CAMERA_DIST ? { distDir: process.env.E2E_SECONDARY_CAMERA_DIST } : {}),
  });
  const cameraName = 'Wide shot';
  let host;
  let camera;
  try {
    const hostContext = await fixture.browser('secondary-camera-host', {
      initScript: () => {
        try { sessionStorage.setItem('preferredVideoQuality', '720p'); } catch { /* Blank page before navigation. */ }
        window.showDirectoryPicker = async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle('camera-iso-check', { create: true });
        };
      },
    });
    await hostContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.url });
    const studio = await createStudio(hostContext, { url: fixture.url, name: 'Secondary camera qualification' });
    host = studio.page;
    await openStudioTool(host, 'Invite guests');
    await host.getByLabel('Mobile Join', { exact: true }).selectOption('camera');
    await host.getByRole('img', { name: 'Secondary camera invite QR code', exact: true }).waitFor();
    await host.getByRole('button', { name: 'Copy camera link', exact: true }).click();
    await host.getByRole('button', { name: 'Copied link', exact: true }).waitFor();
    const cameraLink = new URL(await host.evaluate(() => navigator.clipboard.readText()));
    assert.equal(cameraLink.pathname, '/join/' + studio.studioId);
    assert.equal(cameraLink.searchParams.get('camera'), '1');
    await host.getByRole('button', { name: 'Close invite panel', exact: true }).click();

    const cameraContext = await fixture.browser('secondary-camera-phone', {
      viewport: { width: 390, height: 844 },
      initScript: observeCamera,
    });
    camera = await cameraContext.newPage();
    await camera.goto(new URL(cameraLink.pathname + cameraLink.search, fixture.url).href);
    await camera.getByLabel('Camera name', { exact: true }).fill(cameraName);
    assert.equal(await camera.getByRole('button', { name: /mute microphone/i }).count(), 0);
    await camera.getByRole('button', { name: 'Join as secondary camera', exact: true }).click();
    const preview = camera.locator('video[aria-label="Secondary camera preview"]');
    await camera.getByRole('status').filter({ hasText: 'Waiting for the host to admit this camera' }).waitFor();
    await preview.waitFor();
    const requests = await camera.evaluate(() => window.__cameraRequests);
    assert.ok(requests.length >= 2, 'the prejoin and studio pages both acquire media');
    for (const request of requests) assert.deepEqual(request, { audio: false, video: true });
    await screenshot(camera, fixture.artifactDir, 'secondary-camera-waiting-390');

    await admitGuest(host, cameraName);
    await camera.getByRole('status').filter({ hasText: 'Backstage' }).waitFor();
    await stageGuest(host, cameraName);
    await camera.getByRole('status').filter({ hasText: 'On stage' }).waitFor();
    const stage = host.getByRole('region', { name: 'Broadcast canvas', exact: true });
    const remoteVideo = stage.locator('[data-stage-participant="' + cameraName + '"] video');
    await eventually(() => remoteVideo.evaluate(video => video.readyState >= 2
      && video.currentTime > 0 && video.srcObject?.getVideoTracks().length === 1), {
      message: 'The host did not receive a playing camera track',
    });
    assert.deepEqual(await remoteVideo.evaluate(video => video.srcObject.getTracks().map(track => track.kind)), ['video']);
    assert.deepEqual(await preview.evaluate(video => video.srcObject.getTracks().map(track => track.kind)), ['video']);
    await screenshot(camera, fixture.artifactDir, 'secondary-camera-on-stage-390');

    await host.getByRole('button', { name: 'More tools', exact: true }).click();
    await host.getByRole('button', { name: 'Recordings', exact: true }).click();
    await host.getByRole('button', { name: 'Choose recording folder', exact: true }).click();
    await host.getByRole('region', { name: 'Recording destination', exact: true })
      .getByRole('status').filter({ hasText: 'camera-iso-check' }).waitFor();
    await host.getByRole('button', { name: 'Close recordings', exact: true }).click();
    await host.getByRole('button', { name: 'Start recording', exact: true }).click();
    await camera.getByText('Recording camera ISO', { exact: false }).waitFor();
    await camera.waitForFunction(() => window.__cameraCaptures.some(capture => capture.bytes > 0), undefined, { polling: 250 });
    await host.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await camera.waitForFunction(() => window.__cameraCaptures.some(capture => capture.stopped), undefined, { polling: 250 });
    const captures = await camera.evaluate(() => window.__cameraCaptures);
    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0].kinds, ['video']);

    const stored = await eventually(() => savedCameraIso(host, cameraName), {
      timeout: 75_000,
      message: 'The secondary camera ISO did not arrive in the host folder',
    });
    assert.deepEqual(stored.expected.map(track => track.kind), ['iso']);
    assert.deepEqual(stored.received.map(track => track.kind), ['iso']);
    assert.equal(stored.received[0].bytes, stored.size);
    assert.equal(stored.size, captures[0].bytes);
    await writeFile(path.join(fixture.artifactDir, 'secondary-camera-iso.json'), JSON.stringify({ captures, stored }, null, 2));
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } catch (error) {
    await Promise.allSettled([
      host && screenshot(host, fixture.artifactDir, 'secondary-camera-host-failure'),
      camera && screenshot(camera, fixture.artifactDir, 'secondary-camera-phone-failure'),
    ]);
    throw error;
  } finally {
    await fixture.close();
  }
});
