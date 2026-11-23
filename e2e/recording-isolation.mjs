/** Native camera and 1080p canvas baselines. These captures do not qualify the studio. */
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, startHarness } from './harness.mjs';
import { verifyRecordingChunks } from './recording-checksums.mjs';
import { probeRecording } from './recording-metrics.mjs';
import { observeCaptureResources } from './recording-resources.mjs';

const seconds = Number(process.env.SOAK_SECONDS || 35);
assert.ok(Number.isFinite(seconds) && seconds >= 15 && seconds <= 120, 'Use a 15–120 second diagnostic');
const codec = process.env.ISOLATION_CODEC || 'vp9';
assert.match(codec, /^(vp8|vp9)$/);
const artifactDir = path.resolve(process.env.SOAK_ARTIFACT_DIR || path.join(repoRoot, 'output/recording-isolation'));
const harness = await startHarness({ artifactDir, ...(process.env.SOAK_DIST_DIR ? { distDir: process.env.SOAK_DIST_DIR } : {}) });
const result = { seconds, codec, captures: [] };

async function capture(page, kind) {
  await page.goto(harness.url);
  const evidence = await page.evaluate(async ({ seconds, kind, codec }) => {
    const source = await navigator.mediaDevices.getUserMedia({
      video: { width: { exact: 1280 }, height: { exact: 720 }, frameRate: { exact: 30 } }, audio: true,
    });
    const output = await (await navigator.storage.getDirectory()).getFileHandle(`${kind}.webm`, { create: true });
    const writer = await output.createWritable();
    let interval;
    let composite;
    let video;
    let audio;
    let captureStream = source;
    const mimeType = `video/webm;codecs=${codec},opus`;
    try {
      if (kind === 'program') {
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:180px';
        video.srcObject = source;
        document.body.append(video);
        await video.play();
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const context = canvas.getContext('2d');
        composite = canvas.captureStream(30);
        audio = new AudioContext({ sampleRate: 48000 });
        const mixed = audio.createMediaStreamDestination();
        audio.createMediaStreamSource(source).connect(mixed);
        await audio.resume();
        const draw = () => {
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
        };
        draw();
        interval = window.setInterval(draw, 1000 / 30);
        captureStream = new MediaStream([...composite.getVideoTracks(), ...mixed.stream.getAudioTracks()]);
      }
      const settings = captureStream.getVideoTracks()[0].getSettings();
      const recorder = new MediaRecorder(captureStream, {
        mimeType,
        videoBitsPerSecond: kind === 'program' ? 20_000_000 : 5_000_000,
        audioBitsPerSecond: 256_000,
      });
      const chunks = [];
      let queue = Promise.resolve();
      let start;
      let stop;
      await new Promise((resolve, reject) => {
        recorder.addEventListener('start', () => {
          start = performance.now();
          setTimeout(() => { stop = performance.now(); recorder.stop(); }, seconds * 1000);
        }, { once: true });
        recorder.addEventListener('error', error => reject(error.error), { once: true });
        recorder.addEventListener('dataavailable', ({ data }) => {
          if (!data.size) return;
          queue = queue.then(async () => {
            const buffer = await data.arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
            await writer.write(buffer);
            chunks.push({ bytes: data.size, sha256 });
          });
        });
        recorder.addEventListener('stop', () => { void queue.then(resolve, reject); }, { once: true });
        recorder.start(1000);
      });
      return { settings, observedSeconds: (stop - start) / 1000, chunks, resources: window.__captureResources };
    } finally {
      clearInterval(interval);
      video?.remove();
      source.getTracks().forEach(track => track.stop());
      composite?.getTracks().forEach(track => track.stop());
      await audio?.close();
      await writer.close();
    }
  }, { seconds, kind, codec });
  assert.equal(evidence.settings.width, kind === 'program' ? 1920 : 1280);
  assert.equal(evidence.settings.height, kind === 'program' ? 1080 : 720);
  const filename = `${kind}.webm`;
  const downloaded = page.waitForEvent('download');
  await page.evaluate(async name => {
    const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = name;
    link.click();
  }, filename);
  const file = path.join(artifactDir, filename);
  await (await downloaded).saveAs(file);
  const sha256 = await verifyRecordingChunks(createReadStream(file), evidence.chunks);
  assert.ok(sha256, `${kind} contains the original chunks`);
  let timing;
  let errors;
  try { timing = await probeRecording(file); }
  catch (error) { timing = error.packetMetrics; errors = error.message; }
  assert.ok(timing, `${kind} produced probeable media`);
  return { kind, file, sha256, ...evidence, timing, ...(errors ? { errors } : {}) };
}

try {
  for (const kind of ['camera', 'program']) {
    const context = await harness.browser(`isolated-${kind}`);
    await context.addInitScript(observeCaptureResources);
    const page = await context.newPage();
    try {
      const evidence = await capture(page, kind);
      result.captures.push(evidence);
      console.log(JSON.stringify({ kind, avDriftMs: evidence.timing.avDriftMs, timings: evidence.timing.timelines, errors: evidence.errors }));
    } finally { await context.close(); }
  }
} finally {
  await writeFile(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));
  await harness.close();
}
