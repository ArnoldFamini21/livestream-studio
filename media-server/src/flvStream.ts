import type { Writable } from 'node:stream';
import type { SinkBackpressureOptions } from './webmStream.js';

// Encode-once fan-out: one FFmpeg encodes the studio's WebM into H.264/AAC
// FLV on stdout, and each destination gets a copy-only FFmpeg that pushes that
// FLV to its RTMP server. FLV is a flat list of tags, and its codec setup lives
// in a few leading tags (header, metadata, AVC and AAC sequence headers), so a
// destination that restarts or falls behind can rejoin at any video keyframe
// without touching the encoder or the other destinations.

export const FLV_HEADER_BYTES = 13; // 9-byte header + PreviousTagSize0
const FLV_TAG_HEADER_BYTES = 11;
const FLV_PREVIOUS_TAG_SIZE_BYTES = 4;
const MAX_FLV_TAG_BYTES = 16 * 1024 * 1024;

export const FLV_TAG_AUDIO = 8;
export const FLV_TAG_VIDEO = 9;
export const FLV_TAG_SCRIPT = 18;

const FLV_CODEC_AVC = 7;
const FLV_SOUND_AAC = 10;

export interface FlvTag {
  type: number;
  /** The whole tag including its header and trailing PreviousTagSize. */
  bytes: Buffer;
  keyframe: boolean;
  sequenceHeader: boolean;
}

export function describeFlvTag(bytes: Buffer): FlvTag {
  const type = bytes[0] & 0x1f;
  const data = bytes.subarray(FLV_TAG_HEADER_BYTES);
  let keyframe = false;
  let sequenceHeader = false;
  if (type === FLV_TAG_VIDEO && data.length >= 2) {
    keyframe = (data[0] >> 4) === 1;
    sequenceHeader = (data[0] & 0x0f) === FLV_CODEC_AVC && data[1] === 0;
  } else if (type === FLV_TAG_AUDIO && data.length >= 2) {
    sequenceHeader = (data[0] >> 4) === FLV_SOUND_AAC && data[1] === 0;
  }
  return { type, bytes, keyframe, sequenceHeader };
}

export interface FlvChunk {
  /** Whole tags only (after the file header). */
  bytes: Buffer;
  /** Offset of the first video keyframe tag in `bytes`, if any. */
  keyframeOffset: number | null;
}

/**
 * Splits the encoder's stdout into whole FLV tags, remembers the codec setup a
 * late consumer needs, and marks where video keyframes begin.
 */
export class FlvTagStream {
  private pending: Buffer = Buffer.alloc(0);
  private header: Buffer | null = null;
  private metadata: Buffer | null = null;
  private videoConfig: Buffer | null = null;
  private audioConfig: Buffer | null = null;
  private invalid = false;

  /** Whether the file header has passed, so a new consumer must resync. */
  get started(): boolean {
    return this.header !== null;
  }

  /** False once the stream stopped looking like FLV; nothing more is emitted. */
  get healthy(): boolean {
    return !this.invalid;
  }

  /**
   * Bytes a consumer joining now must read first: the file header, metadata,
   * and codec sequence headers. Null until the video setup has been seen.
   */
  get initSegment(): Buffer | null {
    if (!this.header || !this.videoConfig) return null;
    return Buffer.concat([
      this.header,
      ...(this.metadata ? [this.metadata] : []),
      this.videoConfig,
      ...(this.audioConfig ? [this.audioConfig] : []),
    ]);
  }

