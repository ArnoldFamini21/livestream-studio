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
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { startHarness, createStudio, joinStudio, admitGuest, stageGuest, eventually, screenshot, repoRoot } from "./harness.mjs";
import { probeRecording } from "./recording-metrics.mjs";

const requestedSeconds = Number(process.env.SOAK_SECONDS || 1200);
assert.ok(Number.isFinite(requestedSeconds) && requestedSeconds >= 15, "SOAK_SECONDS must be at least 15 seconds");
const artifactDir = path.resolve(process.env.SOAK_ARTIFACT_DIR || path.join(repoRoot, "output/recording-soak", new Date().toISOString().replaceAll(":", "-")));
const qualification = requestedSeconds >= 1200;
const result = { qualification, requestedSeconds, cameraPreset: "720p", startedAt: new Date().toISOString(), passed: false, reconnect: null, tracks: [], errors: [] };
await mkdir(path.join(artifactDir, "received"), { recursive: true });
const sourceCaptures = new Map();
const pages = [];
let harness;
let progressTimer;

// Passive observers: preserve original recorder calls, timing and handlers.
function installObserver({ folder }) {
  // Exercise the real user-selectable preset, matching the short CI suite.
  // The program remains the production 1920x1080 compositor output.
  try { sessionStorage.setItem("preferredVideoQuality", "720p"); } catch { /* storage unavailable */ }
  const state = window.__soak = { recorders: [], channels: [], sockets: [], errors: [], transferSignals: [] };
  const nativeRecorder = window.MediaRecorder;
  window.MediaRecorder = class extends nativeRecorder {
    constructor(...args) {
      super(...args);
      const row = { id: state.recorders.length, mimeType: this.mimeType, kinds: args[0].getTracks().map(track => track.kind), settings: args[0].getTracks().map(track => { const { width, height, frameRate, sampleRate, channelCount } = track.getSettings(); return { kind: track.kind, width, height, frameRate, sampleRate, channelCount }; }), started: null, stopped: null, chunks: 0, bytes: 0, flushed: false };
      state.recorders.push(row);
      this.addEventListener("error", event => state.errors.push(`Recorder ${row.id}: ${event.error?.message || "error"}`));
      let writes = Promise.resolve();
      this.addEventListener("start", () => { row.started = performance.now(); });
      this.addEventListener("dataavailable", event => {
        if (!event.data.size) return;
        row.chunks += 1;
        row.bytes += event.data.size;
        writes = writes.then(async () => {
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          await window.__hashSourceChunk({ id: row.id, mimeType: row.mimeType, kinds: row.kinds, base64: btoa(binary) });
        }).catch(error => state.errors.push(String(error)));
      });
      this.addEventListener("stop", () => {
        row.stopped = performance.now();
        void writes.then(() => { row.flushed = true; });
      });
    }
  };
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
    const row = { channel, label: channel.label, opened: null, closed: null, messages: 0, receivedBytes: 0, sentMediaBytes: 0, sentMediaFrames: 0 };
    state.channels.push(row);
    const nativeSend = channel.send.bind(channel);
    channel.send = data => {
      nativeSend(data);
      if (typeof data !== "string") { row.sentMediaBytes += data.byteLength || data.size || 0; row.sentMediaFrames += 1; }
    };
    channel.addEventListener("open", () => { row.opened = performance.now(); });
    channel.addEventListener("close", () => { row.closed = performance.now(); });
    channel.addEventListener("message", event => { row.messages += 1; row.receivedBytes += typeof event.data === "string" ? event.data.length : event.data.byteLength || event.data.size || 0; });
  }
  window.RTCPeerConnection = class extends nativePeer {
    constructor(...args) { super(...args); this.addEventListener("datachannel", event => observeChannel(event.channel)); }
    createDataChannel(...args) { const channel = super.createDataChannel(...args); observeChannel(channel); return channel; }
  };
  if (folder) window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("soak-recording-folder", { create: true });
}

