import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createStudio, startHarness } from './harness.mjs';

const sessionId = 'test-editor-take';
const fileId = sessionId + '-track-1';

async function seedTake(page) {
  return page.evaluate(async ({ sessionId, fileId }) => {
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
    while (performance.now() - start < 3500) {
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
      totalBytes: blob.size, durationSeconds: 3.5, files: [metadata],
    });
    tx.objectStore('files').put({ ...metadata, sessionId, blob });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { sourceSize: blob.size, digest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))) };
  }, { sessionId, fileId });
}

async function seedEdit(page, sourceSize) {
  return page.evaluate(async ({ sessionId, fileId, sourceSize }) => {
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
        text: 'Welcome, remove this everyone. Goodbye.', durationSeconds: 3.5,
        words: [
          { word: 'Welcome,', start: 0.35, end: 0.75 },
          { word: 'remove', start: 1, end: 1.45 },
          { word: 'this', start: 1.75, end: 2.1 },
          { word: 'everyone.', start: 2.35, end: 2.72 },
          { word: 'Goodbye.', start: 3, end: 3.25 },
        ],
      },
      edit: { removeFillers: false, removeRepeats: false, shortenPauses: false, pauseThreshold: 1, restored: [], manualWords: [], excerpt: null },
    }, sessionId);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { sessionId, fileId, sourceSize });
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
