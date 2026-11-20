import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import ffmpegStatic from 'ffmpeg-static';
import { createStudio, screenshot, startHarness } from './harness.mjs';

const run = promisify(execFile);
const artifactDir = path.join(process.env.E2E_ARTIFACT_DIR || path.resolve('output/e2e'), 'service-tools');

test('organizes portable service presets and lets a viewer toggle timed captions', { timeout: 115_000 }, async () => {
  const fixture = await startHarness({ artifactDir });
  const pages = new Map();
  try {
    const hostContext = await fixture.browser('host');
    const { page: first } = await createStudio(hostContext, { url: fixture.url, name: 'Service preset source' });
    pages.set('source', first);
    async function openPresets(page) {
      await page.getByRole('navigation', { name: 'Studio panels' }).getByRole('button', { name: 'Scenes', exact: true }).click();
      await page.getByText('Service presets', { exact: true }).click();
    }
    await first.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('livestream-studio-service-presets', 1);
      request.onupgradeneeded = () => {
        const presets = request.result.createObjectStore('presets', { keyPath: 'id' });
        presets.add({
          id: 'legacy-preset',
          name: 'Legacy service',
          createdAt: '2026-11-20T00:00:00.000Z',
          pack: {
            version: 1, source: 'livestream-studio', exportedAt: '2026-11-20T00:00:00.000Z',
            scenes: [{
              id: 'legacy-scene', name: 'Legacy scene', layout: 'grid', customLayoutId: null,
              brandColor: '#202020', logoUrl: '', background: { type: 'color', value: '#202020' }, visibleOverlayIds: [],
            }],
            overlays: { lowerThirds: [], banners: [], timers: [], tickers: [], widgets: [] },
          },
          layouts: [],
        });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    }));
    await openPresets(first);
    await first.getByRole('group', { name: 'Unfiled', exact: true })
      .getByRole('button', { name: 'Add scenes from Legacy service', exact: true }).waitFor();
    await first.getByLabel('Preset name').fill('Sabbath service');
    await first.getByRole('button', { name: 'Save service preset', exact: true }).click();
    await first.getByText('Service preset saved.', { exact: true }).waitFor();
    await first.getByRole('button', { name: 'New folder', exact: true }).click();
    await first.getByLabel('Folder name', { exact: true }).fill('Weekly services');
    await first.getByRole('button', { name: 'Create folder', exact: true }).click();
    await first.getByRole('button', { name: 'Move Sabbath service', exact: true }).click();
    await first.getByRole('combobox', { name: 'Folder for Sabbath service', exact: true }).selectOption({ label: 'Weekly services' });
    const pendingDownload = first.waitForEvent('download');
    const weeklyFolder = first.getByRole('group', { name: 'Weekly services', exact: true });
    await weeklyFolder.getByRole('button', { name: 'Download Sabbath service', exact: true }).click();
    const download = await pendingDownload;
    assert.equal(download.suggestedFilename(), 'sabbath-service.service-preset.json');

    const restoredContext = await fixture.browser('restored-host');
    const { page: restored } = await createStudio(restoredContext, { url: fixture.url, name: 'Imported service' });
    pages.set('imported', restored);
    await openPresets(restored);
    await restored.getByRole('button', { name: 'Import preset', exact: true }).waitFor();
    assert.equal(await restored.getByRole('button', { name: 'Add scenes from Sabbath service', exact: true }).count(), 0);
    const choosing = restored.waitForEvent('filechooser');
    await restored.getByRole('button', { name: 'Import preset', exact: true }).click();
    await (await choosing).setFiles(await download.path());
    await restored.getByText('Service preset imported.', { exact: true }).waitFor();
    assert.equal(await restored.getByRole('group', { name: 'Weekly services', exact: true }).count(), 0);
    await restored.getByRole('group', { name: 'Unfiled', exact: true })
      .getByRole('button', { name: 'Add scenes from Sabbath service', exact: true }).click();
    await restored.getByText('Added 1 scene.', { exact: true }).waitFor();
    await restored.getByRole('button', { name: 'Switch to Service setup', exact: true }).click();
    await screenshot(restored, fixture.artifactDir, 'preset-imported');
    pages.delete('imported');
    await restoredContext.close();

    const { page: second } = await createStudio(hostContext, { url: fixture.url, name: 'New service' });
    pages.set('studio', second);
    await openPresets(second);
    const savedFolder = second.getByRole('group', { name: 'Weekly services', exact: true });
    await savedFolder.getByRole('button', { name: 'Add scenes from Sabbath service', exact: true }).waitFor();
    await savedFolder.getByRole('button', { name: 'Rename folder Weekly services', exact: true }).click();
    await savedFolder.getByLabel('Folder name', { exact: true }).fill('Sunday services');
    await savedFolder.getByRole('button', { name: 'Save folder name', exact: true }).click();
    const renamedFolder = second.getByRole('group', { name: 'Sunday services', exact: true });
    await renamedFolder.getByRole('button', { name: 'Add scenes from Sabbath service', exact: true }).waitFor();
    await renamedFolder.getByRole('button', { name: 'Remove folder Sunday services', exact: true }).click();
    await renamedFolder.getByRole('button', { name: 'Remove folder', exact: true }).click();
    await renamedFolder.waitFor({ state: 'detached' });
    await second.getByRole('group', { name: 'Unfiled', exact: true })
      .getByRole('button', { name: 'Add scenes from Sabbath service', exact: true }).click();
    await second.getByRole('button', { name: 'Switch to Service setup', exact: true }).click();
    await second.getByText('Added 1 scene.', { exact: true }).waitFor();
    await second.getByRole('button', { name: 'Open invite panel', exact: true }).click();
    const watchUrl = new URL(await second.getByLabel('Public watch page link', { exact: true }).inputValue());
    const watchId = watchUrl.pathname.split('/').at(-1);
    await second.getByRole('button', { name: 'Close invite panel', exact: true }).click();
    await screenshot(second, fixture.artifactDir, 'preset-restored');

    const media = path.join(fixture.artifactDir, 'local-hls');
    await mkdir(media, { recursive: true });
    await run(process.env.FFMPEG_BIN || ffmpegStatic || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x193941:s=320x180:r=25',
      '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_flags', 'program_date_time',
      '-hls_segment_filename', path.join(media, 'seg%05d.ts'), path.join(media, 'stream.m3u8'),
    ], { timeout: 20_000 });
    const playlist = await readFile(path.join(media, 'stream.m3u8'), 'utf8');
    const date = Date.parse(playlist.match(/^#EXT-X-PROGRAM-DATE-TIME:(.+)$/m)?.[1] ?? '');
    assert.ok(Number.isFinite(date));

    const viewer = await (await fixture.browser('viewer', { viewport: { width: 390, height: 844 } })).newPage();
    pages.set('viewer', viewer);
    const watchPath = '/watch/' + watchId + '/';
    const headers = { 'Access-Control-Allow-Origin': fixture.url };
    await viewer.route(fixture.apiUrl + watchPath + '*', route => {
      const file = new URL(route.request().url()).pathname.slice(watchPath.length);
      if (file === 'status') return route.fulfill({ headers, json: { live: true, playlistPath: watchPath + 'stream.m3u8' } });
      assert.match(file, /^(stream\.m3u8|seg\d{5}\.ts)$/);
      return route.fulfill({ headers, path: path.join(media, file), contentType: file.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl' });
    });
    await viewer.route(fixture.apiUrl + '/api/watch/' + watchId + '/live*', route => route.fulfill({
      headers,
      json: { switches: { chat: false, reactions: false, questions: false }, epoch: 'test', cursor: 0, reset: true, messages: [], removed: [], reactions: {}, pollMs: 20_000, captionsAvailable: true },
    }));
    let captionReads = 0;
    await viewer.route(fixture.apiUrl + '/api/watch/' + watchId + '/captions', route => {
      captionReads += 1;
      return route.fulfill({
      headers,
        json: { enabled: true, language: 'en-US', cues: [{ id: 'a', text: 'Welcome to the service', startMs: date, endMs: date + 9500 }] },
      });
    });
    await viewer.goto(new URL(watchUrl.pathname, fixture.url).href);
    const button = viewer.getByRole('button', { name: 'Closed captions', exact: true });
    await button.waitFor();
    const line = viewer.getByText('Welcome to the service', { exact: true });
    assert.equal(await line.count(), 0);
    assert.equal(captionReads, 0, 'the viewer feed advertises availability without polling for caption text');
    await button.click();
    await line.waitFor();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    await screenshot(viewer, fixture.artifactDir, 'viewer-captions-390');
    await button.click();
    await line.waitFor({ state: 'detached' });
    assert.deepEqual(fixture.pageErrors, []);
    assert.deepEqual(fixture.cspViolations, []);
  } catch (error) {
    await Promise.allSettled([...pages].map(([name, page]) => screenshot(page, fixture.artifactDir, 'failure-' + name)));
    throw error;
  } finally {
    await fixture.close();
  }
});
