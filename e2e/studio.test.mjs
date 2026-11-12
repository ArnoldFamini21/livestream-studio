import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { startHarness, createStudio, joinStudio, admitGuest, stageGuest, screenshot, eventually } from './harness.mjs';

// Observers retain only metadata. Recording and peer media still use real browser APIs.
function observeMedia() {
  // CI runners encode every browser's video in software on a few cores. The
  // 720p preset keeps three browsers' recorders near real time; quality presets
  // are covered by unit tests, this suite qualifies the recording workflow.
  try { sessionStorage.setItem('preferredVideoQuality', '720p'); } catch { /* storage unavailable */ }
  window.__e2eMedia = { recorders: [], remoteTracks: [] };
  window.__e2ePeers = [];
  const NativeRecorder = window.MediaRecorder;
  window.MediaRecorder = class extends NativeRecorder {
    constructor(...args) {
      super(...args);
      const record = { kinds: args[0].getTracks().map(track => track.kind), mimeType: this.mimeType, bytes: 0, chunks: 0, startedAt: null, stopRequestedAt: null, stoppedAt: null, stopped: false };
      window.__e2eMedia.recorders.push(record);
      this.addEventListener('start', () => { record.startedAt = performance.now(); });
      this.addEventListener('dataavailable', event => { record.bytes += event.data.size; record.chunks += Number(event.data.size > 0); });
      this.addEventListener('stop', () => { record.stopped = true; record.stoppedAt = performance.now(); });
      const nativeStop = this.stop.bind(this);
      this.stop = () => { if (record.stopRequestedAt === null) record.stopRequestedAt = performance.now(); return nativeStop(); };
    }
  };
  const NativePeer = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args);
      window.__e2ePeers.push(this);
      this.addEventListener('track', event => window.__e2eMedia.remoteTracks.push(event.track));
    }
  };
}

async function assertPlayingRemoteHost(page, artifactDir, checkpoint) {
  const label = 'Video feed: Test Host';
  const video = page.getByRole('group', { name: label, exact: true }).locator('video');
  await video.waitFor();
  await page.evaluate(() => { window.__e2eVideoProbe = new WeakMap(); });
  try {
    await page.waitForFunction(label => {
      const group = [...document.querySelectorAll('[role="group"]')].find(element => element.getAttribute('aria-label') === label);
      const element = group?.querySelector('video');
      if (!element) return false;
      // Responsive layouts remount the video. Its clock restarts at zero, so
      // measure advancement on this element rather than its removed predecessor.
      if (!window.__e2eVideoProbe.has(element)) window.__e2eVideoProbe.set(element, element.currentTime);
      if (element.paused || element.readyState < 2 || element.currentTime < window.__e2eVideoProbe.get(element) + 0.05) return false;
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 18;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(element, 0, 0, 32, 18);
      const data = context.getImageData(0, 0, 32, 18).data;
      let colored = 0;
      for (let index = 0; index < data.length; index += 4) if (Math.max(data[index], data[index + 1], data[index + 2]) > 40) colored++;
      return colored > 32; // Fake camera is green; a stopped/black RTP track must fail.
    }, label);
  } catch (error) {
    const diagnostics = await page.evaluate(async () => ({
      videos: [...document.querySelectorAll('video')].map(element => ({
        label: element.closest('[role="group"]')?.getAttribute('aria-label'),
        readyState: element.readyState, currentTime: element.currentTime, paused: element.paused,
        width: element.videoWidth, height: element.videoHeight,
        tracks: element.srcObject?.getTracks?.().map(track => ({ kind: track.kind, id: track.id, readyState: track.readyState, enabled: track.enabled, muted: track.muted })),
      })),
      peers: await Promise.all(window.__e2ePeers.map(async peer => ({
        state: peer.connectionState,
        inbound: [...(await peer.getStats()).values()].filter(report => report.type === 'inbound-rtp').map(report => ({ kind: report.kind, packetsReceived: report.packetsReceived, framesDecoded: report.framesDecoded, framesReceived: report.framesReceived, trackIdentifier: report.trackIdentifier })),
      }))),
    }));
    await writeFile(path.join(artifactDir, `remote-video-${checkpoint}.json`), JSON.stringify(diagnostics, null, 2));
    await screenshot(page, artifactDir, `remote-video-${checkpoint}`);
    throw error;
  }
}

