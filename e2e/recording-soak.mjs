/**
 * Real-browser, three-seat recording qualification. Run after the local target build documented in e2e/README.md:
 *   npm run test:recording-soak                  # 20 minutes, qualification
 *   SOAK_SECONDS=35 npm run test:recording-soak  # development smoke only
 *
 * The picker returns a native OPFS directory. All capture, incremental folder
 * writes, RTC transfer, reconnect, finalization and manifests remain production
 * code. Artifacts include original recorder checksums, received files and metrics.
 */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { startHarness, createStudio, joinStudio, admitGuest, stageGuest, eventually, screenshot, repoRoot } from "./harness.mjs";
import { probeRecording } from "./recording-metrics.mjs";
import { verifyRecordingChunks } from "./recording-checksums.mjs";
import { observeCaptureResources } from "./recording-resources.mjs";

const requestedSeconds = Number(process.env.SOAK_SECONDS || 1200);
assert.ok(Number.isFinite(requestedSeconds) && requestedSeconds >= 15, "SOAK_SECONDS must be at least 15 seconds");
const artifactDir = path.resolve(process.env.SOAK_ARTIFACT_DIR || path.join(repoRoot, "output/recording-soak", new Date().toISOString().replaceAll(":", "-")));
const qualification = requestedSeconds >= 1200;
const useVp8Fallback = process.env.SOAK_COMPARE_VP8 === "1";
const useH264Fallback = process.env.SOAK_COMPARE_H264 === "1";
assert.ok(!useVp8Fallback || !useH264Fallback, "Select only one encoder comparison");
assert.ok(!qualification || (!useVp8Fallback && !useH264Fallback), "Qualification must use the product's own encoder selection");
const h264MimeType = useH264Fallback ? "video/mp4;codecs=avc1,mp4a.40.2" : null;
const expectWebCodecsH264 = process.env.VITE_RECORDING_ENCODER === "webcodecs-h264";
const expectWebCodecs = expectWebCodecsH264 || process.env.SOAK_EXPECT_WEBCODECS === "1" || process.env.VITE_RECORDING_ENCODER === "webcodecs";
assert.ok(!expectWebCodecs || (!useVp8Fallback && !useH264Fallback), "Encoder comparisons require native MediaRecorder");
const encoderProfile = expectWebCodecsH264 ? "studio-webcodecs-h264"
  : expectWebCodecs ? "studio-webcodecs"
  : useVp8Fallback ? "vp8-fallback"
  : h264MimeType ? "h264-aac-fallback" : "studio-default";
const result = { qualification, requestedSeconds, cameraPreset: "720p", encoderProfile, startedAt: new Date().toISOString(), passed: false, reconnect: null, tracks: [], errors: [] };
await mkdir(path.join(artifactDir, "received"), { recursive: true });
const seatNames = ["Soak Host", "Soak Guest A", "Soak Guest B"];
const pages = [];
let harness;
let progressTimer;
const resultPath = path.join(artifactDir, "result.json");

async function saveResult() {
  const next = resultPath + ".tmp";
  await writeFile(next, JSON.stringify(result, null, 2));
  await rename(next, resultPath);
}

