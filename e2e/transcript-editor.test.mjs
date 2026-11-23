import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { createStudio, startHarness } from './harness.mjs';

const sessionId = 'test-editor-take';
const fileId = sessionId + '-track-1';

async function seedMixTracks(page) {
  await page.evaluate(async ({ sessionId, fileId }) => {
    const read = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await read(indexedDB.open('livestream-studio-recording-library'));
    const origin = Date.parse('2026-08-22T02:00:00Z');
    const stamp = (track, delay) => ({
      sourceId: track.id, sourceKind: track.kind, sourceLabel: track.label, mimeType: track.type,
      startedAt: new Date(origin + delay).toISOString(), trackCount: 0, tracks: [],
      timeline: { timeOrigin: origin, startMs: origin + delay, segmentIndex: 0, pauses: [] },
    });
    const stem = (name, amplitude, frequency, delay) => {
      const rate = 48_000;
      const frames = rate * 4;
      const bytes = new Uint8Array(44 + frames * 2);
      const view = new DataView(bytes.buffer);
      const tag = (offset, value) => bytes.set(new TextEncoder().encode(value), offset);
      tag(0, 'RIFF');
      view.setUint32(4, bytes.length - 8, true);
      tag(8, 'WAVE');
      tag(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      tag(36, 'data');
      view.setUint32(40, frames * 2, true);
      for (let frame = 0; frame < frames; frame += 1) {
        view.setInt16(44 + frame * 2, 32767 * amplitude * Math.sin(2 * Math.PI * frequency * frame / rate), true);
      }
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const track = {
        id: name + '-audio', label: name + ' audio', fileName: name + '.wav',
        kind: 'audio', type: blob.type, size: blob.size, blob, sessionId,
      };
      return { ...track, capture: stamp(track, delay) };
    };
    const transaction = db.transaction(['files', 'sessions'], 'readwrite');
    const files = transaction.objectStore('files');
    const sessions = transaction.objectStore('sessions');
    const [program, saved] = await Promise.all([read(files.get(fileId)), read(sessions.get(sessionId))]);
    const records = [
      { ...program, capture: stamp(program, 0) },
      stem('Host', 0.35, 440, 0), stem('Guest', 0.55, 880, 0), stem('Late speaker', 0.14, 330, 1100),
    ];
    for (const record of records) files.put(record);
    sessions.put({ ...saved, trackCount: records.length, totalBytes: records.reduce((sum, file) => sum + file.size, 0),
      files: records.map(({ blob: _blob, sessionId: _sessionId, ...file }) => file) });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, { sessionId, fileId });
}

async function seedTake(page, durationSeconds = 3.5) {
  return page.evaluate(async ({ sessionId, fileId, durationSeconds }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(20);
    const track = stream.getVideoTracks()[0];
    const recording = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    recording.ondataavailable = (event) => chunks.push(event.data);
    const finished = new Promise((resolve) => recording.addEventListener('stop', resolve, { once: true }));
    recording.start();
    const start = performance.now();
    while (performance.now() - start < durationSeconds * 1000) {
      const elapsed = performance.now() - start;
      context.fillStyle = elapsed < 2200 ? '#102a57' : '#315426';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await new Promise((resolve) => setTimeout(resolve, 46));
    }
    recording.stop();
    await finished;
    track.stop();
    const blob = new Blob(chunks, { type: 'video/webm' });
    const fileName = 'test-program.webm';
    const metadata = { id: fileId, label: 'Program', fileName, size: blob.size, type: blob.type, kind: 'program' };
    const open = indexedDB.open('livestream-studio-recording-library', 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
    };
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction(['sessions', 'files'], 'readwrite');
    tx.objectStore('sessions').put({
      id: sessionId, roomName: 'Saved sermon', createdAt: new Date().toISOString(), trackCount: 1,
      totalBytes: blob.size, durationSeconds, files: [metadata],
    });
    tx.objectStore('files').put({ ...metadata, sessionId, blob });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { sourceSize: blob.size, digest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))) };
  }, { sessionId, fileId, durationSeconds });
}

