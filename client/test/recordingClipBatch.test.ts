import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ClipSuggestion } from "../src/utils/clipSuggestions.ts";
import { getBatchClipIssue, MAX_BATCH_CLIPS, renderClipBatch, type ClipBatchEntry } from "../src/utils/recordingClipBatch.ts";
import { captureRecordingClip } from "../src/utils/recordingClips.ts";

function highlight(id: string, startSeconds = 0, endSeconds = 5): ClipSuggestion {
  return { id, startSeconds, endSeconds, label: id, score: 1, reason: "marker" };
}

test("renders highlights serially and keeps successful clips around a failed one", async () => {
  const entries = new Map<string, ClipBatchEntry<string>>();
  const events: string[] = [];
  const controller = new AbortController();
  const clips = ["Intro", "Story", "Closing"].map((id) => highlight(id));
  let running = 0;
  const render = async (clip: ClipSuggestion, onProgress: (value: number) => void, signal: AbortSignal) => {
    assert.equal(signal, controller.signal);
    assert.equal(++running, 1);
    events.push(`start ${clip.id}`);
    onProgress(0.51);
    assert.deepEqual(entries.get(clip.id), { clip, status: "rendering", progress: 51 });
    await Promise.resolve();
    running -= 1;
    events.push(`end ${clip.id}`);
    if (clip.id === "Story") throw new Error("Encoding failed");
    return clip.label;
  };
  const update = (entry: ClipBatchEntry<string>) => { entries.set(entry.clip.id, entry); };
  await renderClipBatch(clips, render, update, controller.signal);
  assert.deepEqual(events, ["start Intro", "end Intro", "start Story", "end Story", "start Closing", "end Closing"]);
  assert.deepEqual(Array.from(entries.values(), (entry) => entry.status), ["ready", "failed", "ready"]);
  assert.deepEqual(entries.get("Story"), { clip: clips[1], status: "failed", error: "Encoding failed" });

  const original = entries.get("Intro");
  await renderClipBatch([clips[1]], async () => "Retried story", update, controller.signal);
  assert.equal(entries.get("Intro"), original);
  assert.deepEqual(entries.get("Story"), { clip: clips[1], status: "ready", output: "Retried story" });
});

test("aborting stops the current render and never starts queued clips", async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const entries = new Map<string, ClipBatchEntry<string>>();
  const clips = ["First", "Second", "Third"].map((id) => highlight(id));
  await renderClipBatch(clips, async (clip, progress, signal) => {
    started.push(clip.id);
    progress(0.25);
    controller.abort();
    signal.throwIfAborted();
    return "unexpected";
  }, (entry) => { entries.set(entry.clip.id, entry); }, controller.signal);
  assert.deepEqual(started, ["First"]);
  assert.deepEqual(Array.from(entries.values(), (entry) => entry.status), ["stopped", "stopped", "stopped"]);
});

test("rejects oversized queues and records invalid ranges without calling the renderer", async () => {
  assert.match(getBatchClipIssue(highlight("Long", 0, 91)) || "", /90-second/);
  assert.equal(getBatchClipIssue(highlight("Allowed", 0, 90)), null);
  const signal = new AbortController().signal;
  const render = async () => assert.fail("This renderer should remain idle");
  await assert.rejects(renderClipBatch(
    Array.from({ length: MAX_BATCH_CLIPS + 1 }, (_, index) => highlight(String(index))),
    render, () => {}, signal,
  ), /six different/);
  await assert.rejects(renderClipBatch([highlight("Same"), highlight("Same")], render, () => {}, signal), /six different/);
  await renderClipBatch([highlight("Invalid", 4, 2)], render, (entry) => {
    assert.equal(entry.status, "failed");
  }, signal);
});

test("an already cancelled clip avoids initialising the media pipeline", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureRecordingClip(
    { blob: new Blob(["source"]), hasVideo: true, aspect: "vertical" },
    { startSeconds: 0, endSeconds: 5 }, undefined, { signal: controller.signal },
  ), { name: "AbortError" });
});