async function recoveryFiles(page) {
  return page.evaluate(async () => {
    const found = [];
    async function walk(directory, prefix) {
      for await (const [name, entry] of directory.entries()) {
        const filename = `${prefix}/${name}`;
        if (entry.kind === 'directory') await walk(entry, filename);
        else if (name.endsWith('.part')) {
          // The recorder atomically replaces manifests while writing. They are
          // not media; inspect only committed parts and retry a removed entry.
          try { const file = await entry.getFile(); found.push({ filename, size: file.size }); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
        }
      }
    }
    await walk(await navigator.storage.getDirectory(), '');
    return found;
  });
}

test('built studio in real Chromium under the production CSP', { timeout: 420_000 }, async t => {
  const fixture = await startHarness();
  const pages = new Map();
  const scenario = async (name, optionsOrRun, run) => {
    let passed = false;
    const options = run ? optionsOrRun : {};
    const execute = run || optionsOrRun;
    await t.test(name, options, async () => { await execute(); passed = true; });
    assert.ok(passed, `Stop dependent scenarios after failure: ${name}`);
  };
  try {
    const hostContext = await fixture.browser('host', { initScript: observeMedia });
    const { page: host, studioId } = await createStudio(hostContext, { url: fixture.url });
    pages.set('host', host);
    let guest;

    await scenario('owner creates a studio; guest waits privately and is admitted backstage', async () => {
      guest = await joinStudio(await fixture.browser('guest', { initScript: observeMedia }), { url: fixture.url, studioId });
      pages.set('guest', guest);
      await host.getByRole('button', { name: 'Move Test Guest backstage', exact: true }).waitFor();
      assert.equal(await guest.getByTestId('program-return-monitor').count(), 0);
      assert.equal(await guest.evaluate(() => window.__e2eMedia.remoteTracks.filter(track => track.readyState === 'live').length), 0, 'waiting guests receive no remote media');
      await admitGuest(host, 'Test Guest');
      await guest.getByTestId('program-return-monitor').waitFor();
    });

    await scenario('backstage guest receives a playing program return and moves onto stage', async () => {
      await guest.locator('video[aria-label="Live program (Preview)"]').waitFor();
      await guest.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.getAttribute('aria-label')?.startsWith('Live program') && video.readyState >= 2 && video.currentTime > 0));
      await screenshot(guest, fixture.artifactDir, 'backstage-program-1440');
      await stageGuest(host, 'Test Guest');
      await host.getByRole('region', { name: 'Broadcast canvas' }).getByText('Test Guest', { exact: true }).waitFor();
      await guest.getByTestId('program-return-monitor').waitFor({ state: 'hidden' });
      await assertPlayingRemoteHost(guest, fixture.artifactDir, 'after-stage');
    });

    await scenario('watch-page viewer casts a poll vote visible to the host', async () => {
      await host.getByRole('button', { name: 'More tools', exact: true }).click();
      await host.getByRole('dialog', { name: 'Studio tools' }).getByRole('button', { name: 'Polls', exact: true }).click();
      await host.getByPlaceholder('What should we cover next?').fill('Which topic comes next?');
      await host.getByPlaceholder('Option 1', { exact: true }).fill('Prayer');
      await host.getByPlaceholder('Option 2', { exact: true }).fill('Study');
      await host.getByRole('button', { name: 'Start Poll', exact: true }).click();
      await host.getByRole('heading', { name: 'Which topic comes next?', exact: true }).waitFor();
      await host.getByRole('button', { name: 'Close polls', exact: true }).click();
      await host.getByRole('button', { name: 'Open invite panel', exact: true }).click();
      const watchUrl = new URL(await host.getByLabel('Public watch page link', { exact: true }).inputValue());
      assert.match(watchUrl.pathname, /^\/watch\/[^/]+$/);
      await host.getByRole('button', { name: 'Close invite panel', exact: true }).click();
      await host.getByRole('button', { name: 'More tools', exact: true }).click();
      await host.getByRole('dialog', { name: 'Studio tools' }).getByRole('button', { name: 'Polls', exact: true }).click();
      const viewer = await (await fixture.browser('viewer')).newPage();
      pages.set('viewer', viewer);
      // Local builds may keep the owner's production invite-base setting.
      // Preserve the exact canonical watch ID while staying on our test origin.
      await viewer.goto(new URL(watchUrl.pathname, fixture.url).href);
      await viewer.getByRole('region', { name: 'Live poll' }).getByRole('button', { name: '1 Prayer', exact: true }).click();
      await viewer.getByText('Thanks for voting.', { exact: false }).waitFor();
      await host.getByText('1 vote', { exact: true }).waitFor();
      await screenshot(viewer, fixture.artifactDir, 'watch-poll');
      await host.getByRole('button', { name: 'Close polls', exact: true }).click();
    });

    await scenario('custom layout saves and applies to the broadcast canvas', async () => {
      await host.getByRole('button', { name: 'Edit custom layouts', exact: true }).click();
      const editor = host.getByRole('dialog', { name: 'Custom layouts', exact: true });
      await editor.getByRole('button', { name: 'New 16:9 layout', exact: true }).click();
      await editor.getByLabel('Name', { exact: true }).fill('Qualification layout');
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await editor.getByText('Saved Qualification layout.', { exact: true }).waitFor();
      await editor.getByRole('button', { name: 'Use on stage', exact: true }).click();
      await editor.getByText('Qualification layout is on stage.', { exact: true }).waitFor();
      await editor.getByRole('button', { name: 'Close layout editor', exact: true }).click();
      assert.equal(await host.getByRole('radio', { name: 'Custom layout - Qualification layout', exact: true }).getAttribute('aria-checked'), 'true');
      await host.getByRole('button', { name: 'Edit custom layouts', exact: true }).click();
      assert.equal(await editor.getByLabel('Name', { exact: true }).inputValue(), 'Qualification layout');
      await editor.getByRole('button', { name: 'Close layout editor', exact: true }).click();
    });

    await scenario('portrait 9:16 updates the actual stage geometry', async () => {
      await host.getByRole('button', { name: 'Go live: open stream destinations', exact: true }).click();
      await host.getByText('Output settings', { exact: true }).click();
      await host.getByRole('button', { name: 'Portrait 9:16 output', exact: true }).click();
      await host.waitForFunction(() => document.querySelector('[aria-label="Broadcast canvas"]')?.getAttribute('data-stage-orientation') === 'portrait');
      const dimensions = await host.getByRole('region', { name: 'Broadcast canvas' }).evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight }));
      assert.equal(dimensions.width / dimensions.height, 9 / 16);
      await screenshot(host, fixture.artifactDir, 'portrait-output');
      await host.getByRole('button', { name: 'Landscape 16:9 output', exact: true }).click();
      await host.getByRole('button', { name: 'Close destinations panel', exact: true }).click();
    });

    await scenario('talkback displays a server-confirmed off-air badge', async () => {
      await host.getByRole('button', { name: 'Talk backstage (your mic leaves the broadcast)', exact: true }).click();
      await host.locator('[data-testid="talkback-badge"][data-confirmed="true"]').waitFor();
      assert.equal(await host.getByTestId('talkback-badge').innerText(), 'Off air — talking backstage');
      await screenshot(host, fixture.artifactDir, 'talkback');
      await host.getByRole('button', { name: 'Stop talking backstage and go back on air', exact: true }).click();
      await host.getByTestId('talkback-badge').waitFor({ state: 'hidden' });
      await assertPlayingRemoteHost(guest, fixture.artifactDir, 'after-talkback');
    });

    // Budget capture + OPFS commit + finalization independently. A 75s outer
    // deadline could cancel a healthy save before its selector wait expired.
    await scenario('on-screen chat shows a public guest message and never a backstage one', async () => {
      await host.getByRole('button', { name: 'Chat', exact: true }).click();
      const chat = host.locator('.studio-chat');
      await chat.getByRole('button', { name: 'Chat on screen: Off' }).click();
      await guest.getByRole('button', { name: /^Open chat/ }).click();
      const guestInput = guest.locator('input.chat-input');
      await guestInput.fill('Is the chat overlay live?');
      await guestInput.press('Enter');
      const overlayText = text => host.locator('[data-chat-overlay] text', { hasText: text });
      await overlayText('Is the chat overlay live?').waitFor();
      await overlayText('Question').waitFor();
      await chat.getByLabel('Chat channel').selectOption('backstage');
      const hostInput = host.locator('input.chat-input');
      await hostInput.fill('Backstage only note');
      await hostInput.press('Enter');
      await chat.getByText('Backstage only note').waitFor();
      await chat.getByLabel('Chat channel').selectOption('public');
      await hostInput.fill('Public follow-up');
      await hostInput.press('Enter');
      await overlayText('Public follow-up').waitFor();
      assert.equal(await overlayText('Backstage only note').count(), 0, 'backstage chat never reaches the overlay');
      await screenshot(host, fixture.artifactDir, 'chat-overlay');
      await chat.getByRole('button', { name: 'Chat on screen: On' }).click();
      await host.locator('[data-chat-overlay]').waitFor({ state: 'detached' });
      await host.getByRole('button', { name: 'Close sidebar panel', exact: true }).click();
      await guest.getByRole('button', { name: 'Close chat', exact: true }).click();
    });

    await scenario('thirty-second recording persists non-empty program and participant tracks in OPFS', { timeout: 210_000 }, async () => {
      // Exclude any earlier capability probes from recording evidence.
      await host.evaluate(() => { window.__e2eMedia.recorders = []; });
      await guest.evaluate(() => { window.__e2eMedia.recorders = []; });
      await host.getByRole('button', { name: 'Start recording', exact: true }).click();
      await host.getByRole('button', { name: 'Stop recording', exact: true }).waitFor();
      await host.waitForFunction(() => window.__e2eMedia.recorders.some(record => record.startedAt !== null && performance.now() - record.startedAt >= 30_000 && record.bytes > 0), null, { timeout: 45_000 });
      await guest.waitForFunction(() => window.__e2eMedia.recorders.some(record => record.bytes > 0));
      // Read committed OPFS fragments while capture owns them, before finalization can move/delete them.
      const files = {};
      for (const [person, page, expectedTracks] of [['host', host, 3], ['guest', guest, 2]]) {
        files[person] = await eventually(async () => {
          const list = await recoveryFiles(page);
          const tracks = new Set(list.filter(file => file.filename.startsWith('/studio-recording-recovery/') && file.size > 0).map(file => path.dirname(file.filename)));
          return tracks.size >= expectedTracks ? list : null;
        }, { timeout: 15_000, message: `${person} did not commit every recording track to OPFS` });
      }
      await host.getByRole('button', { name: 'Stop recording', exact: true }).click();
      const stopClickedAt = Date.now();
      try {
        // Passing CI runs already take 30-40 s to close out a 30 s take on a
        // shared runner; a real stall shows up as a missing stop/finalize below.
        await host.getByRole('button', { name: 'Start recording', exact: true }).waitFor({ timeout: 120_000 });
      } catch (error) {
        const state = {
          waitedMs: Date.now() - stopClickedAt,
          host: await host.evaluate(() => window.__e2eMedia.recorders.map(record => ({ ...record, now: performance.now() }))),
          guest: await guest.evaluate(() => window.__e2eMedia.recorders.map(record => ({ ...record, now: performance.now() }))),
        };
        await writeFile(path.join(fixture.artifactDir, 'recording-finalize-timeout.json'), JSON.stringify(state, null, 2));
        await screenshot(host, fixture.artifactDir, 'recording-finalize-timeout');
        throw error;
      }
      await writeFile(path.join(fixture.artifactDir, 'recording-finalize-timing.json'), JSON.stringify({ finalizeMs: Date.now() - stopClickedAt }, null, 2));
      for (const page of [host, guest]) await page.waitForFunction(() => window.__e2eMedia.recorders.filter(record => record.startedAt !== null).every(record => record.stopped));
      const recordings = { host: await host.evaluate(() => window.__e2eMedia.recorders), guest: await guest.evaluate(() => window.__e2eMedia.recorders) };
      await writeFile(path.join(fixture.artifactDir, 'recording-evidence.json'), JSON.stringify({ files, recordings }, null, 2));
      for (const [person, records] of Object.entries(recordings)) {
        const started = records.filter(record => record.startedAt !== null);
        assert.ok(started.length >= (person === 'host' ? 3 : 2), `${person} recorded every expected program/ISO/audio track`);
        assert.ok(started.every(record => record.stopped && record.bytes > 0 && record.chunks > 0), `${person}: every started track finalized with media`);
      }
      await assertPlayingRemoteHost(guest, fixture.artifactDir, 'after-recording');
    });

    await scenario('studio remains usable at desktop, small laptop and phone widths', async () => {
      for (const [width, height] of [[1440, 900], [1000, 625], [390, 844]]) {
        await host.setViewportSize({ width, height });
        await host.getByRole('button', { name: 'Start recording', exact: true }).waitFor();
        assert.ok(await host.getByRole('region', { name: 'Broadcast canvas' }).isVisible());
        await screenshot(host, fixture.artifactDir, `host-${width}x${height}`);
      }
      await guest.setViewportSize({ width: 390, height: 844 });
      await assertPlayingRemoteHost(guest, fixture.artifactDir, 'after-phone-resize');
      await screenshot(guest, fixture.artifactDir, 'guest-390x844');
      await host.setViewportSize({ width: 1440, height: 900 });
    });

    await scenario('explicit Leave removes a guest promptly; tab close removes them within ten seconds', async () => {
      let started = Date.now();
      await guest.getByRole('button', { name: 'Leave studio', exact: true }).click();
      await host.getByRole('region', { name: 'Broadcast canvas' }).getByText('Test Guest', { exact: true }).waitFor({ state: 'hidden', timeout: 2500 });
      const explicitLeaveMs = Date.now() - started;
      const closing = await joinStudio(await fixture.browser('closing-guest'), { url: fixture.url, studioId, name: 'Closing Guest' });
      await admitGuest(host, 'Closing Guest');
      await stageGuest(host, 'Closing Guest');
      await host.getByRole('region', { name: 'Broadcast canvas' }).getByText('Closing Guest', { exact: true }).waitFor();
      started = Date.now();
      await closing.close();
      await host.getByRole('region', { name: 'Broadcast canvas' }).getByText('Closing Guest', { exact: true }).waitFor({ state: 'hidden', timeout: 10_500 });
      await writeFile(path.join(fixture.artifactDir, 'departure-evidence.json'), JSON.stringify({ explicitLeaveMs, tabCloseMs: Date.now() - started }, null, 2));
    });

    assert.deepEqual(fixture.pageErrors, [], 'No uncaught application errors');
    assert.deepEqual(fixture.cspViolations, [], 'No CSP violations');
  } finally {
    for (const [name, page] of pages) if (!page.isClosed()) await screenshot(page, fixture.artifactDir, `final-${name}`).catch(() => {});
    await fixture.close();
  }
});