async function seedEdit(page, sourceSize, durationSeconds = 3.5) {
  return page.evaluate(async ({ sessionId, fileId, sourceSize, durationSeconds }) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('livestream-studio-recording-library', 2);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction('transcript-projects', 'readwrite');
    const fileName = 'test-program.webm';
    tx.objectStore('transcript-projects').put({
      sourceId: fileId, sourceSize,
      transcript: {
        sourceFileName: fileName, sourceLabel: 'Program', model: 'test', createdAt: new Date().toISOString(),
        text: 'Welcome, remove this everyone. Goodbye.', durationSeconds,
        words: [
          { word: 'Welcome,', start: 0.35, end: 0.75 },
          { word: 'remove', start: 1, end: 1.45 },
          { word: 'this', start: 1.75, end: 2.1 },
          { word: 'everyone.', start: 2.35, end: 2.72 },
          { word: 'Goodbye.', start: 3, end: 3.25 },
          ...(durationSeconds > 10 ? [{ word: 'Takeaway.', start: 6, end: 6.8 }] : []),
        ],
      },
      edit: { removeFillers: false, removeRepeats: false, shortenPauses: false, pauseThreshold: 1, restored: [], manualWords: [], excerpt: null },
    }, sessionId);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { sessionId, fileId, sourceSize, durationSeconds });
}

test('edit a saved take by transcript and export a captioned excerpt without changing the source', { timeout: 75_000 }, async () => {
  const harness = await startHarness();
  try {
    const browser = await harness.browser('transcript-editor', {
      initScript: () => {
        // Headless Chrome cannot answer the native folder picker. Exercise the existing download fallback.
        Object.defineProperty(window, 'showDirectoryPicker', { value: undefined });
      },
    });
    const seedPage = await browser.newPage();
    const fixtureUrl = harness.url + '/editor-fixture';
    await seedPage.route(fixtureUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recording fixture</title>' }));
    await seedPage.goto(fixtureUrl);
    const { sourceSize, digest: originalDigest } = await seedTake(seedPage);
    await seedPage.close();
    const { page } = await createStudio(browser, { url: harness.url, name: 'Transcript editor test' });
    await page.getByRole('button', { name: 'More tools', exact: true }).click();
    await page.getByRole('button', { name: 'Recordings', exact: true }).click();

    const openEditor = page.getByRole('button', { name: 'Edit transcript', exact: true });
    await openEditor.waitFor();
    // Opening the real library migrated the legacy database without touching the take.
    await seedEdit(page, sourceSize);
    await openEditor.click();
    const editor = page.getByRole('dialog', { name: 'Transcript editor' });
    const word = (name) => editor.getByRole('group', { name: 'Timed transcript' }).getByRole('button', { name, exact: true });

    await editor.getByRole('button', { name: 'Select passage', exact: true }).click();
    await word('remove').click();
    await word('this').click();
    await editor.getByRole('button', { name: 'Cut passage', exact: true }).click();
    assert.equal(await word('remove').getAttribute('aria-pressed'), 'true');
    assert.equal(await word('this').getAttribute('aria-pressed'), 'true');

    await editor.getByRole('button', { name: 'Select passage', exact: true }).click();
    await word('Welcome,').click();
    await word('everyone.').click();
    await editor.getByRole('button', { name: 'Use as clip', exact: true }).click();
    await editor.getByRole('button', { name: 'Save edit', exact: true }).click();
    await editor.getByText('Edit saved on this device', { exact: true }).waitFor();
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click();

    await openEditor.click();
    await word('remove').waitFor();
    assert.equal(await word('remove').getAttribute('aria-pressed'), 'true');
    await editor.getByRole('button', { name: 'Edit full take', exact: true }).waitFor();
    await editor.getByRole('button', { name: 'Preview edit', exact: true }).click();
    await page.waitForFunction(() => {
      const preview = document.querySelector('video[aria-label="Edited video preview"]');
      return preview && preview.currentTime >= 2.15;
    });

    await page.screenshot({ path: path.join(harness.artifactDir, 'transcript-editor.png') });
    const captions = editor.getByRole('checkbox', { name: 'Burn captions into video' });
    assert.equal(await captions.isChecked(), true);
    const downloaded = page.waitForEvent('download', { timeout: 25_000 });
    await editor.getByRole('button', { name: 'Export clip', exact: true }).click();
    const download = await downloaded.catch(async (error) => {
      await page.screenshot({ path: path.join(harness.artifactDir, 'transcript-editor-error.png') });
      throw new Error((await editor.getByRole('alert').allTextContents()).join(' ') || 'The edited clip was not downloaded.', { cause: error });
    });
    assert.match(download.suggestedFilename(), /_clip.*\.mp4$/);
    const output = path.join(harness.artifactDir, 'captioned-excerpt.mp4');
    await download.saveAs(output);
    const result = await page.evaluate(async ({ media, fileId }) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(media), (char) => char.charCodeAt(0))], { type: 'video/mp4' }));
      const play = new Promise((resolve, reject) => {
        video.addEventListener('loadeddata', resolve, { once: true });
        video.addEventListener('error', reject, { once: true });
      });
      video.src = url;
      await play;
      const sought = new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
      video.currentTime = 0.25;
      await sought;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 100, canvas.width, canvas.height - 100).data;
      let captionPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 160 || pixels[i + 1] > 180 || pixels[i + 2] > 190) captionPixels += 1;
      }
      URL.revokeObjectURL(url);
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open('livestream-studio-recording-library', 2);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const original = await new Promise((resolve, reject) => {
        const get = db.transaction('files', 'readonly').objectStore('files').get(fileId);
        get.onsuccess = () => resolve(get.result.blob);
        get.onerror = () => reject(get.error);
      });
      db.close();
      return {
        duration: video.duration,
        captionPixels,
        digest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await original.arrayBuffer()))),
      };
    }, { media: (await readFile(output)).toString('base64'), fileId });
    assert.ok(result.duration > 0.95 && result.duration < 1.5, 'export includes the excerpt minus the full cut');
    assert.ok(result.captionPixels > 30, 'the caption is visibly rendered into the video frame');
    assert.deepEqual(result.digest, originalDigest, 'the original media remains byte-for-byte intact');
    assert.deepEqual(harness.pageErrors, []);
    assert.deepEqual(harness.cspViolations, []);
  } finally {
    await harness.close();
  }
});

