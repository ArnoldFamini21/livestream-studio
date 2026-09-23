import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  EBML_HEADER_ID,
  MAX_WEBM_INIT_SEGMENT_BYTES,
  WEBM_CLUSTER_ID,
  WEBM_SEGMENT_ID,
  WebmSinkFeed,
  WebmStreamTracker,
  readEbmlElementHeader,
} from './webmStream.js';

const CLUSTER_ID_BYTES = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function idBytes(id: number): Buffer {
  const length = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const out = Buffer.alloc(length);
  out.writeUIntBE(id, 0, length);
  return out;
}

function sizeBytes(size: number, length?: number): Buffer {
  let bytes = length ?? 1;
  while (length === undefined && size >= 2 ** (7 * bytes) - 1) bytes += 1;
  const out = Buffer.alloc(bytes);
  let value = size;
  for (let i = bytes - 1; i >= 0; i -= 1) {
    out[i] = value % 256;
    value = Math.floor(value / 256);
  }
  out[0] |= 0x80 >> (bytes - 1);
  return out;
}

function element(id: number, ...children: Buffer[]): Buffer {
  const payload = Buffer.concat(children);
  return Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]);
}

function uint(value: number, bytes = 1): Buffer {
  const out = Buffer.alloc(bytes);
  out.writeUIntBE(value, 0, bytes);
  return out;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function splitAt(stream: Buffer, cuts: number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let start = 0;
  for (const cut of [...cuts, stream.length]) {
    if (cut > start) chunks.push(stream.subarray(start, cut));
    start = Math.max(start, cut);
  }
  return chunks;
}

function splitRandomly(stream: Buffer, seed: number, maxChunk: number): Buffer[] {
  const random = mulberry32(seed);
  const cuts: number[] = [];
  for (let cut = 0; cut < stream.length;) {
    cut += 1 + Math.floor(random() * maxChunk);
    cuts.push(cut);
  }
  return splitAt(stream, cuts);
}

function ebmlHeader(docType = 'webm'): Buffer {
  return element(
    EBML_HEADER_ID,
    element(0x4286, uint(1)),
    element(0x42f7, uint(1)),
    element(0x42f2, uint(4)),
    element(0x42f3, uint(8)),
    element(0x4282, Buffer.from(docType)),
    element(0x4287, uint(4)),
    element(0x4285, uint(2))
  );
}

function tracks(videoCodec: string): Buffer {
  return element(
    0x1654ae6b,
    element(0xae, element(0xd7, uint(1)), element(0x86, Buffer.from(videoCodec)), element(0x83, uint(1))),
    // Opus CodecPrivate that happens to contain a Cluster ID.
    element(0xae, element(0xd7, uint(2)), element(0x86, Buffer.from('A_OPUS')), element(0x83, uint(2)),
      element(0x63a2, Buffer.concat([Buffer.from('OpusHead'), CLUSTER_ID_BYTES, uint(0xbb80, 4)])))
  );
}

function simpleBlock(track: number, timecode: number, payload: Buffer): Buffer {
  return element(0xa3, Buffer.from([0x80 | track]), uint(timecode, 2), Buffer.from([0x80]), payload);
}

interface SyntheticStream {
  stream: Buffer;
  init: Buffer;
  clusterOffsets: number[];
}

interface SyntheticOptions {
  clusters?: number;
  segmentSize?: 'unknown' | 'known';
  clusterSize?: 'unknown' | 'known';
  videoCodec?: string;
  seed?: number;
}

// Mirrors Chrome's MediaRecorder layout: unknown-size Segment and Clusters.
function buildStream(options: SyntheticOptions = {}): SyntheticStream {
  const random = mulberry32(options.seed ?? 1);
  const header = ebmlHeader();
  const info = element(0x1549a966, element(0x2ad7b1, uint(1_000_000, 3)), element(0x4d80, Buffer.from('test')));
  const segmentChildren = [info, tracks(options.videoCodec ?? 'V_VP8'), element(0xec, Buffer.alloc(3))];

  const clusters: Buffer[] = [];
  for (let c = 0; c < (options.clusters ?? 4); c += 1) {
    const blocks: Buffer[] = [];
    for (let b = 0; b < 6; b += 1) {
      const payload = Buffer.alloc(20 + Math.floor(random() * 200));
      for (let i = 0; i < payload.length; i += 1) payload[i] = Math.floor(random() * 256);
      // Plant IDs the parser must not mistake for element boundaries.
      CLUSTER_ID_BYTES.copy(payload, 3);
      idBytes(EBML_HEADER_ID).copy(payload, 10);
      blocks.push(simpleBlock(b % 2 === 0 ? 1 : 2, b * 33, payload));
    }
    const children = Buffer.concat([element(0xe7, uint(c * 1000, 2)), ...blocks, element(0xec, Buffer.alloc(2))]);
    clusters.push(options.clusterSize === 'known'
      ? element(WEBM_CLUSTER_ID, children)
      : Buffer.concat([idBytes(WEBM_CLUSTER_ID), UNKNOWN_SIZE, children]));
  }

  const body = Buffer.concat([...segmentChildren, ...clusters]);
  const segmentHeader = Buffer.concat([
    idBytes(WEBM_SEGMENT_ID),
    options.segmentSize === 'known' ? sizeBytes(body.length, 8) : UNKNOWN_SIZE,
  ]);
  const init = Buffer.concat([header, segmentHeader, ...segmentChildren]);
  const clusterOffsets: number[] = [];
  let offset = init.length;
  for (const cluster of clusters) {
    clusterOffsets.push(offset);
    offset += cluster.length;
  }
  return { stream: Buffer.concat([header, segmentHeader, body]), init, clusterOffsets };
}

function trackChunks(chunks: Buffer[]) {
  const tracker = new WebmStreamTracker();
  const reported: number[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const { clusterStart } = tracker.push(chunk);
    if (clusterStart) reported.push(offset + clusterStart.offset - clusterStart.prefix.length);
    offset += chunk.length;
  }
  return { tracker, reported };
}

class Collector extends PassThrough {
  readonly parts: Buffer[] = [];

  constructor() {
    super();
    this.on('data', (chunk: Buffer) => this.parts.push(chunk));
  }

  get bytes(): Buffer {
    return Buffer.concat(this.parts);
  }
}

describe('readEbmlElementHeader', () => {
  it('reads IDs with their marker bits and known or unknown sizes', () => {
    assert.deepEqual(readEbmlElementHeader(Buffer.concat([idBytes(EBML_HEADER_ID), Buffer.from([0x9f])])), {
      id: EBML_HEADER_ID,
      size: 31,
      idLength: 4,
      headerLength: 5,
    });
    assert.deepEqual(readEbmlElementHeader(Buffer.concat([idBytes(WEBM_CLUSTER_ID), UNKNOWN_SIZE])), {
      id: WEBM_CLUSTER_ID,
      size: null,
      idLength: 4,
      headerLength: 12,
    });
    assert.deepEqual(readEbmlElementHeader(Buffer.from([0x00, 0xa3, 0x40, 0x02]), 1), {
      id: 0xa3,
      size: 2,
      idLength: 1,
      headerLength: 3,
    });
    // A one-byte all-ones size is also "unknown".
    assert.equal((readEbmlElementHeader(Buffer.from([0xa3, 0xff])) as { size: number | null }).size, null);
  });

  it('asks for more bytes until the header is complete and rejects invalid vints', () => {
    const header = Buffer.concat([idBytes(WEBM_CLUSTER_ID), UNKNOWN_SIZE]);
    for (let length = 0; length < header.length; length += 1) {
      assert.equal(readEbmlElementHeader(header.subarray(0, length)), 'incomplete');
    }
    assert.equal(readEbmlElementHeader(Buffer.from([0x00, 0x81])), 'invalid');
    assert.equal(readEbmlElementHeader(Buffer.from([0x08, 0x00, 0x00, 0x00, 0x00, 0x81])), 'invalid');
    assert.equal(readEbmlElementHeader(Buffer.from([0xa3, 0x00])), 'invalid');
  });
});

describe('WebmStreamTracker', () => {
  it('captures the init segment and every Cluster start from byte-sized chunks', () => {
    const { stream, init, clusterOffsets } = buildStream();
    const { tracker, reported } = trackChunks(splitRandomly(stream, 1, 1));
    assert.deepEqual(tracker.initSegment, init);
    assert.deepEqual(reported, clusterOffsets);
  });

  it('captures the same init segment wherever a single chunk boundary falls', () => {
    const { stream, init, clusterOffsets } = buildStream({ clusters: 2 });
    for (let cut = 1; cut < stream.length; cut += 1) {
      const { tracker, reported } = trackChunks(splitAt(stream, [cut]));
      assert.deepEqual(tracker.initSegment, init, `split at byte ${cut}`);
      // Each chunk reports its first Cluster, so both chunks together see at most two.
      for (const offset of reported) assert.ok(clusterOffsets.includes(offset), `split at byte ${cut}`);
      assert.ok(reported.includes(clusterOffsets[0]), `split at byte ${cut}`);
    }
  });

  it('captures the init segment from randomly sized chunks', () => {
    for (const layout of [{ clusterSize: 'unknown' }, { clusterSize: 'known' }] as const) {
      const { stream, init, clusterOffsets } = buildStream({ ...layout, clusters: 6, seed: 7 });
      for (let seed = 1; seed <= 200; seed += 1) {
        const { tracker, reported } = trackChunks(splitRandomly(stream, seed, 1 + (seed % 700)));
        assert.deepEqual(tracker.initSegment, init, `${layout.clusterSize} clusters, seed ${seed}`);
        assert.equal(reported[0], clusterOffsets[0]);
        for (const offset of reported) assert.ok(clusterOffsets.includes(offset));
      }
    }
  });

  it('ignores Cluster IDs that appear inside block and codec payloads', () => {
    const { stream, clusterOffsets } = buildStream({ clusters: 3 });
    let rawMatches = 0;
    for (let index = stream.indexOf(CLUSTER_ID_BYTES); index !== -1; index = stream.indexOf(CLUSTER_ID_BYTES, index + 1)) {
      rawMatches += 1;
    }
    assert.ok(rawMatches > clusterOffsets.length, 'fixture should contain decoy Cluster IDs');
    assert.deepEqual(trackChunks(splitRandomly(stream, 3, 1)).reported, clusterOffsets);
  });

  it('marks a known Segment size as unknown in the cached init segment', () => {
    const { stream, init } = buildStream({ segmentSize: 'known' });
    const { tracker } = trackChunks(splitRandomly(stream, 5, 9));
    const cached = tracker.initSegment;
    assert.ok(cached);
    const sizeOffset = ebmlHeader().length + 4;
    assert.deepEqual(cached.subarray(sizeOffset, sizeOffset + 8), UNKNOWN_SIZE);
    assert.deepEqual(cached.subarray(0, sizeOffset), init.subarray(0, sizeOffset));
    assert.deepEqual(cached.subarray(sizeOffset + 8), init.subarray(sizeOffset + 8));
  });

  it('resyncs on the next Cluster after corrupt bytes without losing the init segment', () => {
    const { stream, init, clusterOffsets } = buildStream({ clusters: 4 });
    const garbage = Buffer.from([0x00, 0x00, 0x1f, 0x43, 0x00, 0x00]);
    const corrupt = Buffer.concat([
      stream.subarray(0, clusterOffsets[2]),
      garbage,
      stream.subarray(clusterOffsets[2]),
    ]);
    const { tracker, reported } = trackChunks(splitRandomly(corrupt, 11, 1));
    assert.deepEqual(tracker.initSegment, init);
    assert.deepEqual(reported, [
      clusterOffsets[0],
      clusterOffsets[1],
      clusterOffsets[2] + garbage.length,
      clusterOffsets[3] + garbage.length,
    ]);
  });

  it('gives up on an init segment larger than the cap', () => {
    const header = ebmlHeader();
    const segmentHeader = Buffer.concat([idBytes(WEBM_SEGMENT_ID), UNKNOWN_SIZE]);
    const hugeVoid = element(0xec, Buffer.alloc(MAX_WEBM_INIT_SEGMENT_BYTES));
    const cluster = Buffer.concat([idBytes(WEBM_CLUSTER_ID), UNKNOWN_SIZE, element(0xe7, uint(0, 2))]);
    const { tracker } = trackChunks(splitRandomly(Buffer.concat([header, segmentHeader, hugeVoid, cluster]), 13, 64 * 1024));
    assert.equal(tracker.initSegment, null);
    assert.equal(tracker.joinPoint(), null);
  });

  it('replaces the init segment when the stream restarts with a new EBML header', () => {
    const first = buildStream({ clusters: 2 });
    const second = buildStream({ clusters: 2, videoCodec: 'V_VP9', seed: 2 });
    const { tracker, reported } = trackChunks(splitRandomly(Buffer.concat([first.stream, second.stream]), 17, 50));
    assert.deepEqual(tracker.initSegment, second.init);
    assert.ok(reported.includes(first.stream.length + second.clusterOffsets[0]));
  });
});

describe('WebmSinkFeed', () => {
  it('passes the whole stream through when joined before any media arrives', () => {
    const { stream } = buildStream();
    const tracker = new WebmStreamTracker();
    const output = new Collector();
    const feed = new WebmSinkFeed(output);
    assert.equal(feed.join(tracker), 'from-start');
    for (const chunk of splitRandomly(stream, 19, 300)) {
      assert.equal(feed.write(chunk, tracker.push(chunk)), true);
    }
    assert.deepEqual(output.bytes, stream);
  });

  it('replays the partial header to a consumer that joins before the first Cluster', () => {
    const { stream, init } = buildStream();
    const chunks = splitAt(stream, [7, 40, init.length - 5]);
    const tracker = new WebmStreamTracker();
    tracker.push(chunks[0]);
    tracker.push(chunks[1]);
    const output = new Collector();
    const feed = new WebmSinkFeed(output);
    assert.equal(feed.join(tracker), 'from-start');
    for (const chunk of chunks.slice(2)) feed.write(chunk, tracker.push(chunk));
    assert.deepEqual(output.bytes, stream);
  });

  it('resumes a respawned consumer with the init segment and the next whole Cluster', () => {
    for (const layout of [{ clusterSize: 'unknown' }, { clusterSize: 'known' }] as const) {
      const { stream, init, clusterOffsets } = buildStream({ ...layout, clusters: 6, seed: 23 });
      for (let seed = 1; seed <= 25; seed += 1) {
        const chunks = splitRandomly(stream, seed, 1 + seed * 37);
        const firstClusterChunk = chunks.findIndex((_, i) =>
          chunks.slice(0, i + 1).reduce((sum, chunk) => sum + chunk.length, 0) > clusterOffsets[0] + 12);
        for (let joinAfter = firstClusterChunk + 1; joinAfter < chunks.length; joinAfter += 1) {
          const tracker = new WebmStreamTracker();
          let joinedAt = 0;
          for (const chunk of chunks.slice(0, joinAfter)) {
            tracker.push(chunk);
            joinedAt += chunk.length;
          }

          const output = new Collector();
          const feed = new WebmSinkFeed(output);
          assert.equal(feed.join(tracker), 'resync');
          for (const chunk of chunks.slice(joinAfter)) feed.write(chunk, tracker.push(chunk));

          // The consumer starts at the first Cluster whose header was still
          // incomplete when it joined; partial-cluster bytes are dropped.
          const resumeAt = clusterOffsets.find((offset) => {
            const header = readEbmlElementHeader(stream, offset);
            return header !== 'incomplete' && header !== 'invalid' && offset + header.headerLength > joinedAt;
          });
          const context = `${layout.clusterSize} clusters, seed ${seed}, joined after byte ${joinedAt}`;
          if (resumeAt === undefined) {
            assert.deepEqual(output.bytes, init, context);
            assert.equal(feed.awaitingCluster, true, context);
          } else {
            assert.deepEqual(output.bytes, Buffer.concat([init, stream.subarray(resumeAt)]), context);
            assert.equal(feed.awaitingCluster, false, context);
          }
        }
      }
    }
  });

  it('keeps other consumers byte-identical while one of them rejoins', () => {
    const { stream, init, clusterOffsets } = buildStream({ clusters: 5 });
    const chunks = splitRandomly(stream, 29, 150);
    const tracker = new WebmStreamTracker();
    const steady = new Collector();
    const steadyFeed = new WebmSinkFeed(steady);
    const original = new Collector();
    const originalFeed = new WebmSinkFeed(original);
    steadyFeed.join(tracker);
    originalFeed.join(tracker);

    const killAfter = Math.floor(chunks.length / 2);
    const respawned = new Collector();
    const respawnedFeed = new WebmSinkFeed(respawned);
    for (const [index, chunk] of chunks.entries()) {
      if (index === killAfter) assert.equal(respawnedFeed.join(tracker), 'resync');
      const info = tracker.push(chunk);
      steadyFeed.write(chunk, info);
      if (index < killAfter) originalFeed.write(chunk, info);
      else respawnedFeed.write(chunk, info);
    }

    assert.deepEqual(steady.bytes, stream);
    const resumed = respawned.bytes;
    assert.deepEqual(resumed.subarray(0, init.length), init);
    const resumeAt = stream.length - (resumed.length - init.length);
    assert.ok(clusterOffsets.includes(resumeAt));
  });

  it('reports no-init when the stream never had a parseable header', () => {
    const tracker = new WebmStreamTracker();
    tracker.push(Buffer.from('not a webm stream at all'));
    const output = new Collector();
    assert.equal(new WebmSinkFeed(output).join(tracker), 'no-init');
    assert.equal(output.bytes.length, 0);
  });

  it('contains EPIPE from a consumer that closed its input', async () => {
    // The child closes its stdin but stays alive, the window in which a dying
    // FFmpeg still receives writes before its close event.
    const child = spawn(process.execPath, ['-e', "require('fs').closeSync(0); setTimeout(() => {}, 1000)"], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const errors: Error[] = [];
    const feed = new WebmSinkFeed(child.stdin, (err) => errors.push(err));
    const tracker = new WebmStreamTracker();
    const { stream } = buildStream();

    const deadline = Date.now() + 5_000;
    while (errors.length === 0 && Date.now() < deadline) {
      feed.write(stream, tracker.push(stream));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(errors[0]?.message ?? '', /EPIPE|EOF|destroyed/);
    assert.equal(feed.write(stream, tracker.push(stream)), false);
    child.kill();
    await once(child, 'close');
  });
});
