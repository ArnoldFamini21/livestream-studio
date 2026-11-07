import {
  acceptDataFrame,
  applyResume,
  base64ToBytes,
  bytesToBase64,
  createLaneReceiveState,
  createLaneSendState,
  decodeDataFrame,
  encodeDataFrame,
  getFramePayloadBytes,
  nextSendRange,
  parseControlMessage,
  RECORDING_TRANSFER_PROTOCOL_VERSION,
  serializeControlMessage,
  transferPercent,
  type LaneReceiveState,
  type LaneSendState,
  type TransferControlMessage,
  type TransferTrackAnnouncement,
} from './recordingTransferProtocol.ts';
import { estimateClockOffset, timelineNow, type ClockSample } from './recordingTakeManifest.ts';
import {
  DEFAULT_TRANSFER_LIMITS,
  trackAdmissionError,
  type TransferLimits,
} from './recordingTransferPolicy.ts';

/** The subset of RTCDataChannel the transfer uses (fakes implement it in tests). */
export interface TransferChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType?: string;
  send(data: string | ArrayBuffer): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'open' | 'close' | 'bufferedamountlow' | 'error', listener: () => void): void;
  removeEventListener(type: string, listener: (...args: never[]) => void): void;
  close(): void;
}

export const TRANSFER_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const TRANSFER_LOW_WATER_BYTES = 1024 * 1024;
/** Unacknowledged bytes allowed in flight, so a slow host disk bounds memory. */
export const TRANSFER_WINDOW_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Guest side
// ---------------------------------------------------------------------------

export interface TransferSourceTrack {
  id: string;
  sessionId: string;
  label: string;
  kind: string;
  mimeType: string;
  lossless?: boolean;
  /** Committed bytes so far; must always be a prefix of the final file. */
  read(): Promise<Blob>;
  /** Present once the track has stopped recording. */
  finished?: { totalBytes: number; header?: Uint8Array; capture?: unknown };
}

export interface TransferSenderProgress {
  tracks: Array<{ id: string; label: string; sent: number; acked: number; available: number; delivered: boolean }>;
  deliveredAll: boolean;
}

export interface TransferSenderOptions {
  channel: TransferChannel;
  participantName: string;
  getTracks: () => TransferSourceTrack[];
  onDelivered?: (trackId: string, path?: string) => void;
  onFailed?: (trackId: string, error: string) => void;
  onProgress?: (progress: TransferSenderProgress) => void;
  /** Re-check tracks for new bytes this often while idle. */
  pollMs?: number;
  now?: () => number;
}

interface SenderLane {
  track: TransferSourceTrack;
  state: LaneSendState;
  cached: Blob | null;
  announcedAvailable: number;
  announcedAt: number;
  endSent: boolean;
  delivered: boolean;
  failed: boolean;
}

export interface TransferSender {
  /** Call when tracks are added, grow or finish; also runs on a timer. */
  refresh(): void;
  close(): void;
  progress(): TransferSenderProgress;
}

