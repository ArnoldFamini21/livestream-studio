/**
 * Wire format for sending a guest's local recording to the host over an
 * RTCDataChannel ("rec-transfer", ordered, reliable).
 *
 * Control messages are JSON strings. Media travels in binary frames:
 *
 *   0  u16  magic 0x5254 ("RT")
 *   2  u8   protocol version (1)
 *   3  u8   frame type (1 = data)
 *   4  u16  lane (the track's number in this connection)
 *   6  u16  epoch (bumped by the sender on every resume, so frames sent
 *            before a resume are recognised and dropped)
 *   8  u32  sequence number within the lane and epoch
 *   12 f64  byte offset of the payload in the track file
 *   20      payload
 *
 * The receiver accepts a frame only at exactly the next expected offset;
 * a gap triggers one `resume` naming the offset it actually has, and the
 * sender rewinds there. Acks report bytes committed to the host's folder.
 */

export const RECORDING_TRANSFER_PROTOCOL_VERSION = 1;
export const RECORDING_TRANSFER_CHANNEL_LABEL = 'rec-transfer';
export const DATA_FRAME_HEADER_BYTES = 20;
/** Interoperable SCTP message size (Safari and Firefox accept 64 KiB). */
export const MAX_TRANSFER_MESSAGE_BYTES = 64 * 1024;
const MAGIC = 0x5254;
const FRAME_DATA = 1;

export interface DataFrame {
  lane: number;
  epoch: number;
  seq: number;
  offset: number;
  payload: Uint8Array;
}

export function encodeDataFrame(frame: Omit<DataFrame, 'payload'> & { payload: ArrayBuffer | Uint8Array }): ArrayBuffer {
  const payload = frame.payload instanceof Uint8Array ? frame.payload : new Uint8Array(frame.payload);
  if (!Number.isSafeInteger(frame.offset) || frame.offset < 0) throw new RangeError('Invalid frame offset');
  if (frame.lane < 0 || frame.lane > 0xffff || frame.epoch < 0 || frame.epoch > 0xffff) throw new RangeError('Invalid lane or epoch');
  const buffer = new ArrayBuffer(DATA_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint16(0, MAGIC);
  view.setUint8(2, RECORDING_TRANSFER_PROTOCOL_VERSION);
  view.setUint8(3, FRAME_DATA);
  view.setUint16(4, frame.lane);
  view.setUint16(6, frame.epoch);
  view.setUint32(8, frame.seq >>> 0);
  view.setFloat64(12, frame.offset);
  new Uint8Array(buffer, DATA_FRAME_HEADER_BYTES).set(payload);
  return buffer;
}

export function decodeDataFrame(data: ArrayBuffer | ArrayBufferView): DataFrame | null {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  if (bytes.byteLength < DATA_FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== MAGIC || view.getUint8(2) !== RECORDING_TRANSFER_PROTOCOL_VERSION || view.getUint8(3) !== FRAME_DATA) return null;
  const offset = view.getFloat64(12);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return {
    lane: view.getUint16(4),
    epoch: view.getUint16(6),
    seq: view.getUint32(8),
    offset,
    payload: bytes.subarray(DATA_FRAME_HEADER_BYTES),
  };
}

/** Largest payload per frame for a channel's negotiated message size. */
export function getFramePayloadBytes(maxMessageSize: number | null | undefined): number {
  const negotiated = Number.isFinite(maxMessageSize) && (maxMessageSize as number) > DATA_FRAME_HEADER_BYTES
    ? Math.min(maxMessageSize as number, MAX_TRANSFER_MESSAGE_BYTES)
    : 16 * 1024;
  return negotiated - DATA_FRAME_HEADER_BYTES;
}

export interface TransferTrackAnnouncement {
  /** Stable track id (the guest's browser backup id); survives reloads. */
  id: string;
  lane: number;
  sessionId: string;
  label: string;
  kind: string;
  mimeType: string;
  /** Bytes the guest has committed so far. */
  available: number;
  /** Set once the recorder finished; the file is then exactly this long. */
  totalBytes?: number;
  /** Replacement for the first bytes of the file (e.g. a WAV header with real sizes), base64. */
  header?: string;
  capture?: unknown;
  lossless?: boolean;
}

export type TransferControlMessage =
  | { t: 'hello'; v: number; participantName: string; tracks: TransferTrackAnnouncement[] }
  | { t: 'track'; track: TransferTrackAnnouncement }
  | { t: 'resume'; id: string; offset: number }
  | { t: 'ack'; id: string; offset: number }
  | { t: 'end'; id: string; totalBytes: number; header?: string; capture?: unknown }
  | { t: 'done'; id: string; bytes: number; ok: boolean; path?: string; error?: string }
  | { t: 'ping'; n: number; t0: number }
  | { t: 'pong'; n: number; t0: number; t1: number };

const MAX_CONTROL_LENGTH = 256 * 1024;
const TRACK_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length <= max;

function parseAnnouncement(value: unknown): TransferTrackAnnouncement | null {
  if (!value || typeof value !== 'object') return null;
  const track = value as Record<string, unknown>;
  if (!isText(track.id) || !TRACK_ID.test(track.id) || !isCount(track.lane) || track.lane > 0xffff) return null;
  if (!isText(track.sessionId, 160) || !isText(track.label) || !isText(track.kind, 32) || !isText(track.mimeType, 160)) return null;
  if (!isCount(track.available)) return null;
  if (track.totalBytes !== undefined && !isCount(track.totalBytes)) return null;
  if (track.header !== undefined && (!isText(track.header, 4096))) return null;
  return {
    id: track.id,
    lane: track.lane,
    sessionId: track.sessionId,
    label: track.label,
    kind: track.kind,
    mimeType: track.mimeType,
    available: track.available,
    ...(track.totalBytes !== undefined ? { totalBytes: track.totalBytes as number } : {}),
    ...(typeof track.header === 'string' ? { header: track.header } : {}),
    ...(track.capture && typeof track.capture === 'object' ? { capture: track.capture } : {}),
    ...(track.lossless === true ? { lossless: true } : {}),
  };
}

export function parseControlMessage(raw: string): TransferControlMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_CONTROL_LENGTH) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  switch (value.t) {
    case 'hello': {
      if (!isCount(value.v) || !isText(value.participantName) || !Array.isArray(value.tracks) || value.tracks.length > 256) return null;
      const tracks = value.tracks.map(parseAnnouncement);
      if (tracks.some((track) => !track)) return null;
      return { t: 'hello', v: value.v, participantName: value.participantName, tracks: tracks as TransferTrackAnnouncement[] };
    }
    case 'track': {
      const track = parseAnnouncement(value.track);
      return track ? { t: 'track', track } : null;
    }
    case 'resume':
    case 'ack':
      return isText(value.id) && TRACK_ID.test(value.id) && isCount(value.offset) ? { t: value.t, id: value.id, offset: value.offset } : null;
    case 'end':
      if (!isText(value.id) || !TRACK_ID.test(value.id) || !isCount(value.totalBytes)) return null;
      if (value.header !== undefined && !isText(value.header, 4096)) return null;
      return {
        t: 'end', id: value.id, totalBytes: value.totalBytes,
        ...(typeof value.header === 'string' ? { header: value.header } : {}),
        ...(value.capture && typeof value.capture === 'object' ? { capture: value.capture } : {}),
      };
    case 'done':
      if (!isText(value.id) || !TRACK_ID.test(value.id) || !isCount(value.bytes) || typeof value.ok !== 'boolean') return null;
      return {
        t: 'done', id: value.id, bytes: value.bytes, ok: value.ok,
        ...(isText(value.path, 1024) ? { path: value.path } : {}),
        ...(isText(value.error, 500) ? { error: value.error } : {}),
      };
    case 'ping':
      return isCount(value.n) && Number.isFinite(value.t0) ? { t: 'ping', n: value.n, t0: value.t0 as number } : null;
    case 'pong':
      return isCount(value.n) && Number.isFinite(value.t0) && Number.isFinite(value.t1)
        ? { t: 'pong', n: value.n, t0: value.t0 as number, t1: value.t1 as number }
        : null;
    default:
      return null;
  }
}