test('preview, save and download a speaker mix using recorded track timing', { timeout: 75_000 }, async () => {
  const harness = await startHarness();
  try {
    const browser = await harness.browser('transcript-mix');
    const seedPage = await browser.newPage();
    const fixtureUrl = harness.url + '/mix-fixture';
    await seedPage.route(fixtureUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mix fixture</title>' }));
    await seedPage.goto(fixtureUrl);
    const { sourceSize } = await seedTake(seedPage);
    await seedMixTracks(seedPage);
    await seedPage.close();
    const { page } = await createStudio(browser, { url: harness.url, name: 'Mix editor test' });
    await page.getByRole('button', { name: 'More tools', exact: true }).click();
    await page.getByRole('button', { name: 'Recordings', exact: true }).click();
    const openEditor = page.getByRole('button', { name: 'Edit transcript', exact: true });
    await openEditor.waitFor();
    await seedEdit(page, sourceSize);
    await openEditor.click();
    const editor = page.getByRole('dialog', { name: 'Transcript editor' });
    const mix = editor.getByText('Multitrack mix', { exact: true });
    await mix.click();
    assert.equal(await editor.getByLabel('Picture track').inputValue(), fileId);
    const hostGain = editor.getByRole('slider', { name: 'Host audio' });
    for (let step = 0; step < 6; step += 1) await hostGain.press('ArrowLeft');
    const guestMute = editor.getByRole('checkbox', { name: 'Mute Guest audio' });
    await guestMute.check();
    await editor.getByRole('button', { name: 'Save edit', exact: true }).click();
    await editor.getByText('Edit saved on this device', { exact: true }).waitFor();
    await editor.getByRole('button', { name: 'Close editor', exact: true }).click();
    await openEditor.click();
    await mix.click();
    assert.equal(await hostGain.inputValue(), '-6');
    assert.equal(await guestMute.isChecked(), true);

    await editor.getByRole('button', { name: 'Preview mix', exact: true }).click();
    const preview = editor.getByLabel('Mixed recording preview');
    await preview.waitFor({ timeout: 20_000 }).catch(async (error) => {
      throw new Error((await editor.getByRole('alert').allTextContents()).join(' ') || 'The mix preview was not rendered.', { cause: error });
    });
    const measured = await preview.evaluate(async (video) => {
      const bytes = await (await fetch(video.src)).arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const context = new AudioContext({ sampleRate: 48_000 });
      try {
        const audio = await context.decodeAudioData(bytes);
        const mono = audio.getChannelData(0);
        const amplitude = (frequency, start) => {
          const samples = audio.sampleRate / 5;
          const offset = Math.round(start * audio.sampleRate);
          let sine = 0;
          let cosine = 0;
          for (let frame = 0; frame < samples; frame += 1) {
            const angle = 2 * Math.PI * frequency * frame / audio.sampleRate;
            sine += mono[offset + frame] * Math.sin(angle);
            cosine += mono[offset + frame] * Math.cos(angle);
          }
          return 2 * Math.hypot(sine, cosine) / samples;
        };
        return { hash, host: amplitude(440, 0.35), guest: amplitude(880, 1.45), early: amplitude(330, 0.35), late: amplitude(330, 1.45) };
      } finally {
        await context.close();
      }
    });
    assert.ok(measured.host > 0.14 && measured.host < 0.21, JSON.stringify(measured));
    assert.ok(measured.guest < 0.025 && measured.early < 0.025, JSON.stringify(measured));
    assert.ok(measured.late > 0.105 && measured.late < 0.17, JSON.stringify(measured));

    const downloaded = page.waitForEvent('download');
    await editor.getByRole('button', { name: 'Download mixed MP4', exact: true }).click();
    const exportFile = await downloaded;
    assert.match(exportFile.suggestedFilename(), /_mix_cleaned\.mp4$/);
    const output = path.join(harness.artifactDir, 'multitrack-mix.mp4');
    await exportFile.saveAs(output);
    assert.equal(createHash('sha256').update(await readFile(output)).digest('hex'), measured.hash);
    await hostGain.press('ArrowRight');
    assert.equal(await preview.count(), 0);
  } finally {
    await harness.stop();
  }
});

test('render and review multiple portrait highlights from a saved take', { timeout: 95_000 }, async () => {
  const harness = await startHarness();
  try {
    const browser = await harness.browser('batch-clips', {
      initScript: () => {
        Object.defineProperty(window, 'LanguageModel', {
          configurable: true,
          value: {
            availability: async () => 'available',
            create: async () => ({
              prompt: async () => JSON.stringify({ highlights: [
                { title: 'Opening highlight', startSeconds: 0, endSeconds: 5.4 },
                { title: 'Closing highlight', startSeconds: 5.4, endSeconds: 10.8 },
              ] }),
            }),
          },
        });
      },
    });
    const seedPage = await browser.newPage();
    const fixtureUrl = harness.url + '/batch-clips-fixture';
    await seedPage.route(fixtureUrl, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Batch clips fixture</title>' }));
    await seedPage.goto(fixtureUrl);
    const durationSeconds = 11.2;
    const { sourceSize, digest: before } = await seedTake(seedPage, durationSeconds);
    await seedPage.close();

    const { page } = await createStudio(browser, { url: harness.url, name: 'Batch clips browser test' });
    await page.getByRole('button', { name: 'More tools', exact: true }).click();
    await page.getByRole('button', { name: 'Recordings', exact: true }).click();
    await page.getByRole('button', { name: 'Edit transcript', exact: true }).waitFor();
    await seedEdit(page, sourceSize, durationSeconds);
    await page.getByRole('button', { name: 'Tracks', exact: true }).click();
    await page.getByTitle('Preview Program', { exact: true }).click();
    const preview = page.getByRole('region', { name: 'Recording preview' });
    await preview.getByRole('button', { name: 'AI highlights', exact: true }).click();
    await preview.getByText('Batch clips', { exact: true }).click();
    const batch = preview.locator('.recording-clip-batch');
    await batch.getByRole('checkbox', { name: /Opening highlight/ }).check();
    await batch.getByRole('checkbox', { name: /Closing highlight/ }).check();
    await batch.getByRole('checkbox', { name: 'Smart framing', exact: true }).uncheck();
    assert.equal(await batch.getByRole('checkbox', { name: 'Burn in captions', exact: true }).isChecked(), true);
    await batch.getByRole('button', { name: 'Render 2 clips', exact: true }).click();
    await batch.getByText('2 of 2 clips ready', { exact: true }).waitFor({ timeout: 45_000 });

    await batch.getByRole('button', { name: 'Review Opening highlight', exact: true }).click();
    const video = batch.locator('video');
    const dimensions = await video.evaluate((previewVideo) => new Promise((resolve, reject) => {
      const media = () => resolve([previewVideo.videoWidth, previewVideo.videoHeight]);
      if (previewVideo.readyState > 0) media();
      else {
        previewVideo.addEventListener('loadedmetadata', media, { once: true });
        previewVideo.addEventListener('error', () => reject(new Error('Could not play clip')), { once: true });
      }
    }));
    assert.ok(dimensions[0] > 0);
    assert.ok(Math.abs(dimensions[0] / dimensions[1] - 9 / 16) < 0.02);
    const downloadPromise = page.waitForEvent('download');
    await batch.getByRole('button', { name: 'Download ready clips as ZIP', exact: true }).click();
    const download = await downloadPromise;
    const archive = await JSZip.loadAsync(await readFile(await download.path()));
    assert.equal(Object.keys(archive.files).length, 2);
    assert.ok(Object.keys(archive.files).every((name) => /_9x16\.(webm|mp4)$/.test(name)));

    const after = await page.evaluate(async (id) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('livestream-studio-recording-library', 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const request = db.transaction('files', 'readonly').objectStore('files').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer())));
    }, fileId);
    assert.deepEqual(after, before);
  } finally {
    await harness.close();
  }
});