// Passive observers: preserve original recorder calls, timing and handlers.
function installObserver({ folder, useVp8Fallback, h264MimeType }) {
  // Exercise the real user-selectable preset, matching the short CI suite.
  // The program remains the production 1920x1080 compositor output.
  try { sessionStorage.setItem("preferredVideoQuality", "720p"); } catch { /* storage unavailable */ }
  const state = window.__soak = { recorders: [], channels: [], sockets: [], peers: new Map(), errors: [], transferSignals: [] };
  function attachRecorder(recorder, stream, pipeline) {
    const tracks = stream.getTracks();
    const row = {
      id: state.recorders.length,
      mimeType: recorder.mimeType,
      pipeline,
      kinds: tracks.map(track => track.kind),
      settings: tracks.map(track => {
        const { width, height, frameRate, sampleRate, channelCount } = track.getSettings();
        return { kind: track.kind, ...(track.kind === "video" ? { trackId: track.id } : {}), width, height, frameRate, sampleRate, channelCount };
      }),
      startRequested: null,
      started: null,
      firstChunkDispatchedAt: null,
      lastChunkDispatchedAt: null,
      stopRequested: null,
      stopped: null,
      chunks: 0,
      bytes: 0,
      peakHashQueueBytes: 0,
      largestChunkDispatchGapMs: 0,
      largestChunkDispatchGapStartedAtMs: null,
      flushed: false,
      chunkChecksums: [],
    };
    state.recorders.push(row);
    recorder.addEventListener("error", event => state.errors.push(`Recorder ${row.id}: ${event.error?.message || event.message || "error"}`));
    let hashing = Promise.resolve();
    let pendingHashBytes = 0;
    recorder.addEventListener("start", () => { row.started = performance.now(); });
    recorder.addEventListener("dataavailable", ({ data }) => {
      if (!data.size) return;
      row.chunks += 1;
      row.bytes += data.size;
      const at = performance.now();
      row.firstChunkDispatchedAt ??= at;
      if (row.lastChunkDispatchedAt !== null && at - row.lastChunkDispatchedAt > row.largestChunkDispatchGapMs) {
        row.largestChunkDispatchGapMs = at - row.lastChunkDispatchedAt;
        row.largestChunkDispatchGapStartedAtMs = row.lastChunkDispatchedAt;
      }
      row.lastChunkDispatchedAt = at;
      pendingHashBytes += data.size;
      row.peakHashQueueBytes = Math.max(row.peakHashQueueBytes, pendingHashBytes);
      // Only one original capture chunk per recorder is read at a time.
      // Native hashing avoids sending the media itself through Playwright.
      hashing = hashing.then(async () => {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await data.arrayBuffer()));
        const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
        row.chunkChecksums.push({ bytes: data.size, sha256 });
      }).catch(error => state.errors.push(String(error))).finally(() => { pendingHashBytes -= data.size; });
    });
    recorder.addEventListener("stop", () => {
      row.stopped = performance.now();
      void hashing.then(() => { row.flushed = true; });
    });

    const start = recorder.start;
    recorder.start = function (...args) {
      row.startRequested = performance.now();
      const program = row.settings.some(track => track.kind === "video" && track.width === 1920 && track.height === 1080);
      if (program) {
        const lastPaint = window.__captureResources?.programCanvases[0]?.lastFrameAtMs;
        row.programPaintAgeAtStartMs = typeof lastPaint === "number" ? row.startRequested - lastPaint : null;
      }
      return start.apply(this, args);
    };
    const stop = recorder.stop;
    recorder.stop = function (...args) {
      row.stopRequested = performance.now();
      return stop.apply(this, args);
    };
  }

  const nativeRecorder = window.MediaRecorder;
  window.MediaRecorder = class extends nativeRecorder {
    static isTypeSupported(mimeType) {
      if (useVp8Fallback && /\bvp9\b/i.test(mimeType)) return false;
      if (h264MimeType && mimeType.startsWith("video/") && mimeType !== h264MimeType) return false;
      return super.isTypeSupported(mimeType);
    }
    constructor(stream, ...args) {
      super(stream, ...args);
      attachRecorder(this, stream, "media-recorder");
    }
  };
  window.addEventListener("studio-recording-recorder", ({ detail: { recorder, stream } }) => {
    attachRecorder(recorder, stream, "webcodecs");
  });
  const nativeSocket = window.WebSocket;
  window.WebSocket = class extends nativeSocket {
    constructor(...args) {
      super(...args);
      state.sockets.push(this);
      this.addEventListener("message", event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "recording-transfer-signal") state.transferSignals.push({ kind: message.payload.kind, at: performance.now() });
        } catch { /* Only the signaling message type is observed. */ }
      });
    }
  };
  const nativePeer = window.RTCPeerConnection;
  function observeChannel(channel) {
    const row = { channel, label: channel.label, opened: null, closed: null, messages: 0, receivedBytes: 0, sentMediaBytes: 0, sentMediaFrames: 0, control: [] };
    state.channels.push(row);
    function noteControl(direction, data) {
      if (row.label !== "rec-transfer" || typeof data !== "string") return;
      try {
        const message = JSON.parse(data);
        if (message.t === "ping" || message.t === "pong") return;
        row.control.push({
          direction, kind: message.t, at: performance.now(), offset: message.offset,
          available: message.track?.available, trackCount: message.tracks?.length, ok: message.ok,
        });
        if (row.control.length > 40) row.control.shift();
      } catch { /* Only protocol state is recorded. */ }
    }
    const nativeSend = channel.send.bind(channel);
    channel.send = data => {
      nativeSend(data);
      if (typeof data !== "string") { row.sentMediaBytes += data.byteLength || data.size || 0; row.sentMediaFrames += 1; }
      else noteControl("sent", data);
    };
    channel.addEventListener("open", () => { row.opened = performance.now(); });
    channel.addEventListener("close", () => { row.closed = performance.now(); });
    channel.addEventListener("message", event => {
      row.messages += 1;
      row.receivedBytes += typeof event.data === "string" ? event.data.length : event.data.byteLength || event.data.size || 0;
      noteControl("received", event.data);
    });
  }
  let nextPeerId = 0;
  window.RTCPeerConnection = class extends nativePeer {
    constructor(...args) {
      super(...args);
      state.peers.set(this, nextPeerId++);
      this.addEventListener("datachannel", event => observeChannel(event.channel));
    }
    createDataChannel(...args) { const channel = super.createDataChannel(...args); observeChannel(channel); return channel; }
    close() {
      state.peers.delete(this);
      return super.close();
    }
  };
  if (folder) window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("soak-recording-folder", { create: true });
}

