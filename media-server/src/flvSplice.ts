import {
  describeFlvTag,
  FLV_PREVIOUS_TAG_SIZE_BYTES,
  FLV_TAG_AUDIO,
  FLV_TAG_HEADER_BYTES,
  FLV_TAG_SCRIPT,
  FLV_TAG_VIDEO,
  FlvTagStream,
  type FlvChunk,
} from './flvStream.js';

/**
 * The program the destinations and the watch page receive, stitched from
 * one encoder after another. When the studio's connection drops, a "we'll
 * be right back" slate takes over; when it returns, a new encoder does.
 * Each switch happens at a keyframe of the incoming source, whose codec
 * setup is sent first, and its timestamps continue from the program's, so
 * the destinations' RTMP connections never see a break or a new stream.
 */

/** FLV header for audio plus video, then PreviousTagSize0. */
const PROGRAM_FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0]);
/** Room left after the last program frame before the next source's first. */
const SPLICE_GAP_MS = 40;

export function readFlvTimestamp(tag: Buffer): number {
  return ((tag[7] << 24) >>> 0) + tag.readUIntBE(4, 3);
}

export function withFlvTimestamp(tag: Buffer, timestampMs: number): Buffer {
  const copy = Buffer.from(tag);
  const ts = Math.max(0, Math.round(timestampMs)) >>> 0;
  copy.writeUIntBE(ts & 0xffffff, 4, 3);
  copy[7] = (ts >>> 24) & 0xff;
  return copy;
}

/** Whole tags in a chunk from FlvTagStream, skipping a leading file header. */
export function* flvTagsIn(bytes: Buffer): Generator<Buffer> {
  let offset = 0;
  if (bytes.length >= 9 && bytes.toString('latin1', 0, 3) === 'FLV') {
    offset = bytes.readUInt32BE(5) + FLV_PREVIOUS_TAG_SIZE_BYTES;
  }
  while (offset + FLV_TAG_HEADER_BYTES <= bytes.length) {
    const size = FLV_TAG_HEADER_BYTES + bytes.readUIntBE(offset + 1, 3) + FLV_PREVIOUS_TAG_SIZE_BYTES;
    if (offset + size > bytes.length) return;
    yield bytes.subarray(offset, offset + size);
    offset += size;
  }
}

export class FlvProgramSource {
  readonly tags = new FlvTagStream();
  constructor(
    readonly name: string,
    private readonly program: FlvProgram,
  ) {}

  /** Raw FLV from this source's encoder. */
  push(data: Buffer): void {
    const chunk = this.tags.push(data);
    if (chunk) this.program.receive(this, chunk);
  }
}

export class FlvProgram {
  /** What consumers read: parsed program tags, and the codec setup late joiners need. */
  readonly stream = new FlvTagStream();
  private active: FlvProgramSource | null = null;
  private pending: FlvProgramSource | null = null;
  private offsetMs = 0;
  private lastVideoMs = -1;
  private lastAudioMs = -1;
  private headerSent = false;
  private metadataSent = false;
  switches = 0;

  constructor(
    private readonly emit: (chunk: FlvChunk) => void,
    private readonly onSwitch?: (source: FlvProgramSource) => void,
  ) {}

  get activeSource(): FlvProgramSource | null {
    return this.active;
  }

  get pendingSource(): FlvProgramSource | null {
    return this.pending;
  }

  createSource(name: string): FlvProgramSource {
    return new FlvProgramSource(name, this);
  }

  /**
   * Put `source` on air: at once if nothing is on air yet, otherwise at its
   * next video keyframe. The source on air keeps going until then.
   */
  switchTo(source: FlvProgramSource): void {
    if (source === this.active) {
      this.pending = null;
      return;
    }
    if (!this.active) {
      this.active = source;
      this.pending = null;
      this.offsetMs = 0;
      return;
    }
    this.pending = source;
  }

  /** Called by sources with their parsed tags. */
  receive(source: FlvProgramSource, chunk: FlvChunk): void {
    if (source !== this.active && source !== this.pending) return;
    const out: Buffer[] = [];
    for (const tag of flvTagsIn(chunk.bytes)) {
      if (source === this.pending) {
        const info = describeFlvTag(tag);
        if (info.type !== FLV_TAG_VIDEO || !info.keyframe || info.sequenceHeader) continue;
        if (!source.tags.sequenceHeaders.length) continue;
        this.cutTo(source, readFlvTimestamp(tag), out);
      }
      if (source !== this.active) continue;
      this.append(tag, out);
    }
    this.flush(out);
  }

  private cutTo(source: FlvProgramSource, keyframeMs: number, out: Buffer[]): void {
    const last = Math.max(this.lastVideoMs, this.lastAudioMs);
    const base = last < 0 ? 0 : last + SPLICE_GAP_MS;
    this.active = source;
    this.pending = null;
    this.offsetMs = base - keyframeMs;
    this.switches += 1;
    // The incoming encoder's codec setup, then its keyframe.
    for (const header of source.tags.sequenceHeaders) {
      out.push(withFlvTimestamp(header, base));
    }
    this.onSwitch?.(source);
  }

  private append(tag: Buffer, out: Buffer[]): void {
    const info = describeFlvTag(tag);
    if (info.type === FLV_TAG_SCRIPT) {
      // Only the first source's metadata; later ones would announce a new stream.
      if (this.metadataSent) return;
      this.metadataSent = true;
      out.push(tag);
      return;
    }
    if (info.type !== FLV_TAG_VIDEO && info.type !== FLV_TAG_AUDIO) return;
    let ms = readFlvTimestamp(tag) + this.offsetMs;
    // Timestamps only move forward within each track.
    if (info.type === FLV_TAG_VIDEO) {
      ms = Math.max(ms, this.lastVideoMs, 0);
      this.lastVideoMs = ms;
    } else {
      ms = Math.max(ms, this.lastAudioMs, 0);
      this.lastAudioMs = ms;
    }
    out.push(ms === readFlvTimestamp(tag) ? tag : withFlvTimestamp(tag, ms));
  }

  private flush(out: Buffer[]): void {
    if (!out.length) return;
    if (!this.headerSent) {
      this.headerSent = true;
      out.unshift(PROGRAM_FLV_HEADER);
    }
    const chunk = this.stream.push(Buffer.concat(out));
    if (chunk) this.emit(chunk);
  }
}