async function instrument(context, name, folder = false) {
  context.on("page", page => page.on("console", message => {
    if (["warning", "error"].includes(message.type()) && /recording|transfer|storage|folder/i.test(message.text())) {
      (result.consoleWarnings ||= []).push({ participant: name, type: message.type(), message: message.text() });
    }
  }));
  await context.exposeBinding("__hashSourceChunk", async (_source, { id, mimeType, kinds, base64 }) => {
    assert.ok(Number.isInteger(id) && id >= 0 && id < 100, "bounded recorder id");
    const key = `${name}-${id}`;
    let entry = sourceCaptures.get(key);
    if (!entry) {
      // Hash in order without an extra disk copy competing with OPFS capture.
      entry = { name, id, mimeType, kinds, hash: createHash("sha256"), bytes: 0 };
      sourceCaptures.set(key, entry);
    }
    const bytes = Buffer.from(base64, "base64");
    entry.hash.update(bytes);
    entry.bytes += bytes.length;
  });
  await context.addInitScript(installObserver, { folder });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function folderFiles(page) {
  return page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("soak-recording-folder");
    const files = [];
    async function scan(directory, prefix = "") {
      for await (const [name, handle] of directory.entries()) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "directory") { if (!name.endsWith(".parts")) await scan(handle, relative); }
        else { const file = await handle.getFile(); files.push({ path: relative, bytes: file.size, ...(name === "take-manifest.json" ? { manifest: JSON.parse(await file.text()) } : {}) }); }
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
  await writeFile(target, Buffer.alloc(0));
  // Bounded chunks avoid loading a twenty-minute recording into Node or CDP.
  let offset = 0;
  for (;;) {
    const chunk = await page.evaluate(async ({ relative, offset }) => {
      let directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("soak-recording-folder");
      const parts = relative.split("/");
      for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
      const file = await (await directory.getFileHandle(parts.at(-1))).getFile();
      const bytes = new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      return { base64: btoa(binary), total: file.size };
    }, { relative, offset });
    const bytes = Buffer.from(chunk.base64, "base64");
    await appendFile(target, bytes);
    offset += bytes.length;
    if (offset >= chunk.total) break;
    assert.ok(bytes.length, "export advances through the recording");
  }
  return target;
}

try {
  harness = await startHarness({ artifactDir, ...(process.env.SOAK_DIST_DIR ? { distDir: process.env.SOAK_DIST_DIR } : {}) });
  const hostContext = await harness.browser("soak-host");
  await instrument(hostContext, "Soak Host", true);
  const { page: host, studioId } = await createStudio(hostContext, { url: harness.url, name: "Three-seat recording soak", hostName: "Soak Host" });
  pages.push(host);
  for (const name of ["Soak Guest A", "Soak Guest B"]) {
    const context = await harness.browser(name.replaceAll(" ", "-"));
    await instrument(context, name);
    const guest = await joinStudio(context, { url: harness.url, studioId, name });
    pages.push(guest);
    await admitGuest(host, name);
    await stageGuest(host, name);
  }
  await host.getByRole("button", { name: "More tools", exact: true }).click();
  await host.getByRole("button", { name: "Recordings", exact: true }).click();
  await host.getByRole("button", { name: "Choose recording folder", exact: true }).click();
  await host.getByRole("region", { name: "Recording destination", exact: true }).getByText("Recording straight to", { exact: false }).waitFor();
  await host.getByRole("button", { name: "Close recordings", exact: true }).click();
  await host.getByRole("button", { name: "Start recording", exact: true }).click();
  await host.getByRole("button", { name: "Stop recording", exact: true }).waitFor();
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__soak.recorders.filter(row => row.started !== null && row.stopped === null).length >= 2)));
  const captureStarted = Date.now();
  progressTimer = setInterval(() => console.log(JSON.stringify({ event: "recording-progress", elapsedSeconds: Math.round((Date.now() - captureStarted) / 1000), requestedSeconds })), 30_000);
  console.log(JSON.stringify({ event: "recording-started", qualification, requestedSeconds, artifactDir }));

  const reconnectGuest = pages[1];
  await reconnectGuest.waitForFunction(seconds => window.__soak.recorders.some(row => row.started !== null && row.stopped === null && performance.now() - row.started >= seconds * 1000), Math.min(30, requestedSeconds / 3), { timeout: 60_000 });
  await reconnectGuest.waitForFunction(() => window.__soak.channels.some(row => row.label === "rec-transfer" && row.channel.readyState === "open" && row.sentMediaBytes > 0), undefined, { timeout: 60_000 });
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
  await reconnectGuest.waitForFunction(previous => window.__soak.channels.slice(previous).some(row => row.label === "rec-transfer" && row.channel.readyState === "open" && row.messages > 0 && row.sentMediaBytes > 0), result.reconnect.previousChannels, { timeout: 60_000 });
  result.reconnect.reconnected = true;
  result.reconnect.sentMediaBytesAfter = await reconnectGuest.evaluate(previous => window.__soak.channels.slice(previous).filter(row => row.label === "rec-transfer").reduce((sum, row) => sum + row.sentMediaBytes, 0), result.reconnect.previousChannels);
  console.log(JSON.stringify({ event: "guest-reconnected", reconnect: result.reconnect }));
  // This wait is the duration under test, not a sleep used to conceal readiness.
  await Promise.all(pages.map(page => page.waitForFunction(seconds => {
    const active = window.__soak.recorders.filter(row => row.started !== null && row.stopped === null);
    return active.length >= 2 && active.every(row => performance.now() - row.started >= seconds * 1000);
  }, requestedSeconds + 0.5, { timeout: (requestedSeconds + 120) * 1000, polling: 500 })));
  console.log(JSON.stringify({ event: "stopping-recording", elapsedSeconds: (Date.now() - captureStarted) / 1000 }));
  await host.getByRole("button", { name: "Stop recording", exact: true }).click();
  clearInterval(progressTimer);
  console.log(JSON.stringify({ event: "waiting-for-source-checksums" }));
  await Promise.all(pages.map(page => page.waitForFunction(() => window.__soak.recorders.every(row => row.started === null || (row.stopped !== null && row.flushed)), undefined, { timeout: 120_000 })));
  console.log(JSON.stringify({ event: "waiting-for-host-files" }));
  const files = await eventually(async () => {
    const files = await folderFiles(host);
    const manifest = files.find(file => file.manifest)?.manifest;
    return manifest?.tracks.length >= 7 && manifest.tracks.every(track => track.status === "complete") && files.filter(file => !file.manifest).length >= 7 ? files : null;
  }, { timeout: 180_000, interval: 1000, message: "All seven program/ISO/audio tracks must finish in the host folder" });
  const manifest = files.find(file => file.manifest).manifest;
  result.manifest = manifest;
  for (const name of ["Soak Host", "Soak Guest A", "Soak Guest B"]) {
    assert.ok(manifest.tracks.some(track => track.participantName === name && track.kind === "iso"), `${name} has an isolated camera/audio recording`);
    assert.ok(manifest.tracks.some(track => track.participantName === name && track.kind === "audio"), `${name} has an isolated microphone recording`);
  }
  assert.equal(manifest.tracks.filter(track => track.origin === "guest-transfer").length, 4, "both guests transfer their ISO and audio tracks");
  const diagnostics = await Promise.all(pages.map(page => page.evaluate(() => ({
    recorders: window.__soak.recorders,
    channels: window.__soak.channels.map(({ channel, ...row }) => ({ ...row, state: channel.readyState })),
    transferSignals: window.__soak.transferSignals,
    errors: window.__soak.errors,
  }))));
  result.diagnostics = diagnostics;
  assert.ok(diagnostics[0].channels.filter(row => row.label === "rec-transfer").reduce((sum, row) => sum + row.receivedBytes, 0) > 1_000_000, "host received recording bytes through real RTC data channels");
  assert.deepEqual(diagnostics.flatMap(item => item.errors), [], "passive source checksum capture succeeded");
  for (const source of sourceCaptures.values()) { source.sha256 = source.hash.digest("hex"); delete source.hash; }
  result.sourceChecksums = [...sourceCaptures.values()];
  console.log(JSON.stringify({ event: "checking-recorded-packets", tracks: manifest.tracks.length }));
  for (const track of manifest.tracks) {
    assert.ok(track.bytes > 0, `${track.label} is non-empty`);
    assert.notEqual(track.startOffsetMs, null, `${track.label} has host-timeline start alignment`);
    const file = await exportFile(host, track.path);
    const digest = await sha256(file);
    const sources = [...sourceCaptures.values()].filter(source => source.name === (track.origin === "program" ? "Soak Host" : track.participantName));
    const matching = sources.find(source => source.sha256 === digest && source.bytes === track.bytes);
    assert.ok(matching, `${track.label} is byte-identical to its original MediaRecorder chunks`);
    // Capture runs an extra half second to allow endpoint packet quantization;
    // every encoded stream still must cover the full requested duration.
    const evidence = { ...track, file, sha256: digest, source: { participant: matching.name, recorder: matching.id, bytes: matching.bytes } };
    try {
      evidence.metrics = await probeRecording(file, { minimumSeconds: requestedSeconds });
      if (track.kind === "iso" || track.origin === "program") assert.notEqual(evidence.metrics.avDriftMs, null, `${track.label} contains both A/V streams`);
    } catch (error) {
      evidence.metricError = error.message;
      result.errors.push(`${track.label}: ${error.message}`);
    }
    result.tracks.push(evidence);
  }
  for (const [width, height] of [[1000, 625], [1440, 900], [390, 844]]) {
    await host.setViewportSize({ width, height });
    await screenshot(host, artifactDir, `soak-complete-${width}`);
  }
  assert.deepEqual(harness.pageErrors, [], "no browser application errors during soak");
  assert.deepEqual(harness.cspViolations, [], "no CSP violations during soak");
  assert.equal(result.errors.length, 0, "Every track must pass packet integrity checks; see per-track evidence");
  result.passed = true;
  result.completedAt = new Date().toISOString();
  console.log(JSON.stringify({ event: "recording-soak-complete", qualification, tracks: result.tracks.length, artifactDir }));
} catch (error) {
  result.errors.push(error.stack || String(error));
  if (pages[0]) result.failureFolder = await folderFiles(pages[0]).catch(failure => ({ error: String(failure) }));
  result.failureDiagnostics = await Promise.all(pages.map(page => page.evaluate(() => ({
    recorders: window.__soak?.recorders,
    errors: window.__soak?.errors,
    channels: window.__soak?.channels.map(({ channel, ...row }) => ({ ...row, state: channel.readyState })),
    transferSignals: window.__soak?.transferSignals,
  })).catch(failure => ({ error: String(failure) }))));
  console.error(error);
  process.exitCode = 1;
  await Promise.allSettled(pages.map((page, index) => screenshot(page, artifactDir, `failure-${index}`)));
} finally {
  clearInterval(progressTimer);
  await writeFile(path.join(artifactDir, "result.json"), JSON.stringify(result, null, 2));
  await harness?.close();
}
