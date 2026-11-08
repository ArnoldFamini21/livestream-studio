import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Inspect encoded media timestamps, not MediaRecorder dataavailable arrival times
 * (those events batch frames and cannot establish A/V continuity). PTS is checked
 * for the Chrome VP8/VP9/AAC/Opus captures used by the soak; this intentionally
 * rejects reordered PTS rather than silently sorting damaged/repeated packets.
 */
export function inspectPacketTimeline(probe, { maxGapSeconds = 1, maxDriftMs = 40, minimumSeconds = 0 } = {}) {
  const streams = (probe.streams || []).filter(stream => ["audio", "video"].includes(stream.codec_type));
  assert.ok(streams.length, "recording contains an encoded audio or video stream");
  const timelines = streams.map(stream => {
    const packets = (probe.packets || []).filter(packet => packet.stream_index === stream.index);
    assert.ok(packets.length > 1, `stream ${stream.index} contains multiple packets`);
    let previous = null;
    let maxGap = 0;
    const positiveDeltas = [];
    for (const packet of packets) {
      assert.ok((typeof packet.pts_time === "number" || typeof packet.pts_time === "string") && String(packet.pts_time).trim() !== "", `stream ${stream.index} has a numeric presentation timestamp`);
      const pts = Number(packet.pts_time);
      assert.ok(Number.isFinite(pts), `stream ${stream.index} has a finite presentation timestamp`);
      if (previous !== null) {
        assert.ok(pts >= previous, `stream ${stream.index} timestamp regressed from ${previous} to ${pts}`);
        const gap = pts - previous;
        maxGap = Math.max(maxGap, gap);
        if (gap > 0) positiveDeltas.push(gap);
        assert.ok(gap <= maxGapSeconds + 1e-6, `stream ${stream.index} has a ${gap.toFixed(3)}s packet gap (limit ${maxGapSeconds}s)`);
      }
      previous = pts;
    }
    positiveDeltas.sort((a, b) => a - b);
    const typicalDuration = positiveDeltas[Math.floor(positiveDeltas.length / 2)] || 0;
    const first = Number(packets[0].pts_time);
    const lastPacket = packets.at(-1);
    const last = Number(lastPacket.pts_time);
    const packetDuration = Number(lastPacket.duration_time);
    const end = last + (Number.isFinite(packetDuration) && packetDuration > 0 ? packetDuration : typicalDuration);
    const spanSeconds = end - first;
    assert.ok(spanSeconds >= minimumSeconds, `stream ${stream.index} recorded ${spanSeconds.toFixed(3)}s, expected at least ${minimumSeconds}s`);
    return { index: stream.index, kind: stream.codec_type, packets: packets.length, firstSeconds: first, endSeconds: end, spanSeconds, maxGapSeconds: maxGap };
  });
  const video = timelines.find(stream => stream.kind === "video");
  const audio = timelines.find(stream => stream.kind === "audio");
  // Remove the initial A/V offset: drift is the change in relative media-clock
  // position during the take. This is not a real-camera lip-sync measurement.
  const avDriftMs = video && audio ? Math.abs(video.spanSeconds - audio.spanSeconds) * 1000 : null;
  if (avDriftMs !== null) assert.ok(avDriftMs < maxDriftMs - 1e-6, `A/V media-clock drift ${avDriftMs.toFixed(3)}ms exceeds ${maxDriftMs}ms`);
  return { timelines, avDriftMs, initialAvOffsetMs: video && audio ? (video.firstSeconds - audio.firstSeconds) * 1000 : null, finalAvOffsetMs: video && audio ? (video.endSeconds - audio.endSeconds) * 1000 : null };
}

export async function probeRecording(file, options = {}) {
  const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-show_packets", "-show_streams", "-show_entries",
    "packet=stream_index,pts_time,duration_time:stream=index,codec_type", "-of", "json", file,
  ], { maxBuffer: 128 * 1024 * 1024 });
  return inspectPacketTimeline(JSON.parse(stdout), options);
}
