import type { Writable } from 'node:stream';

// MediaRecorder emits one continuous WebM stream: an EBML header, then a
// Segment holding Info/Tracks (the init segment) followed by Clusters of media.
// A consumer that joins mid-stream (a respawned FFmpeg) needs the init segment
// replayed and must start reading at a Cluster boundary.

export const EBML_HEADER_ID = 0x1a45dfa3;
export const WEBM_SEGMENT_ID = 0x18538067;
export const WEBM_CLUSTER_ID = 0x1f43b675;
export const MAX_WEBM_INIT_SEGMENT_BYTES = 1024 * 1024;

const CLUSTER_ID_BYTES = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const MAX_ELEMENT_HEADER_BYTES = 12;
const EMPTY = Buffer.alloc(0);

export interface EbmlElementHeader {
  id: number;
  /** Payload size in bytes, or null for the "unknown size" marker. */
  size: number | null;
  idLength: number;
  headerLength: number;
}

function vintLength(firstByte: number): number {
  return Math.clz32(firstByte) - 23;
}

export function readEbmlElementHeader(
  buffer: Buffer,
  offset = 0
): EbmlElementHeader | 'incomplete' | 'invalid' {
  if (offset >= buffer.length) return 'incomplete';
  const idFirst = buffer[offset];
  if (idFirst === 0) return 'invalid';
  const idLength = vintLength(idFirst);
  if (idLength > 4) return 'invalid';
  if (offset + idLength >= buffer.length) return 'incomplete';

  const sizeFirst = buffer[offset + idLength];
  if (sizeFirst === 0) return 'invalid';
  const sizeLength = vintLength(sizeFirst);
  const headerLength = idLength + sizeLength;
  if (offset + headerLength > buffer.length) return 'incomplete';

  const id = buffer.readUIntBE(offset, idLength);
  const dataMask = 0xff >> sizeLength;
  let size = sizeFirst & dataMask;
  let unknown = size === dataMask;
  for (let i = 1; i < sizeLength; i += 1) {
    const byte = buffer[offset + idLength + i];
    size = size * 256 + byte;
    unknown &&= byte === 0xff;
  }
  if (unknown) return { id, size: null, idLength, headerLength };
  if (!Number.isSafeInteger(size)) return 'invalid';
  return { id, size, idLength, headerLength };
}

export interface WebmClusterStart {
  /** Leading bytes of the Cluster header that arrived in earlier chunks. */
  prefix: Buffer;
  /** Offset in the current chunk where the rest of the Cluster begins. */
  offset: number;
}

export interface WebmChunkInfo {
  /** First Cluster that starts in this chunk, if any. */
  clusterStart: WebmClusterStart | null;
}

export interface WebmJoinPoint {
  /** Bytes a consumer joining now must read before any live data. */
  bytes: Buffer;
  /** Whether live data must be held back until the next Cluster starts. */
  awaitCluster: boolean;
}

interface HeaderCapture {
  start: number;
  parts: Buffer[];
  bytes: number;
  segmentSizeField: { offset: number; length: number } | null;
}

/**
 * Follows the element structure of a chunked WebM stream so a late consumer can
 * be handed the init segment and the byte where the next Cluster begins.
 * Only element headers are parsed and payloads are skipped by size. The only
 * containers entered are the Segment and unknown-size Clusters (Chrome writes
 * those), and their child IDs never collide with the IDs acted on here, so a
 * new Cluster ends an unknown-size one without tracking nesting depth.
 */
export class WebmStreamTracker {
  private skipRemaining = 0;
  private pending: Buffer = EMPTY;
  private lost = false;
  private received = 0;
  private header: HeaderCapture | null = null;
  private init: Buffer | null = null;

  /** EBML header plus Segment header through Tracks, ending before the first Cluster. */
  get initSegment(): Buffer | null {
    return this.init;
  }

  push(chunk: Buffer): WebmChunkInfo {
    const chunkStart = this.received;
    let clusterStart: WebmClusterStart | null = null;
    let pos = 0;

    while (pos < chunk.length) {
      if (this.skipRemaining > 0) {
        const skipped = Math.min(this.skipRemaining, chunk.length - pos);
        this.skipRemaining -= skipped;
        pos += skipped;
        continue;
      }

      if (this.lost) {
        pos = this.scanForCluster(chunk, pos);
        continue;
      }

      // Carried bytes are an incomplete header (or part of a Cluster ID) from
      // the end of earlier chunks, so they always precede chunk[0].
      const carried = this.pending;
      const header = carried.length
        ? readEbmlElementHeader(Buffer.concat([carried, chunk.subarray(pos, pos + MAX_ELEMENT_HEADER_BYTES)]))
        : readEbmlElementHeader(chunk, pos);

      if (header === 'incomplete') {
        this.pending = Buffer.concat([carried, chunk.subarray(pos)]);
        pos = chunk.length;
        break;
      }

      this.pending = EMPTY;
      if (header === 'invalid' || (header.size === null && !this.canHaveUnknownSize(header.id))) {
        // Rescan past this bogus element start. Carried bytes are dropped so
        // pending never holds more than a partial header.
        this.loseSync();
        if (!carried.length) pos += 1;
        continue;
      }

      const elementStart = chunkStart + pos - carried.length;
      const elementOffset = pos;
      pos += header.headerLength - carried.length;

      if (header.id === EBML_HEADER_ID) {
        this.beginHeaderCapture(elementStart, carried);
        this.skipRemaining = header.size ?? 0;
      } else if (header.id === WEBM_SEGMENT_ID) {
        if (this.header) {
          this.header.segmentSizeField = {
            offset: elementStart + header.idLength - this.header.start,
            length: header.headerLength - header.idLength,
          };
        }
      } else if (header.id === WEBM_CLUSTER_ID) {
        clusterStart ??= { prefix: carried, offset: elementOffset };
        if (this.header) this.finishHeaderCapture(chunk, chunkStart, elementStart);
        this.skipRemaining = header.size ?? 0;
      } else {
        this.skipRemaining = header.size ?? 0;
      }
    }

    this.received += chunk.length;
    this.appendHeaderBytes(chunk, chunkStart);
    return { clusterStart };
  }

