import test from "node:test";
import assert from "node:assert/strict";
import { inspectPacketTimeline } from "../e2e/recording-metrics.mjs";

function fixture({ audioEnd = 1.99, videoEnd = 1.98 } = {}) {
  return {
    streams: [{ index: 0, codec_type: "video" }, { index: 1, codec_type: "audio" }],
    packets: [
      ...[0, 0.5, 1, 1.5, videoEnd].map(pts => ({ stream_index: 0, pts_time: String(pts), duration_time: "0.02" })),
      ...[0, 0.5, 1, 1.5, audioEnd].map(pts => ({ stream_index: 1, pts_time: String(pts), duration_time: "0.01" })),
    ],
  };
}

test("recording soak checks actual encoded A/V packet spans", () => {
  const result = inspectPacketTimeline(fixture(), { minimumSeconds: 2 });
  assert.equal(result.avDriftMs, 0);
  assert.equal(result.timelines.length, 2);
  assert.equal(result.timelines[0].maxGapSeconds, 0.5);
});

test("recording soak rejects missing tracks and non-finite timestamps", () => {
  assert.throws(() => inspectPacketTimeline({ streams: [], packets: [] }), /encoded audio or video/);
  const probe = fixture();
  probe.packets[1].pts_time = "N/A";
  assert.throws(() => inspectPacketTimeline(probe), /finite presentation timestamp/);
});

test("recording soak rejects timestamp regressions rather than sorting them away", () => {
  const probe = fixture();
  probe.packets[2].pts_time = "0.4";
  assert.throws(() => inspectPacketTimeline(probe), /timestamp regressed/);
});

test("recording soak rejects packet gaps above one second", () => {
  const probe = fixture();
  probe.packets[2].pts_time = "1.6";
  assert.throws(() => inspectPacketTimeline(probe), /packet gap/);
});

test("recording soak fails at forty milliseconds of A/V drift", () => {
  assert.throws(() => inspectPacketTimeline(fixture({ audioEnd: 2.04 })), /media-clock drift/);
  assert.throws(() => inspectPacketTimeline(fixture({ audioEnd: 2.03 })), /media-clock drift/);
});

test("recording soak fails when a capture ends early", () => {
  assert.throws(() => inspectPacketTimeline(fixture(), { minimumSeconds: 1200 }), /expected at least 1200/);
});

test("recording soak ignores a fixed initial A/V offset when measuring drift", () => {
  const probe = fixture();
  for (const packet of probe.packets.filter(packet => packet.stream_index === 1)) packet.pts_time = String(Number(packet.pts_time) + 0.15);
  assert.ok(inspectPacketTimeline(probe).avDriftMs < 1e-6);
});


test("recording soak rejects absent or empty timestamps rather than coercing them to zero", () => {
  for (const value of [null, undefined, "", " "]) {
    const probe = fixture();
    probe.packets[0].pts_time = value;
    assert.throws(() => inspectPacketTimeline(probe), /numeric presentation timestamp/);
  }
});