export function createTransferSender(options: TransferSenderOptions): TransferSender {
  const { channel } = options;
  const now = options.now ?? timelineNow;
  const lanes = new Map<string, SenderLane>();
  const byLane = new Map<number, SenderLane>();
  let nextLane = 0;
  let pumping = false;
  let pumpAgain = false;
  let closed = false;
  let helloSent = false;
  const maxPayload = () => getFramePayloadBytes((channel as { maxMessageSize?: number }).maxMessageSize);

  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = TRANSFER_LOW_WATER_BYTES;

  const sendControl = (message: TransferControlMessage) => {
    if (channel.readyState === 'open') channel.send(serializeControlMessage(message));
  };

  const announcement = async (lane: SenderLane): Promise<TransferTrackAnnouncement> => {
    const available = (await lane.track.read()).size;
    lane.announcedAvailable = available;
    lane.announcedAt = now();
    const finished = lane.track.finished;
    return {
      id: lane.track.id,
      lane: lane.state.lane,
      sessionId: lane.track.sessionId,
      label: lane.track.label,
      kind: lane.track.kind,
      mimeType: lane.track.mimeType,
      available,
      ...(finished ? { totalBytes: finished.totalBytes } : {}),
      ...(finished?.header ? { header: bytesToBase64(finished.header) } : {}),
      ...(finished?.capture ? { capture: finished.capture } : {}),
      ...(lane.track.lossless ? { lossless: true } : {}),
    };
  };

  const progress = (): TransferSenderProgress => {
    const tracks = [...lanes.values()].map((lane) => ({
      id: lane.track.id,
      label: lane.track.label,
      sent: lane.state.sent,
      acked: lane.state.acked,
      available: Math.max(lane.announcedAvailable, lane.track.finished?.totalBytes ?? 0),
      delivered: lane.delivered,
    }));
    return { tracks, deliveredAll: tracks.length > 0 && tracks.every((track) => track.delivered) };
  };
  const report = () => { try { options.onProgress?.(progress()); } catch { /* Observers must not stop the transfer. */ } };

  const syncTracks = async () => {
    const fresh: SenderLane[] = [];
    for (const track of options.getTracks()) {
      const existing = lanes.get(track.id);
      if (existing) { existing.track = track; continue; }
      const lane: SenderLane = {
        track, state: createLaneSendState(nextLane++), cached: null,
        announcedAvailable: 0, announcedAt: 0, endSent: false, delivered: false, failed: false,
      };
      lanes.set(track.id, lane);
      byLane.set(lane.state.lane, lane);
      fresh.push(lane);
    }
    if (!helloSent) {
      helloSent = true;
      const tracks = await Promise.all([...lanes.values()].map(announcement));
      sendControl({ t: 'hello', v: RECORDING_TRANSFER_PROTOCOL_VERSION, participantName: options.participantName, tracks });
      return;
    }
    for (const lane of fresh) sendControl({ t: 'track', track: await announcement(lane) });
    // Keep the host's "recorded so far" figure current for its progress bar.
    for (const lane of lanes.values()) {
      if (fresh.includes(lane) || lane.delivered || lane.failed) continue;
      if (now() - lane.announcedAt >= 2_000 || (lane.track.finished && !lane.endSent && lane.announcedAvailable !== lane.track.finished.totalBytes)) {
        sendControl({ t: 'track', track: await announcement(lane) });
      }
    }
  };

  const pump = async () => {
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        if (closed || channel.readyState !== 'open') return;
        await syncTracks();
        let progressed = true;
        while (progressed && !closed && channel.readyState === 'open') {
          progressed = false;
          for (const lane of lanes.values()) {
            if (channel.bufferedAmount >= TRANSFER_HIGH_WATER_BYTES) return;
            if (lane.delivered || lane.failed || !lane.state.started) continue;
            if (lane.state.sent - lane.state.acked >= TRANSFER_WINDOW_BYTES) continue;
            if (!lane.cached || lane.state.sent >= lane.cached.size) lane.cached = await lane.track.read();
            const range = nextSendRange(lane.state, lane.cached.size, maxPayload());
            if (range) {
              const epoch = lane.state.epoch;
              const payload = await lane.cached.slice(range.start, range.end).arrayBuffer();
              // A resume may have arrived while reading: drop this stale slice.
              if (epoch !== lane.state.epoch || lane.state.sent !== range.start || closed || channel.readyState !== 'open') { progressed = true; continue; }
              channel.send(encodeDataFrame({ lane: lane.state.lane, epoch, seq: lane.state.seq++, offset: range.start, payload }));
              lane.state.sent = range.end;
              progressed = true;
              continue;
            }
            const finished = lane.track.finished;
            if (finished && !lane.endSent && lane.state.sent >= finished.totalBytes) {
              lane.endSent = true;
              sendControl({
                t: 'end', id: lane.track.id, totalBytes: finished.totalBytes,
                ...(finished.header ? { header: bytesToBase64(finished.header) } : {}),
                ...(finished.capture ? { capture: finished.capture } : {}),
              });
            }
          }
        }
      } while (pumpAgain);
    } catch (error) {
      console.warn('Recording transfer paused:', error);
    } finally {
      pumping = false;
      report();
    }
  };

  const onMessage = (event: { data: unknown }) => {
    if (typeof event.data !== 'string') return;
    const message = parseControlMessage(event.data);
    if (!message) return;
    const lane = 'id' in message ? lanes.get(message.id) : undefined;
    switch (message.t) {
      case 'resume':
        if (!lane) return;
        applyResume(lane.state, message.offset, Number.MAX_SAFE_INTEGER);
        lane.endSent = false;
        lane.failed = false;
        lane.cached = null;
        void pump();
        return;
      case 'ack':
        if (lane) lane.state.acked = Math.max(lane.state.acked, Math.min(message.offset, lane.state.sent));
        void pump();
        return;
      case 'done':
        if (!lane) return;
        if (message.ok) {
          lane.delivered = true;
          try { options.onDelivered?.(lane.track.id, message.path); } catch { /* Observer errors stay local. */ }
        } else {
          // The guest keeps its browser copy; the host can ask again later.
          lane.failed = true;
          try { options.onFailed?.(lane.track.id, message.error || 'The host could not save this track.'); } catch { /* Observer errors stay local. */ }
        }
        report();
        return;
      case 'ping':
        sendControl({ t: 'pong', n: message.n, t0: message.t0, t1: now() });
        return;
      default:
        return;
    }
  };

  const onLow = () => { void pump(); };
  const onOpen = () => { void pump(); };
  channel.addEventListener('message', onMessage);
  channel.addEventListener('bufferedamountlow', onLow);
  channel.addEventListener('open', onOpen);
  const timer = setInterval(() => { void pump(); }, options.pollMs ?? 1_000);
  if (channel.readyState === 'open') void pump();

  return {
    refresh: () => { void pump(); },
    progress,
    close() {
      closed = true;
      clearInterval(timer);
      channel.removeEventListener('message', onMessage);
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('open', onOpen);
    },
  };
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