  /** What a consumer (such as a respawned FFmpeg) must read to join the stream now. */
  joinPoint(): WebmJoinPoint | null {
    if (this.header) {
      // The first Cluster has not arrived yet, so the stream so far is all header.
      return { bytes: Buffer.concat(this.header.parts), awaitCluster: false };
    }
    if (this.init) return { bytes: this.init, awaitCluster: true };
    if (this.received === 0) return { bytes: EMPTY, awaitCluster: false };
    return null;
  }

  private canHaveUnknownSize(id: number): boolean {
    return id === WEBM_SEGMENT_ID || id === WEBM_CLUSTER_ID;
  }

  private loseSync() {
    this.lost = true;
    // A header that cannot be parsed cannot be replayed.
    this.header = null;
  }

  private scanForCluster(chunk: Buffer, pos: number): number {
    const carried = this.pending;
    if (carried.length) {
      const boundary = Buffer.concat([carried, chunk.subarray(pos, pos + CLUSTER_ID_BYTES.length - 1)]);
      const index = boundary.indexOf(CLUSTER_ID_BYTES);
      if (index !== -1 && index < carried.length) {
        this.pending = carried.subarray(index);
        this.lost = false;
        return pos;
      }
    }

    const index = chunk.indexOf(CLUSTER_ID_BYTES, pos);
    if (index !== -1) {
      this.pending = EMPTY;
      this.lost = false;
      return index;
    }

    // Keep a short tail in case the Cluster ID straddles into the next chunk.
    const tail = Buffer.concat([carried, chunk.subarray(Math.max(pos, chunk.length - (CLUSTER_ID_BYTES.length - 1)))]);
    this.pending = tail.subarray(Math.max(0, tail.length - (CLUSTER_ID_BYTES.length - 1)));
    return chunk.length;
  }

  private beginHeaderCapture(start: number, carried: Buffer) {
    // A new EBML header starts a new stream whose tracks may differ.
    this.init = null;
    this.header = {
      start,
      parts: carried.length ? [carried] : [],
      bytes: carried.length,
      segmentSizeField: null,
    };
  }

  private finishHeaderCapture(chunk: Buffer, chunkStart: number, clusterStart: number) {
    const header = this.header;
    if (!header) return;
    this.header = null;

    const from = Math.max(header.start, chunkStart) - chunkStart;
    const to = clusterStart - chunkStart;
    const parts = to > from ? [...header.parts, chunk.subarray(from, to)] : header.parts;
    const length = clusterStart - header.start;
    if (length > MAX_WEBM_INIT_SEGMENT_BYTES) return;
    const init = Buffer.concat(parts).subarray(0, length);

    // A replayed stream is shorter than the original, so a known Segment size
    // would end it early. Rewrite it in place as "unknown" (all data bits set).
    const field = header.segmentSizeField;
    if (field && field.offset + field.length <= init.length) {
      init[field.offset] = 0xff >> (field.length - 1);
      init.fill(0xff, field.offset + 1, field.offset + field.length);
    }
    this.init = init;
  }

  private appendHeaderBytes(chunk: Buffer, chunkStart: number) {
    const header = this.header;
    if (!header) return;
    const from = Math.max(header.start, chunkStart) - chunkStart;
    if (from >= chunk.length) return;
    header.bytes += chunk.length - from;
    if (header.bytes > MAX_WEBM_INIT_SEGMENT_BYTES) {
      this.header = null;
      return;
    }
    header.parts.push(Buffer.from(chunk.subarray(from)));
  }
}

export type WebmJoinResult = 'from-start' | 'resync' | 'no-init';

/**
 * Writes a live WebM stream into one consumer. A consumer that joins mid-stream
 * gets the init segment first and then live data from the next Cluster on.
 */
export class WebmSinkFeed {
  private waitingForCluster = false;
  private broken = false;

  constructor(private readonly output: Writable, onError?: (err: Error) => void) {
    // A consumer that dies mid-write raises EPIPE here; unhandled, it would
    // crash the process and every other destination with it.
    output.on('error', (err) => {
      this.broken = true;
      onError?.(err);
    });
  }

  get awaitingCluster(): boolean {
    return this.waitingForCluster;
  }

  join(tracker: WebmStreamTracker): WebmJoinResult {
    const joinPoint = tracker.joinPoint();
    if (!joinPoint) return 'no-init';
    if (joinPoint.bytes.length) this.output.write(joinPoint.bytes);
    this.waitingForCluster = joinPoint.awaitCluster;
    return joinPoint.awaitCluster ? 'resync' : 'from-start';
  }

  /** Returns true when any media from this chunk reached the consumer. */
  write(chunk: Buffer, info: WebmChunkInfo): boolean {
    if (this.broken || !this.output.writable) return false;
    if (!this.waitingForCluster) {
      this.output.write(chunk);
      return true;
    }

    const start = info.clusterStart;
    if (!start) return false;
    this.waitingForCluster = false;
    if (start.prefix.length) this.output.write(start.prefix);
    this.output.write(start.offset ? chunk.subarray(start.offset) : chunk);
    return true;
  }
}
