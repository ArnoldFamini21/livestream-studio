import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { WebmSinkFeed, type WebmChunkInfo } from './webmStream.js';
import { FlvSinkFeed, FlvTagStream, describeFlvTag } from './flvStream.js';
import {
  bytesForSeconds,
  createFfmpegEncoderArgs,
  createFfmpegPushArgs,
  isEncodeOnceEnabled,
} from './rtmp.js';

/** A consumer whose queue length the test controls, like a stalled FFmpeg. */
class FakeOutput extends EventEmitter {
  writable = true;
  writableLength = 0;
  written: Buffer[] = [];
  write(chunk: Buffer) {
    this.written.push(Buffer.from(chunk));
    return true;
  }
  text() {
    return Buffer.concat(this.written).toString('latin1');
  }
}

const noCluster: WebmChunkInfo = { clusterStart: null };
const clusterAt = (offset: number, prefix = Buffer.alloc(0)): WebmChunkInfo => ({ clusterStart: { prefix, offset } });

describe('WebM feed backpressure', () => {
  it('writes everything when unbounded', () => {
    const output = new FakeOutput();
    const feed = new WebmSinkFeed(output as unknown as Writable);
    output.writableLength = 10_000_000;
    assert.equal(feed.write(Buffer.from('aaaa'), noCluster), true);
    assert.equal(output.text(), 'aaaa');
    assert.equal(feed.overflowCount, 0);
  });

  it('finishes the current Cluster, skips until drained, and resumes at a Cluster boundary', () => {
    const output = new FakeOutput();
    const events: string[] = [];
    const feed = new WebmSinkFeed(output as unknown as Writable, undefined, {
      maxBufferedBytes: 100,
      onOverflow: () => events.push('overflow'),
      onRecover: (dropped) => events.push(`recover:${dropped}`),
    });

    feed.write(Buffer.from('AAAA'), noCluster);
    output.writableLength = 101;
    // Mid-Cluster: keep writing so no block is torn.
    assert.equal(feed.write(Buffer.from('BBBB'), noCluster), true);
    assert.equal(feed.skipping, true);
    // The next Cluster starts at offset 2: the tail of the old one is kept.
    assert.equal(feed.write(Buffer.from('bbCC'), clusterAt(2)), true);
    // Still over half the limit: whole Clusters are skipped.
    output.writableLength = 80;
    assert.equal(feed.write(Buffer.from('DDDD'), clusterAt(0)), false);
    // Drained: resume from the next Cluster start.
    output.writableLength = 40;
    assert.equal(feed.write(Buffer.from('eeFF'), noCluster), false);
    assert.equal(feed.write(Buffer.from('ffGG'), clusterAt(2)), true);
    assert.equal(feed.skipping, false);

    assert.equal(output.text(), 'AAAABBBBbbGG');
    assert.deepEqual(events, ['overflow', 'recover:12']);
    assert.equal(feed.droppedBytes, 12);
    assert.equal(feed.overflowCount, 1);
  });

  it('does not cut at a Cluster whose header began in an earlier, already-written chunk', () => {
    const output = new FakeOutput();
    const feed = new WebmSinkFeed(output as unknown as Writable, undefined, { maxBufferedBytes: 10 });
    output.writableLength = 11;
    assert.equal(feed.write(Buffer.from('XXXX'), clusterAt(1, Buffer.from('p'))), true);
    assert.equal(feed.write(Buffer.from('YYZZ'), clusterAt(2)), true);
    output.writableLength = 0;
    feed.write(Buffer.from('QQ'), clusterAt(0));
    assert.equal(output.text(), 'XXXXYYQQ');
  });
});

function flvTag(type: number, data: number[], timestamp = 0): Buffer {
  const body = Buffer.from(data);
  const tag = Buffer.alloc(11 + body.length + 4);
  tag[0] = type;
  tag.writeUIntBE(body.length, 1, 3);
  tag.writeUIntBE(timestamp & 0xffffff, 4, 3);
  body.copy(tag, 11);
  tag.writeUInt32BE(11 + body.length, 11 + body.length);
  return tag;
}

const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0]);
const META = flvTag(18, [0x02, 0x00, 0x0a]);
const AVC_CONFIG = flvTag(9, [0x17, 0x00, 1, 2, 3]);
const AAC_CONFIG = flvTag(8, [0xaf, 0x00, 0x12, 0x10]);
const keyframe = (ts: number) => flvTag(9, [0x17, 0x01, 0xaa], ts);
const interframe = (ts: number) => flvTag(9, [0x27, 0x01, 0xbb], ts);
const audio = (ts: number) => flvTag(8, [0xaf, 0x01, 0xcc], ts);