/** Where one received track is written (the host's recording folder). */
export interface ReceivedTrackSink {
  write(bytes: Uint8Array): Promise<void>;
  /** Bytes the sink has accepted so far. */
  accepted(): number;
  finish(options: { header?: Uint8Array; totalBytes: number }): Promise<{ bytes: number; path: string; file?: Blob }>;
}

export type ReceivedTrackStatus = 'receiving' | 'complete' | 'failed';

export interface ReceivedTrackEntry {
  id: string;
  participantId: string;
  participantName: string;
  announcement: TransferTrackAnnouncement;
  received: number;
  available: number;
  totalBytes?: number;
  status: ReceivedTrackStatus;
  path?: string;
  /** The saved file (disk-backed) once complete. */
  file?: Blob;
  error?: string;
  capture?: unknown;
  sink: Promise<ReceivedTrackSink>;
  writes: Promise<void>;
  finishing?: Promise<void>;
  /** Refused for good (over the participant's size cap): never reopened. */
  blocked?: boolean;
}

export interface ParticipantTransferSummary {
  participantId: string;
  participantName: string;
  received: number;
  available: number;
  percent: number;
  tracks: number;
  completeTracks: number;
  failedTracks: number;
  connected: boolean;
  clockOffsetMs?: number;
}

/**
 * Received tracks outlive individual connections, so a guest that
 * reconnects (or reloads and resends from its browser backup) resumes
 * exactly where the host's file ends.
 */
export class HostTransferRegistry {
  readonly tracks = new Map<string, ReceivedTrackEntry>();
  private readonly connected = new Map<string, number>();
  private readonly clockOffsets = new Map<string, number>();
  private readonly names = new Map<string, string>();
  private readonly writtenBytes = new Map<string, number>();
  private listeners = new Set<() => void>();

  constructor(private readonly openSink: (input: {
    participantId: string;
    participantName: string;
    track: TransferTrackAnnouncement;
  }) => Promise<ReceivedTrackSink>, private readonly onTrackComplete?: (entry: ReceivedTrackEntry) => void) {}

