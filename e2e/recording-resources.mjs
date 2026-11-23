/** Browser-side counters only. Sampling does not change the compositor, encoder, or write cadence. */
export function observeCaptureResources() {
  const state = window.__captureResources = {
    timeOrigin: performance.timeOrigin,
    longTasks: { count: 0, totalMs: 0, longest: [] },
    programCanvases: [],
    cameraFrames: { intervalMs: 1000, maxSamples: 1300, busyPolls: 0, samples: [] },
    writes: { count: 0, pending: 0, peakPending: 0, pendingBytes: 0, peakPendingBytes: 0, longestWriteMs: 0, longestCloseMs: 0, longest: [] },
  };
  if (window.PerformanceObserver?.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver(list => {
      for (const { startTime, duration } of list.getEntries()) {
        state.longTasks.count++;
        state.longTasks.totalMs += duration;
        const longest = state.longTasks.longest;
        if (longest.length < 20 || duration > longest.at(-1).durationMs) {
          longest.push({ startedMs: startTime, durationMs: duration });
          longest.sort((a, b) => b.durationMs - a.durationMs);
          if (longest.length > 20) longest.pop();
        }
      }
    }).observe({ type: "longtask", buffered: true });
  }

  // Sample only the live 720p ISO input and use at most one stats request
  // per seat per interval. The track id excludes the separate program canvas.
  const camera = state.cameraFrames;
  const isCameraInput = track => track.kind === "video" && track.width === 1280 && track.height === 720;
  let reading = false;
  setInterval(async () => {
    const soak = window.__soak;
    const recorder = soak?.recorders.find(row => row.startRequested !== null && row.stopRequested === null
      && row.stopped === null && row.settings.some(isCameraInput));
    if (!recorder || camera.samples.length >= camera.maxSamples) return;
    if (reading) {
      camera.busyPolls++;
      return;
    }
    const trackId = recorder.settings.find(isCameraInput).trackId;
    const sample = { requestedAtMs: performance.now(), recorderId: recorder.id, trackId, status: "no-sender" };
    reading = true;
    try {
      for (const [peer, peerId] of soak.peers) {
        if (peer.connectionState !== "connected") continue;
        const sender = peer.getSenders().find(candidate => candidate.track?.id === trackId);
        if (!sender) continue;
        sample.peerId = peerId;
        const stats = await sender.getStats();
        sample.status = "no-counter";
        for (const source of stats.values()) {
          if (source.type !== "media-source" || source.kind !== "video" || source.trackIdentifier !== trackId || !Number.isFinite(source.frames)) continue;
          Object.assign(sample, {
            status: "ok",
            sourceId: source.id,
            sourceTimestampMs: source.timestamp,
            frames: source.frames,
            framesPerSecond: source.framesPerSecond,
            width: source.width,
            height: source.height,
          });
          break;
        }
        break;
      }
    } catch {
      sample.status = "stats-error";
    } finally {
      sample.receivedAtMs = performance.now();
      camera.samples.push(sample);
      reading = false;
    }
  }, camera.intervalMs);

  const canvases = new WeakMap();
  const canvas = window.HTMLCanvasElement.prototype;
  const captureStream = canvas.captureStream;
  canvas.captureStream = function (...args) {
    const result = captureStream.apply(this, args);
    if (this.width * this.height >= 1920 * 1080 && !canvases.has(this)) {
      const metrics = { width: this.width, height: this.height, frames: 0, lastFrameAtMs: null,
        longestFrameGapMs: 0, longestFrameGapAtMs: null, drawCalls: 0, drawTotalMs: 0, longestDrawMs: 0 };
      state.programCanvases.push(metrics);
      canvases.set(this, metrics);
    }
    return result;
  };
  const context = window.CanvasRenderingContext2D.prototype;
  const fillRect = context.fillRect;
  context.fillRect = function (x, y, width, height) {
    const metrics = canvases.get(this.canvas);
    if (metrics && x === 0 && y === 0 && width === this.canvas.width && height === this.canvas.height) {
      const now = performance.now();
      if (metrics.lastFrameAtMs !== null && now - metrics.lastFrameAtMs > metrics.longestFrameGapMs) {
        metrics.longestFrameGapMs = now - metrics.lastFrameAtMs;
        metrics.longestFrameGapAtMs = metrics.lastFrameAtMs;
      }
      metrics.lastFrameAtMs = now;
      metrics.frames++;
    }
    return fillRect.call(this, x, y, width, height);
  };
  const drawImage = context.drawImage;
  context.drawImage = function (...args) {
    const metrics = canvases.get(this.canvas);
    if (!metrics) return drawImage.apply(this, args);
    const before = performance.now();
    try { return drawImage.apply(this, args); }
    finally {
      const spent = performance.now() - before;
      metrics.drawCalls++;
      metrics.drawTotalMs += spent;
      metrics.longestDrawMs = Math.max(metrics.longestDrawMs, spent);
    }
  };

  const writable = window.FileSystemWritableFileStream?.prototype;
  if (!writable) return;
  function observeOperation(operation, longestKey) {
    const original = writable[operation];
    writable[operation] = function (...args) {
      const before = performance.now();
      const result = original.apply(this, args);
      const data = args[0]?.data ?? args[0];
      const bytes = data?.size ?? data?.byteLength ?? 0;
      const writes = state.writes;
      writes.count++;
      writes.pending++;
      writes.pendingBytes += bytes;
      writes.peakPending = Math.max(writes.peakPending, writes.pending);
      writes.peakPendingBytes = Math.max(writes.peakPendingBytes, writes.pendingBytes);
      function settle() {
        writes.pending--;
        writes.pendingBytes -= bytes;
        const endedMs = performance.now();
        const durationMs = endedMs - before;
        writes[longestKey] = Math.max(writes[longestKey], durationMs);
        // Keep the slowest operations and their actual time windows for correlation
        // with recorder start/stop and packet gaps, without saving every write.
        const longest = writes.longest;
        if (longest.length < 20 || durationMs > longest.at(-1).durationMs) {
          longest.push({ operation, bytes, startedMs: before, endedMs, durationMs });
          longest.sort((a, b) => b.durationMs - a.durationMs);
          if (longest.length > 20) longest.pop();
        }
      }
      void result.then(settle, settle);
      return result;
    };
  }
  observeOperation("write", "longestWriteMs");
  observeOperation("close", "longestCloseMs");
}