async function instrument(context, name, folder = false) {
  context.on("page", page => page.on("console", message => {
    if (["warning", "error"].includes(message.type()) && /recording|transfer|storage|folder/i.test(message.text())) {
      (result.consoleWarnings ||= []).push({ participant: name, type: message.type(), message: message.text() });
    }
  }));
  await context.addInitScript(installObserver, { folder, useVp8Fallback, h264MimeType });
  await context.addInitScript(observeCaptureResources);
}

async function folderFiles(page) {
  return page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("soak-recording-folder");
    const files = [];
    async function scan(directory, prefix = "") {
      for await (const [name, handle] of directory.entries()) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "directory") { if (!name.endsWith(".parts")) await scan(handle, relative); }
        else if (!name.endsWith(".crswap")) {
          const file = await handle.getFile();
          files.push({ path: relative, bytes: file.size, ...(name === "take-manifest.json" ? { manifest: JSON.parse(await file.text()) } : {}) });
        }
      }
    }
    await scan(root);
    return files;
  });
}

async function exportFile(page, relative) {
  assert.ok(!relative.split("/").some(part => part === ".." || !part), "safe recording path");
  const target = path.join(artifactDir, "received", relative);
  await mkdir(path.dirname(target), { recursive: true });
  // Let Chromium stream the disk-backed File directly. Only the path and URL
  // go over CDP. Node independently verifies the downloaded file's bytes.
  const downloaded = page.waitForEvent("download", { timeout: 30_000 });
  void downloaded.catch(() => {});
  const objectUrl = await page.evaluate(async relative => {
    let directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("soak-recording-folder");
    const parts = relative.split("/");
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    const file = await (await directory.getFileHandle(parts.at(-1))).getFile();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = file.name;
    link.click();
    return link.href;
  }, relative);
  try {
    await (await downloaded).saveAs(target);
  } finally {
    await page.evaluate(url => URL.revokeObjectURL(url), objectUrl).catch(() => {});
  }
  return target;
}