  reportComplete(entry: ReceivedTrackEntry): void {
    try { this.onTrackComplete?.(entry); } catch { /* Library/manifest updates are best-effort. */ }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) { try { listener(); } catch { /* Keep notifying. */ } }
  }

  setConnected(participantId: string, delta: 1 | -1): void {
    this.connected.set(participantId, Math.max(0, (this.connected.get(participantId) || 0) + delta));
    this.notify();
  }

  setClockOffset(participantId: string, offsetMs: number): void {
    this.clockOffsets.set(participantId, offsetMs);
    this.notify();
  }

  getClockOffset(participantId: string): number | undefined {
    return this.clockOffsets.get(participantId);
  }

  ensureTrack(participantId: string, participantName: string, track: TransferTrackAnnouncement): ReceivedTrackEntry {
    this.names.set(participantId, participantName);
    let entry = this.tracks.get(track.id);
    if (!entry) {
      const sink = this.openSink({ participantId, participantName, track });
      entry = {
        id: track.id, participantId, participantName, announcement: track,
        received: 0, available: track.available, status: 'receiving',
        sink, writes: sink.then(() => undefined, () => undefined),
        ...(track.totalBytes !== undefined ? { totalBytes: track.totalBytes } : {}),
        ...(track.capture ? { capture: track.capture } : {}),
      };
      this.watchSink(entry, sink);
      this.tracks.set(track.id, entry);
    } else {
      // A reconnecting guest may now report under a new participant id.
      entry.participantId = participantId;
      entry.participantName = participantName;
      entry.available = Math.max(entry.available, track.available);
      if (track.totalBytes !== undefined) entry.totalBytes = track.totalBytes;
      if (track.capture) entry.capture = track.capture;
      entry.announcement = { ...entry.announcement, ...track };
    }
    this.notify();
    return entry;
  }

  /**
   * Count bytes a participant writes into the folder (including retries into
   * fresh files, which leave the earlier partial file on disk). False when
   * this write would go over the cap.
   */
  reserveBytes(participantId: string, bytes: number, maxBytes: number): boolean {
    const written = this.writtenBytes.get(participantId) || 0;
    if (written + bytes > maxBytes) return false;
    this.writtenBytes.set(participantId, written + bytes);
    return true;
  }

  private watchSink(entry: ReceivedTrackEntry, sink: Promise<ReceivedTrackSink>): void {
    sink.then((ready) => {
      if (entry.sink === sink) entry.received = ready.accepted();
    }, (error) => {
      if (entry.sink !== sink) return;
      entry.status = 'failed';
      entry.error = error instanceof Error ? error.message : 'The recording folder is not writable.';
      this.notify();
    });
  }

  /**
   * A failed track (folder access revoked, drive unplugged, disk full) gets
   * a fresh file when its guest connects again, so the track is not lost for
   * the rest of the session. The guest then resends from the new file's
   * size. Resolves false when no file can be opened.
   */
  async reopenTrack(entry: ReceivedTrackEntry): Promise<boolean> {
    if (entry.status === 'complete') return true;
    if (entry.blocked) return false;
    if (entry.status === 'receiving') {
      try { await entry.sink; return entry.status === 'receiving'; } catch { return false; }
    }
    const sink = this.openSink({ participantId: entry.participantId, participantName: entry.participantName, track: entry.announcement });
    entry.status = 'receiving';
    delete entry.error;
    entry.finishing = undefined;
    entry.received = 0;
    entry.sink = sink;
    entry.writes = sink.then(() => undefined, () => undefined);
    this.watchSink(entry, sink);
    this.notify();
    try {
      const ready = await sink;
      if (entry.sink === sink) entry.received = ready.accepted();
      return entry.sink === sink && entry.status === 'receiving';
    } catch {
      return false;
    }
  }

  summaries(): ParticipantTransferSummary[] {
    const byParticipant = new Map<string, ParticipantTransferSummary>();
    for (const entry of this.tracks.values()) {
      // By participant id: two guests with the same name are two rows.
      const key = entry.participantId;
      const summary = byParticipant.get(key) || {
        participantId: entry.participantId, participantName: entry.participantName, received: 0, available: 0, percent: 0,
        tracks: 0, completeTracks: 0, failedTracks: 0, connected: false,
      };
      summary.participantId = entry.participantId;
      summary.received += Math.min(entry.received, Math.max(entry.available, entry.totalBytes ?? 0));
      summary.available += Math.max(entry.available, entry.totalBytes ?? 0, entry.received);
      summary.tracks += 1;
      if (entry.status === 'complete') summary.completeTracks += 1;
      if (entry.status === 'failed') summary.failedTracks += 1;
      summary.connected = summary.connected || (this.connected.get(entry.participantId) || 0) > 0;
      const offset = this.clockOffsets.get(entry.participantId);
      if (offset !== undefined) summary.clockOffsetMs = offset;
      byParticipant.set(key, summary);
    }
    return [...byParticipant.values()].map((summary) => ({
      ...summary,
      percent: summary.completeTracks === summary.tracks && summary.tracks > 0 ? 100 : transferPercent(summary.received, summary.available),
    }));
  }

  /** True when no received track is still waiting for bytes. */
  isSettled(): boolean {
    return [...this.tracks.values()].every((entry) => entry.status !== 'receiving');
  }
}