describe('FLV tag stream', () => {
  it('classifies keyframes and sequence headers', () => {
    assert.equal(describeFlvTag(keyframe(0)).keyframe, true);
    assert.equal(describeFlvTag(interframe(0)).keyframe, false);
    assert.equal(describeFlvTag(AVC_CONFIG).sequenceHeader, true);
    assert.equal(describeFlvTag(AAC_CONFIG).sequenceHeader, true);
    assert.equal(describeFlvTag(audio(0)).sequenceHeader, false);
  });

  it('emits whole tags across arbitrary chunk splits and caches the init segment', () => {
    const stream = new FlvTagStream();
    const all = Buffer.concat([FLV_HEADER, META, AVC_CONFIG, AAC_CONFIG, keyframe(0), audio(10), interframe(33), keyframe(66)]);
    const out: Buffer[] = [];
    const keyframeOffsets: number[] = [];
    let emitted = 0;
    for (let i = 0; i < all.length; i += 7) {
      const chunk = stream.push(all.subarray(i, i + 7));
      if (!chunk) continue;
      if (chunk.keyframeOffset !== null) keyframeOffsets.push(emitted + chunk.keyframeOffset);
      emitted += chunk.bytes.length;
      out.push(chunk.bytes);
    }
    assert.deepEqual(Buffer.concat(out), all);
    const firstKeyframe = FLV_HEADER.length + META.length + AVC_CONFIG.length + AAC_CONFIG.length;
    assert.equal(keyframeOffsets[0], firstKeyframe);
    assert.deepEqual(stream.initSegment, Buffer.concat([FLV_HEADER, META, AVC_CONFIG, AAC_CONFIG]));
  });

  it('marks non-FLV input as unhealthy', () => {
    const stream = new FlvTagStream();
    assert.equal(stream.push(Buffer.from('not an flv stream')), null);
    assert.equal(stream.healthy, false);
  });
});

describe('FLV feed', () => {
  function started() {
    const stream = new FlvTagStream();
    const first = stream.push(Buffer.concat([FLV_HEADER, META, AVC_CONFIG, AAC_CONFIG, keyframe(0)]))!;
    return { stream, first };
  }

  it('reads from the start when it joins before the encoder writes', () => {
    const stream = new FlvTagStream();
    const output = new FakeOutput();
    const feed = new FlvSinkFeed(output as unknown as Writable, stream);
    assert.equal(feed.join(), 'from-start');
    const chunk = stream.push(Buffer.concat([FLV_HEADER, META, AVC_CONFIG, keyframe(0)]))!;
    assert.equal(feed.write(chunk), true);
    assert.deepEqual(Buffer.concat(output.written), chunk.bytes);
  });

  it('joins late with the init segment at the next keyframe', () => {
    const { stream } = started();
    const output = new FakeOutput();
    const feed = new FlvSinkFeed(output as unknown as Writable, stream);
    assert.equal(feed.join(), 'resync');
    assert.equal(feed.write(stream.push(Buffer.concat([interframe(33), audio(40)]))!), false);
    const withKey = stream.push(Buffer.concat([audio(60), keyframe(66), interframe(99)]))!;
    assert.equal(feed.write(withKey), true);
    assert.deepEqual(
      Buffer.concat(output.written),
      Buffer.concat([stream.initSegment!, keyframe(66), interframe(99)])
    );
  });

  it('skips a slow destination ahead to a keyframe once it drains', () => {
    const { stream, first } = started();
    const output = new FakeOutput();
    const events: string[] = [];
    const feed = new FlvSinkFeed(output as unknown as Writable, stream, {
      maxBufferedBytes: 1000,
      onOverflow: () => events.push('overflow'),
      onRecover: () => events.push('recover'),
    });
    feed.join();
    assert.equal(feed.write(first), true);
    output.writableLength = 1001;
    assert.equal(feed.write(stream.push(interframe(33))!), false);
    assert.equal(feed.skipping, true);
    output.writableLength = 600;
    assert.equal(feed.write(stream.push(keyframe(66))!), false, 'waits until half the limit');
    output.writableLength = 400;
    assert.equal(feed.write(stream.push(interframe(99))!), false, 'waits for a keyframe');
    assert.equal(feed.write(stream.push(Buffer.concat([audio(120), keyframe(133)]))!), true);
    assert.deepEqual(events, ['overflow', 'recover']);
    assert.deepEqual(output.written.at(-1), keyframe(133));
    assert.equal(feed.overflowCount, 1);
  });
});

describe('encode-once FFmpeg arguments', () => {
  const options = {
    video: { width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 4_000_000 },
    audio: { sampleRate: 48_000, channelCount: 2, audioBitsPerSecond: 128_000 },
  };

  it('encodes once to FLV on stdout and copies per destination', () => {
    const encoder = createFfmpegEncoderArgs(options);
    assert.ok(encoder.includes('libx264'));
    assert.deepEqual(encoder.slice(-3), ['-f', 'flv', 'pipe:1']);
    const push = createFfmpegPushArgs({ id: 'yt', name: 'YouTube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', streamKey: 'key' });
    assert.ok(!push.includes('libx264'), 'destinations never re-encode');
    assert.deepEqual(push.slice(push.indexOf('-c'), push.indexOf('-c') + 2), ['-c', 'copy']);
    assert.equal(push.at(-1), 'rtmp://a.rtmp.youtube.com/live2/key');
  });

  it('sizes backlogs in seconds of media and defaults encode-once on', () => {
    assert.equal(bytesForSeconds(2, options), Math.round((4_128_000 / 8) * 2));
    assert.equal(isEncodeOnceEnabled({}), true);
    assert.equal(isEncodeOnceEnabled({ RTMP_ENCODE_ONCE: 'false' }), false);
    assert.equal(isEncodeOnceEnabled({ RTMP_ENCODE_ONCE: '0' }), false);
  });
});