export function serializeControlMessage(message: TransferControlMessage): string {
  return JSON.stringify(message);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Receiver-side bookkeeping for one lane. */
export interface LaneReceiveState {
  /** Bytes accepted (and handed to the writer) so far. */
  received: number;
  epoch: number;
  lastSeq: number;
  /** Offset already requested with `resume`; avoids a storm of resumes. */
  awaitingOffset: number | null;
}

export type FrameDecision =
  | { action: 'write'; bytes: Uint8Array }
  | { action: 'ignore' }
  | { action: 'resume'; offset: number };

export function createLaneReceiveState(received = 0): LaneReceiveState {
  return { received, epoch: 0, lastSeq: -1, awaitingOffset: null };
}

/**
 * Decide what to do with a frame. Overlapping frames keep only their new
 * tail; frames from an older epoch are stale; a gap asks for a resume once.
 */
export function acceptDataFrame(state: LaneReceiveState, frame: DataFrame): FrameDecision {
  if (frame.epoch < state.epoch) return { action: 'ignore' };
  if (frame.epoch > state.epoch) {
    state.epoch = frame.epoch;
    state.lastSeq = -1;
  }
  const end = frame.offset + frame.payload.byteLength;
  if (frame.offset > state.received) {
    if (state.awaitingOffset === state.received) return { action: 'ignore' };
    state.awaitingOffset = state.received;
    return { action: 'resume', offset: state.received };
  }
  state.awaitingOffset = null;
  state.lastSeq = frame.seq;
  if (end <= state.received) return { action: 'ignore' };
  const bytes = frame.payload.subarray(state.received - frame.offset);
  state.received = end;
  return { action: 'write', bytes };
}

/** Sender-side bookkeeping for one lane. */
export interface LaneSendState {
  lane: number;
  /** Next byte to send. */
  sent: number;
  /** Highest offset the host reported as committed. */
  acked: number;
  epoch: number;
  seq: number;
  /** True once the host asked where to start (or the lane is new to it). */
  started: boolean;
}

export function createLaneSendState(lane: number): LaneSendState {
  return { lane, sent: 0, acked: 0, epoch: 0, seq: 0, started: false };
}

/** The host told us where it is: rewind (or skip ahead) to that offset. */
export function applyResume(state: LaneSendState, offset: number, available: number): void {
  state.sent = Math.min(Math.max(0, offset), available);
  state.acked = Math.min(Math.max(state.acked, 0), state.sent);
  state.epoch = (state.epoch + 1) & 0xffff;
  state.seq = 0;
  state.started = true;
}

/** Next [start, end) range to send, or null when caught up. */
export function nextSendRange(state: LaneSendState, available: number, maxPayload: number): { start: number; end: number } | null {
  if (!state.started || state.sent >= available) return null;
  return { start: state.sent, end: Math.min(available, state.sent + Math.max(1, maxPayload)) };
}

/** Percent of a participant's recorded bytes that reached the host. */
export function transferPercent(received: number, available: number): number {
  if (!(available > 0)) return 0;
  return Math.max(0, Math.min(100, Math.floor((received / available) * 100)));
}