export interface TransferReceiverOptions {
  channel: TransferChannel;
  participantId: string;
  registry: HostTransferRegistry;
  now?: () => number;
  /** Clock-sync pings at connect, then this often. */
  pingIntervalMs?: number;
  /** Per-participant caps on tracks, recordings and bytes written to the folder. */
  limits?: TransferLimits;
}

export interface TransferReceiver {
  close(): void;
}

export function createTransferReceiver(options: TransferReceiverOptions): TransferReceiver {
  const { channel, registry, participantId } = options;
  const limits = options.limits ?? DEFAULT_TRANSFER_LIMITS;
  const now = options.now ?? timelineNow;
  const lanes = new Map<number, { id: string; state: LaneReceiveState }>();
  const samples: ClockSample[] = [];
  const lastAckAt = new Map<string, number>();
  const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Acks are throttled, with a trailing ack so the sender's window never stalls.
  const scheduleAck = (id: string) => {
    const sendAck = () => {
      ackTimers.delete(id);
      lastAckAt.set(id, now());
      const entry = registry.tracks.get(id);
      if (entry) sendControl({ t: 'ack', id, offset: entry.received });
      registry.notify();
    };
    if (now() - (lastAckAt.get(id) || 0) >= 250) { sendAck(); return; }
    if (!ackTimers.has(id)) ackTimers.set(id, setTimeout(sendAck, 250));
  };
  let participantName = 'Guest';
  let closed = false;
  let pingCount = 0;
  channel.binaryType = 'arraybuffer';
  registry.setConnected(participantId, 1);

  const sendControl = (message: TransferControlMessage) => {
    if (!closed && channel.readyState === 'open') channel.send(serializeControlMessage(message));
  };

  // Tracks this connection already told the guest it cannot save (one 'done' each).
  const refused = new Set<string>();
  const refuseTrack = (entry: ReceivedTrackEntry) => {
    if (refused.has(entry.id)) return;
    refused.add(entry.id);
    if (entry.status === 'complete') {
      sendControl({ t: 'done', id: entry.id, bytes: entry.received, ok: true, ...(entry.path ? { path: entry.path } : {}) });
      return;
    }
    sendControl({ t: 'done', id: entry.id, bytes: entry.received, ok: false, error: entry.error || 'The host could not open a file for this track.' });
  };

  const addLane = async (track: TransferTrackAnnouncement) => {
    if (!registry.tracks.has(track.id)) {
      const refusal = trackAdmissionError(registry.tracks.values(), participantId, track, limits);
      if (refusal) {
        sendControl({ t: 'done', id: track.id, bytes: 0, ok: false, error: refusal });
        return;
      }
    }
    const entry = registry.ensureTrack(participantId, participantName, track);
    if (entry.status === 'complete') {
      sendControl({ t: 'done', id: entry.id, bytes: entry.received, ok: true, ...(entry.path ? { path: entry.path } : {}) });
      return;
    }
    if (lanes.get(track.lane)?.id === track.id) return;
    // A track whose file failed earlier starts over in a fresh file; never
    // resume a lane that cannot accept data (the guest would resend forever).
    if (!await registry.reopenTrack(entry)) {
      refuseTrack(entry);
      return;
    }
    // Pending writes from an earlier connection decide where we really are.
    await entry.writes;
    if (entry.status !== 'receiving') { refuseTrack(entry); return; }
    refused.delete(track.id);
    lanes.set(track.lane, { id: track.id, state: createLaneReceiveState(entry.received) });
    sendControl({ t: 'resume', id: track.id, offset: entry.received });
  };

  const finishTrack = (id: string, totalBytes: number, header?: string, capture?: unknown) => {
    const entry = registry.tracks.get(id);
    if (!entry || entry.status === 'complete') {
      if (entry) sendControl({ t: 'done', id, bytes: entry.received, ok: true, ...(entry.path ? { path: entry.path } : {}) });
      return;
    }
    if (entry.status === 'failed') { refuseTrack(entry); return; }
    entry.totalBytes = totalBytes;
    if (capture) entry.capture = capture;
    entry.finishing ??= (async () => {
      await entry.writes;
      if (entry.status === 'failed') {
        // The write chain already reported this failure; do not ask for a resend.
        entry.finishing = undefined;
        refused.add(id);
        return;
      }
      if (entry.received < totalBytes) {
        // Some bytes never arrived (e.g. a frame lost with the old connection).
        entry.finishing = undefined;
        const lane = [...lanes.values()].find((candidate) => candidate.id === id);
        if (lane) lane.state.awaitingOffset = entry.received;
        sendControl({ t: 'resume', id, offset: entry.received });
        return;
      }
      try {
        const sink = await entry.sink;
        const result = await sink.finish({ totalBytes: entry.received, ...(header ? { header: base64ToBytes(header) } : {}) });
        entry.status = 'complete';
        entry.path = result.path;
        entry.received = result.bytes;
        if (result.file) entry.file = result.file;
        sendControl({ t: 'done', id, bytes: result.bytes, ok: true, path: result.path });
        registry.reportComplete(entry);
      } catch (error) {
        entry.status = 'failed';
        entry.error = error instanceof Error ? error.message : 'The track could not be saved.';
        refuseTrack(entry);
      }
      registry.notify();
    })();
  };

  const onMessage = (event: { data: unknown }) => {
    if (closed) return;
    if (typeof event.data === 'string') {
      const message = parseControlMessage(event.data);
      if (!message) return;
      switch (message.t) {
        case 'hello':
          participantName = message.participantName || participantName;
          for (const track of message.tracks) void addLane(track);
          return;
        case 'track':
          void addLane(message.track);
          return;
        case 'end':
          finishTrack(message.id, message.totalBytes, message.header, message.capture);
          return;
        case 'pong': {
          samples.push({ t0: message.t0, t1: message.t1, t2: now() });
          if (samples.length > 15) samples.shift();
          const estimate = estimateClockOffset(samples);
          if (estimate) registry.setClockOffset(participantId, estimate.offsetMs);
          return;
        }
        default:
          return;
      }
    }
    const data = event.data instanceof ArrayBuffer || ArrayBuffer.isView(event.data) ? event.data : null;
    if (!data) return;
    const frame = decodeDataFrame(data as ArrayBuffer);
    if (!frame) return;
    const lane = lanes.get(frame.lane);
    if (!lane) return;
    const entry = registry.tracks.get(lane.id);
    if (!entry) return;
    // Frames for a saved or failed track: tell the guest once instead of
    // dropping them silently (it would wait for acks that never come).
    if (entry.status !== 'receiving') { refuseTrack(entry); return; }
    const decision = acceptDataFrame(lane.state, frame);
    if (decision.action === 'resume') { sendControl({ t: 'resume', id: lane.id, offset: decision.offset }); return; }
    if (decision.action !== 'write') return;
    // Copy: the frame's buffer is reused by nothing, but the slice keeps it small.
    const bytes = decision.bytes.slice();
    if (!registry.reserveBytes(participantId, bytes.byteLength, limits.maxBytes)) {
      entry.status = 'failed';
      entry.blocked = true;
      entry.error = 'This participant reached the host\'s size limit for received recordings.';
      refuseTrack(entry);
      registry.notify();
      return;
    }
    const expectedEnd = lane.state.received;
    const sinkForFrame = entry.sink;
    entry.writes = entry.writes.then(async () => {
      // Writes queued before a failure (or for a replaced file) are skipped.
      if (entry.sink !== sinkForFrame || entry.status !== 'receiving') return;
      const sink = await sinkForFrame;
      await sink.write(bytes);
      entry.received = expectedEnd;
      scheduleAck(lane.id);
    }).catch((error) => {
      if (entry.sink !== sinkForFrame || entry.status !== 'receiving') return;
      entry.status = 'failed';
      entry.error = error instanceof Error ? error.message : 'The recording folder stopped accepting files.';
      refuseTrack(entry);
      registry.notify();
    });
  };

  const ping = () => {
    if (closed || channel.readyState !== 'open') return;
    sendControl({ t: 'ping', n: pingCount++, t0: now() });
  };
  const burst: ReturnType<typeof setTimeout>[] = [];
  const startPings = () => { for (let index = 0; index < 5; index += 1) burst.push(setTimeout(ping, index * 250)); };
  channel.addEventListener('message', onMessage);
  channel.addEventListener('open', startPings);
  if (channel.readyState === 'open') startPings();
  const pingTimer = setInterval(ping, options.pingIntervalMs ?? 30_000);

  return {
    close() {
      if (closed) return;
      closed = true;
      burst.forEach(clearTimeout);
      ackTimers.forEach(clearTimeout);
      clearInterval(pingTimer);
      channel.removeEventListener('message', onMessage);
      channel.removeEventListener('open', startPings);
      registry.setConnected(participantId, -1);
    },
  };
}