  /** The file header and any tags before it are returned as-is. */
  push(data: Buffer): FlvChunk | null {
    if (this.invalid) return null;
    let buffer = this.pending.length ? Buffer.concat([this.pending, data]) : data;
    let prefix: Buffer | null = null;

    if (!this.header) {
      if (buffer.length < FLV_HEADER_BYTES) {
        this.pending = Buffer.from(buffer);
        return null;
      }
      if (buffer.toString('latin1', 0, 3) !== 'FLV') {
        this.invalid = true;
        return null;
      }
      const headerSize = buffer.readUInt32BE(5);
      const total = headerSize + FLV_PREVIOUS_TAG_SIZE_BYTES;
      if (headerSize < 9 || buffer.length < total) {
        this.pending = Buffer.from(buffer);
        if (headerSize < 9) this.invalid = true;
        return null;
      }
      this.header = Buffer.from(buffer.subarray(0, total));
      prefix = this.header;
      buffer = buffer.subarray(total);
    }

    let offset = 0;
    let keyframeOffset: number | null = null;
    const base = prefix ? prefix.length : 0;
    while (offset + FLV_TAG_HEADER_BYTES <= buffer.length) {
      const dataSize = buffer.readUIntBE(offset + 1, 3);
      const tagBytes = FLV_TAG_HEADER_BYTES + dataSize + FLV_PREVIOUS_TAG_SIZE_BYTES;
      if (tagBytes > MAX_FLV_TAG_BYTES) {
        this.invalid = true;
        return null;
      }
      if (offset + tagBytes > buffer.length) break;
      const tag = describeFlvTag(buffer.subarray(offset, offset + tagBytes));
      if (tag.type === FLV_TAG_SCRIPT && !this.metadata) {
        this.metadata = Buffer.from(tag.bytes);
      } else if (tag.sequenceHeader && tag.type === FLV_TAG_VIDEO) {
        this.videoConfig = Buffer.from(tag.bytes);
      } else if (tag.sequenceHeader && tag.type === FLV_TAG_AUDIO) {
        this.audioConfig = Buffer.from(tag.bytes);
      } else if (tag.keyframe && keyframeOffset === null) {
        keyframeOffset = base + offset;
      }
      offset += tagBytes;
    }

    this.pending = offset < buffer.length ? Buffer.from(buffer.subarray(offset)) : Buffer.alloc(0);
    if (!offset && !prefix) return null;
    const tags = buffer.subarray(0, offset);
    return {
      bytes: prefix ? Buffer.concat([prefix, tags]) : tags,
      keyframeOffset,
    };
  }
}

type FlvFeedState = 'flowing' | 'dropping' | 'awaiting-keyframe';

/**
 * Writes the shared FLV into one destination's copy-only FFmpeg. A destination
 * that joins late gets the init segment and then tags from the next keyframe.
 * One whose upload falls behind `maxBufferedBytes` skips tags and resumes at a
 * keyframe once its queue has drained to half the limit, so it stays live.
 */
export class FlvSinkFeed {
  private state: FlvFeedState = 'flowing';
  private broken = false;
  private readonly maxBufferedBytes: number;
  private readonly onOverflow?: () => void;
  private readonly onRecover?: (droppedBytes: number) => void;
  private dropping = 0;
  overflowCount = 0;
  droppedBytes = 0;

  constructor(
    private readonly output: Writable,
    private readonly stream: FlvTagStream,
    options: SinkBackpressureOptions & { onError?: (err: Error) => void } = {}
  ) {
    this.maxBufferedBytes = options.maxBufferedBytes && options.maxBufferedBytes > 0 ? options.maxBufferedBytes : 0;
    this.onOverflow = options.onOverflow;
    this.onRecover = options.onRecover;
    // A destination that dies mid-write raises EPIPE here; unhandled, it would
    // crash the process and every other destination with it.
    output.on('error', (err) => {
      this.broken = true;
      options.onError?.(err);
    });
  }

  get skipping(): boolean {
    return this.state === 'dropping';
  }

  /**
   * Join the shared stream. Before the encoder has written anything the
   * destination simply reads from the start; afterwards it waits for the next
   * keyframe and receives the init segment just before it.
   */
  join(): 'from-start' | 'resync' {
    if (!this.stream.started) return 'from-start';
    this.state = 'awaiting-keyframe';
    return 'resync';
  }

  /** Returns true when any media from this chunk reached the destination. */
  write(chunk: FlvChunk): boolean {
    if (this.broken || !this.output.writable) return false;

    if (this.state === 'flowing') {
      if (this.maxBufferedBytes > 0 && this.output.writableLength > this.maxBufferedBytes) {
        // Tags are self-contained, so the cut can happen at this boundary.
        this.state = 'dropping';
        this.overflowCount += 1;
        this.dropping = 0;
        this.onOverflow?.();
      } else {
        this.output.write(chunk.bytes);
        return true;
      }
    }

    const drained = this.maxBufferedBytes <= 0 || this.output.writableLength <= this.maxBufferedBytes / 2;
    const init = this.state === 'awaiting-keyframe' ? this.stream.initSegment : null;
    if (
      chunk.keyframeOffset === null
      || (this.state === 'dropping' && !drained)
      || (this.state === 'awaiting-keyframe' && !init)
    ) {
      this.dropping += chunk.bytes.length;
      this.droppedBytes += chunk.bytes.length;
      return false;
    }

    const recovered = this.state === 'dropping';
    this.state = 'flowing';
    if (init) this.output.write(init);
    this.output.write(chunk.keyframeOffset ? chunk.bytes.subarray(chunk.keyframeOffset) : chunk.bytes);
    if (recovered) {
      this.dropping += chunk.keyframeOffset;
      this.droppedBytes += chunk.keyframeOffset;
      this.onRecover?.(this.dropping);
      this.dropping = 0;
    }
    return true;
  }
}