try {
  harness = await startHarness({ artifactDir, ...(process.env.SOAK_DIST_DIR ? { distDir: process.env.SOAK_DIST_DIR } : {}) });
  const hostContext = await harness.browser("soak-host");
  await instrument(hostContext, seatNames[0], true);
  const { page: host, studioId } = await createStudio(hostContext, { url: harness.url, name: "Three-seat recording soak", hostName: seatNames[0] });
  pages.push(host);
  if (h264MimeType) {
    const supported = await host.evaluate(mimeType => MediaRecorder.isTypeSupported(mimeType), h264MimeType);
    result.nativeH264Supported = supported;
    assert.ok(supported, "Chromium must natively support H.264 and AAC MediaRecorder");
  }
  for (const name of seatNames.slice(1)) {
    const context = await harness.browser(name.replaceAll(" ", "-"));
    await instrument(context, name);
    const guest = await joinStudio(context, { url: harness.url, studioId, name });
    pages.push(guest);
    await admitGuest(host, name);
    await stageGuest(host, name);
    await guest.getByRole("region", { name: "Broadcast canvas", exact: true })
      .getByRole("group", { name: `Video feed: ${name} (you)`, exact: true }).waitFor();
  }
  await host.getByRole("button", { name: "More tools", exact: true }).click();
  await host.getByRole("button", { name: "Recordings", exact: true }).click();
  await host.getByRole("button", { name: "Choose recording folder", exact: true }).click();
  await host.getByRole("region", { name: "Recording destination", exact: true })
    .getByRole("status").filter({ hasText: "soak-recording-folder" }).waitFor();
  await host.getByRole("button", { name: "Close recordings", exact: true }).click();
  await host.getByRole("button", { name: "Start recording", exact: true }).click();
  await host.getByRole("button", { name: "Stop recording", exact: true }).waitFor();
  // Readiness waits poll on a timer, not requestAnimationFrame: a GPU-less CI
  // host compositing the 1080p program can stop producing frames for long
  // periods, which starved rAF-polled checks (and Playwright click actionability)
  // while its recorders and JavaScript kept running. Assertions are unchanged.
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__soak.recorders.filter(row => row.started !== null && row.stopped === null).length >= 2, undefined, { timeout: 60_000, polling: 500 })));
  const captureStarted = Date.now();
  progressTimer = setInterval(() => console.log(JSON.stringify({ event: "recording-progress", elapsedSeconds: Math.round((Date.now() - captureStarted) / 1000), requestedSeconds })), 30_000);
  console.log(JSON.stringify({ event: "recording-started", qualification, requestedSeconds, artifactDir }));

  if (expectWebCodecs) {
    const captures = await host.waitForFunction(() => {
      const video = window.__soak.recorders.filter(row => row.kinds.includes("video") && row.started !== null);
      if (video.length !== 2 || video.some(row => row.chunks < 2 || row.stopped !== null)) return null;
      return video.map(({ mimeType, pipeline, chunks }) => ({ mimeType, pipeline, chunks }));
    }, undefined, { timeout: 15_000, polling: 500 });
    result.liveWebCodecsRecorders = await captures.jsonValue();
    await captures.dispose();
    assert.ok(result.liveWebCodecsRecorders.every(row => row.pipeline === "webcodecs"), "The host program and ISO must use the studio WebCodecs encoder");
    console.log(JSON.stringify({ event: "incremental-webcodecs-video-confirmed", tracks: result.liveWebCodecsRecorders }));
  }

  if (h264MimeType) {
    // Support alone is insufficient if the MP4 recorder buffers video until Stop.
    await Promise.all(pages.map((page, index) => page.waitForFunction(expectedCount => {
      const video = window.__soak.recorders.filter(row => row.kinds.includes("video") && row.started !== null);
      return video.length === expectedCount && video.every(row => row.chunks >= 2 && row.stopped === null);
    }, index === 0 ? 2 : 1, { timeout: 15_000, polling: 500 })));
    result.liveVideoFragments = await Promise.all(pages.map((page, index) => page.evaluate(participant => ({
      participant,
      recorders: window.__soak.recorders.filter(row => row.kinds.includes("video") && row.started !== null)
        .map(({ mimeType, chunks }) => ({ mimeType, chunks })),
    }), seatNames[index])));
    console.log(JSON.stringify({ event: "incremental-h264-video-confirmed", tracks: result.liveVideoFragments }));
  }

  const reconnectGuest = pages[1];
  await reconnectGuest.waitForFunction(seconds => window.__soak.recorders.some(row => row.started !== null && row.stopped === null && performance.now() - row.started >= seconds * 1000), Math.min(30, requestedSeconds / 3), { timeout: 60_000, polling: 500 });
  await reconnectGuest.waitForFunction(() => window.__soak.channels.some(row => row.label === "rec-transfer" && row.channel.readyState === "open" && row.sentMediaBytes > 0), undefined, { timeout: 60_000, polling: 500 });
  result.reconnect = await reconnectGuest.evaluate(() => {
    const state = window.__soak;
    const transfers = state.channels.filter(row => row.channel.readyState === "open" && row.label === "rec-transfer");
    if (!transfers.length) throw new Error("No open real recording data channel to interrupt");
    const sockets = state.sockets.filter(socket => socket.readyState === WebSocket.OPEN);
    if (!sockets.length) throw new Error("No open signaling socket to interrupt");
    const sentMediaBytesBefore = transfers.reduce((sum, row) => sum + row.sentMediaBytes, 0);
    if (!sentMediaBytesBefore) throw new Error("Reconnect must interrupt an active media transfer");
    const previousChannels = state.channels.length;
    for (const row of transfers) row.channel.close();
    for (const socket of sockets) socket.close(3001, "Synthetic soak reconnect");
    return { atSeconds: performance.now() / 1000, interruptedChannels: transfers.length, interruptedSockets: sockets.length, sentMediaBytesBefore, previousChannels };
  });
  result.reconnect.participant = seatNames[1];
  await reconnectGuest.waitForFunction(previous => window.__soak.channels.slice(previous).some(row => row.label === "rec-transfer" && row.channel.readyState === "open" && row.messages > 0 && row.sentMediaBytes > 0), result.reconnect.previousChannels, { timeout: 60_000, polling: 500 });
  result.reconnect.reconnected = true;
  result.reconnect.sentMediaBytesAfter = await reconnectGuest.evaluate(previous => window.__soak.channels.slice(previous).filter(row => row.label === "rec-transfer").reduce((sum, row) => sum + row.sentMediaBytes, 0), result.reconnect.previousChannels);
  console.log(JSON.stringify({ event: "guest-reconnected", reconnect: result.reconnect }));
  await saveResult();
  // This wait is the duration under test, not a sleep used to conceal readiness.
  await Promise.all(pages.map(page => page.waitForFunction(seconds => {
    const active = window.__soak.recorders.filter(row => row.started !== null && row.stopped === null);
    return active.length >= 2 && active.every(row => performance.now() - row.started >= seconds * 1000);
  }, requestedSeconds + 0.5, { timeout: (requestedSeconds + 120) * 1000, polling: 500 })));
  result.captureElapsedSeconds = (Date.now() - captureStarted) / 1000;
  console.log(JSON.stringify({ event: "stopping-recording", elapsedSeconds: result.captureElapsedSeconds }));
  await saveResult();
  // Poll on the same timer as recorder readiness. On a saturated host, a
  // visibility wait can stall even while the toolbar and capture stay active.
  await host.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Stop recording"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled || !button.getClientRects().length) return false;
    button.click();
    return true;
  }, undefined, { timeout: 60_000, polling: 500 });
  clearInterval(progressTimer);
  console.log(JSON.stringify({ event: "waiting-for-source-checksums" }));
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__soak.recorders.every(row => row.started === null || (row.stopped !== null && row.flushed)), undefined, { timeout: 120_000, polling: 500 })));
  const sourceCaptures = (await Promise.all(pages.map((page, index) => page.evaluate(name =>
    window.__soak.recorders.filter(row => row.chunks > 0).map(({ id, mimeType, pipeline, kinds, bytes, chunks, chunkChecksums }) => ({
      name, id, mimeType, pipeline, kinds, bytes, chunks, chunkChecksums,
    })), seatNames[index])))).flat();
  for (const source of sourceCaptures) {
    assert.equal(source.chunkChecksums.length, source.chunks, `${source.name} recorder ${source.id}: every chunk was hashed`);
    assert.equal(source.chunkChecksums.reduce((total, chunk) => total + chunk.bytes, 0), source.bytes);
  }
  result.sourceChecksums = sourceCaptures;
  await saveResult();
  console.log(JSON.stringify({ event: "source-checksums-ready", recorders: sourceCaptures.map(({ name, id, bytes, chunks }) => ({ name, id, bytes, chunks })) }));
  console.log(JSON.stringify({ event: "waiting-for-host-files" }));
  const files = await eventually(async () => {
    const files = await folderFiles(host);
    const manifest = files.find(file => file.manifest)?.manifest;
    return manifest?.tracks.length >= 7 && manifest.tracks.every(track => track.status === "complete" && track.startOffsetMs !== null
      && files.some(file => file.path === track.path && file.bytes === track.bytes)) ? files : null;
  }, { timeout: 180_000, interval: 1000, message: "All seven program/ISO/audio tracks and their capture timing must finish in the host folder" });
  const manifest = files.find(file => file.manifest).manifest;
  result.manifest = manifest;
  assert.equal(manifest.tracks.length, 7, "exactly seven original tracks survive reconnect");
  assert.equal(manifest.tracks.filter(track => track.origin === "program").length, 1, "one program mix is saved");
  for (const name of seatNames) {
    assert.ok(manifest.tracks.some(track => track.participantName === name && track.kind === "iso"), `${name} has an isolated camera/audio recording`);
    assert.ok(manifest.tracks.some(track => track.participantName === name && track.kind === "audio"), `${name} has an isolated microphone recording`);
  }
  assert.equal(manifest.tracks.filter(track => track.origin === "guest-transfer").length, 4, "both guests transfer their ISO and audio tracks");
  const diagnostics = await Promise.all(pages.map((page, index) => page.evaluate(participant => ({
    participant,
    recorders: window.__soak.recorders.map(({ chunkChecksums, ...row }) => row),
    channels: window.__soak.channels.map(({ channel, ...row }) => ({ ...row, state: channel.readyState })),
    transferSignals: window.__soak.transferSignals,
    errors: window.__soak.errors,
    resources: window.__captureResources,
  }), seatNames[index])));
  result.diagnostics = diagnostics;
  assert.ok(diagnostics[0].channels.filter(row => row.label === "rec-transfer").reduce((sum, row) => sum + row.receivedBytes, 0) > 1_000_000, "host received recording bytes through real RTC data channels");
  for (const { participant, errors } of diagnostics) {
    result.errors.push(...errors.map(error => `${participant} recording: ${error}`));
  }
  console.log(JSON.stringify({ event: "checking-recorded-packets", tracks: manifest.tracks.length }));
  for (const track of manifest.tracks) {
    assert.ok(track.bytes > 0, `${track.label} is non-empty`);
    assert.notEqual(track.startOffsetMs, null, `${track.label} has host-timeline start alignment`);
    const file = await exportFile(host, track.path);
    const name = track.origin === "program" ? seatNames[0] : track.participantName;
    const sources = sourceCaptures.filter(source => source.name === name && source.bytes === track.bytes);
    let matching;
    let digest;
    for (const source of sources) {
      digest = await verifyRecordingChunks(createReadStream(file, { highWaterMark: 256 * 1024 }), source.chunkChecksums);
      if (digest) {
        matching = source;
        break;
      }
    }
    assert.ok(matching, `${track.label} is byte-identical to its original recorder chunks`);
    // Capture runs an extra half second to allow endpoint packet quantization;
    // every encoded stream still must cover the full requested duration.
    const evidence = {
      ...track, file, sha256: digest,
      source: { participant: matching.name, recorder: matching.id, pipeline: matching.pipeline, bytes: matching.bytes },
    };
    if (expectWebCodecs && (track.origin === "program" || (track.origin === "host" && track.kind === "iso"))) {
      assert.equal(matching.pipeline, "webcodecs", `${track.label} must be captured with the studio WebCodecs encoder`);
    }
    try {
      const expectedVideoSize = track.origin === "program" ? { width: 1920, height: 1080 }
        : track.kind === "iso" ? { width: 1280, height: 720 } : undefined;
      evidence.metrics = await probeRecording(file, { minimumSeconds: requestedSeconds, expectedVideoSize });
      if (expectedVideoSize && (h264MimeType || expectWebCodecsH264 && matching.pipeline === "webcodecs")) {
        assert.equal(evidence.metrics.timelines.find(stream => stream.kind === "video")?.codec, "h264", "Encoded H.264 video");
        assert.equal(evidence.metrics.timelines.find(stream => stream.kind === "audio")?.codec, "aac", "Encoded AAC audio");
      }
      if (track.kind === "iso" || track.origin === "program") assert.notEqual(evidence.metrics.avDriftMs, null, `${track.label} contains both A/V streams`);
    } catch (error) {
      evidence.metricError = error.message;
      if (error.packetMetrics) evidence.metrics = error.packetMetrics;
      result.errors.push(`${track.label}: ${error.message}`);
    }
    result.tracks.push(evidence);
    await saveResult();
  }
  for (const [width, height] of [[1000, 625], [1440, 900], [390, 844]]) {
    await host.setViewportSize({ width, height });
    await screenshot(host, artifactDir, `soak-complete-${width}`);
  }
  assert.deepEqual(harness.pageErrors, [], "no browser application errors during soak");
  assert.deepEqual(harness.cspViolations, [], "no CSP violations during soak");
  assert.equal(result.errors.length, 0, "Every recorder and track must pass capture and packet integrity checks; see per-track evidence");
  result.passed = true;
  result.completedAt = new Date().toISOString();
  console.log(JSON.stringify({ event: "recording-soak-complete", qualification, tracks: result.tracks.length, artifactDir }));
} catch (error) {
  clearInterval(progressTimer);
  result.errors.push(error.stack || String(error));
  console.error(error);
  process.exitCode = 1;
  await saveResult();
  if (pages[0]) result.failureFolder = await folderFiles(pages[0]).catch(failure => ({ error: String(failure) }));
  result.failureDiagnostics = await Promise.all(pages.map((page, index) => page.evaluate(participant => ({
    participant,
    recorders: window.__soak?.recorders.map(({ chunkChecksums, ...row }) => row),
    errors: window.__soak?.errors,
    channels: window.__soak?.channels.map(({ channel, ...row }) => ({ ...row, state: channel.readyState })),
    transferSignals: window.__soak?.transferSignals,
    resources: window.__captureResources,
  }), seatNames[index]).catch(failure => ({ participant: seatNames[index], error: String(failure) }))));
  await saveResult();
  await Promise.allSettled(pages.map((page, index) => screenshot(page, artifactDir, `failure-${index}`)));
} finally {
  clearInterval(progressTimer);
  await saveResult();
  await harness?.close();
}
