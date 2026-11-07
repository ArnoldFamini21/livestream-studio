import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCropPath,
  buildSpeakerActivity,
  chooseCropTarget,
  sampleCropPath,
  type FaceBox,
  type FaceSample,
} from '../src/utils/clipSmartCrop.ts';
import { buildClipCaptionCues, findActiveCue, layoutCaptionLines } from '../src/utils/clipCaptions.ts';
import { getClipCanvasSize, getClipDrawRect } from '../src/utils/recordingClips.ts';
import { planFaceSampleTimes, toFaceBoxes } from '../src/utils/clipFaceAnalysis.ts';

// A 9:16 crop of a 16:9 frame is 0.316 of its width.
const CROP_WIDTH = (720 * 9 / 16) / 1280;

function face(centerX: number, size = 0.12): FaceBox {
  return { x: centerX - size / 2, y: 0.3, width: size, height: size * 1.6 };
}

function samples(duration: number, facesAt: (seconds: number) => FaceBox[]): FaceSample[] {
  const list: FaceSample[] = [];
  for (let t = 0; t < duration; t += 0.5) list.push({ seconds: t, faces: facesAt(t) });
  return list;
}

describe('smart crop targets', () => {
  it('follows one face, frames close faces together and holds when nobody is visible', () => {
    assert.equal(chooseCropTarget([face(0.7)], null, CROP_WIDTH, null, 0)?.x, 0.7);
    const together = chooseCropTarget([face(0.45, 0.08), face(0.6, 0.08)], null, CROP_WIDTH, null, 0);
    assert.ok(Math.abs((together?.x ?? 0) - 0.525) < 1e-9);
    assert.equal(chooseCropTarget([], null, CROP_WIDTH, null, 0), null);
  });

  it('picks the talking person when two faces do not fit, and stays put otherwise', () => {
    const faces = [face(0.25), face(0.75)];
    assert.equal(chooseCropTarget(faces, null, CROP_WIDTH, 1, 2)?.x, 0.75);
    assert.equal(chooseCropTarget(faces, null, CROP_WIDTH, 0, 2)?.x, 0.25);
    assert.equal(chooseCropTarget(faces, { x: 0.7, y: 0.5 }, CROP_WIDTH, null, 0)?.x, 0.75);
    // No faces at all: frame the active speaker's slot of the layout.
    assert.equal(chooseCropTarget([], null, CROP_WIDTH, 1, 2)?.x, 0.75);
  });

  it('builds a smooth path that glides to a new speaker and ignores a one-sample flicker', () => {
    const path = buildCropPath(
      samples(10, (t) => (t === 3 ? [face(0.9)] : t < 5 ? [face(0.3)] : [face(0.7)])),
      { cropWidth: CROP_WIDTH, cropHeight: 1, durationSeconds: 10 }
    );
    assert.ok(Math.abs(sampleCropPath(path, 2).x - 0.3) < 0.02, 'settled on the first face');
    assert.ok(Math.abs(sampleCropPath(path, 3.2).x - 0.3) < 0.02, 'a single stray detection is filtered out');
    assert.ok(Math.abs(sampleCropPath(path, 9).x - 0.7) < 0.02, 'settled on the second face');
    let maxStep = 0;
    for (let t = 0.1; t <= 10; t += 0.1) {
      maxStep = Math.max(maxStep, Math.abs(sampleCropPath(path, t).x - sampleCropPath(path, t - 0.1).x));
    }
    assert.ok(maxStep < 0.12, `no jump cuts (largest 0.1 s move ${maxStep.toFixed(3)})`);
    const halfway = sampleCropPath(path, 5).x;
    assert.ok(halfway > 0.35 && halfway < 0.68, `mid-glide at the switch (${halfway.toFixed(3)})`);
  });

  it('keeps the crop inside the frame', () => {
    const path = buildCropPath(samples(4, () => [face(0.02, 0.04)]), { cropWidth: CROP_WIDTH, cropHeight: 1, durationSeconds: 4 });
    for (const x of path.centersX) assert.ok(x >= CROP_WIDTH / 2 - 1e-9);
    const rect = getClipDrawRect(1280, 720, 406, 720, sampleCropPath(path, 2));
    assert.equal(rect.sx, 0);
    const right = getClipDrawRect(1280, 720, 406, 720, { x: 0.99, y: 0.5 });
    assert.ok(Math.abs(right.sx + right.sw - 1280) < 1e-6);
    const centred = getClipDrawRect(1280, 720, 406, 720);
    assert.ok(Math.abs(centred.sx - (1280 - centred.sw) / 2) < 1e-6);
  });

  it('reads the loudest participant per step from track levels', () => {
    const activity = buildSpeakerActivity([[0.2, 0.001, 0.05], [0.05, 0.002, 0.3]], 0.5);
    assert.deepEqual(activity.samples.map((sample) => sample.activeSlot), [0, null, 1]);
    assert.equal(activity.slotCount, 2);
  });

  it('plans bounded face sampling and converts detector boxes', () => {
    assert.equal(planFaceSampleTimes(10).length, 20);
    assert.equal(planFaceSampleTimes(600).length, 240);
    assert.deepEqual(planFaceSampleTimes(0), []);
    assert.deepEqual(
      toFaceBoxes([{ boundingBox: { originX: 48, originY: 27, width: 96, height: 54 }, categories: [{ score: 0.9 }] }], 480, 270),
      [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2, score: 0.9 }]
    );
    assert.deepEqual(getClipCanvasSize(1280, 720, 'vertical'), { width: 406, height: 720 });
  });
});

describe('burned-in clip captions', () => {
  const words = [
    { word: 'Before', start: 8, end: 9.5 },
    { word: 'So', start: 10.2, end: 10.4 },
    { word: 'the', start: 10.4, end: 10.5 },
    { word: 'biggest', start: 10.5, end: 10.9 },
    { word: 'lesson', start: 10.9, end: 11.3 },
    { word: 'was', start: 11.3, end: 11.5 },
    { word: 'patience.', start: 11.5, end: 12.1 },
    { word: 'Really', start: 13.5, end: 13.9 },
    { word: 'after', start: 21, end: 22 },
  ];

  it('re-times words to the clip and groups them into short cues', () => {
    const cues = buildClipCaptionCues(words, { startSeconds: 10, endSeconds: 20 });
    assert.deepEqual(cues.map((cue) => cue.words.map((word) => word.text).join(' ')), ['So the biggest lesson was', 'patience.', 'Really']);
    assert.ok(Math.abs(cues[0].start - 0.2) < 1e-9);
    assert.ok(cues[0].end <= cues[1].start + 1e-9, 'cues do not overlap');
    assert.ok(cues[2].end <= 10);
    assert.equal(findActiveCue(cues, 0.5)?.words[0].text, 'So');
    assert.equal(findActiveCue(cues, 5), null);
  });

  it('wraps a cue onto two lines when it is too wide', () => {
    const measure = { measureText: (text: string) => ({ width: text.length * 10 }) };
    assert.deepEqual(layoutCaptionLines(measure, ['one', 'two', 'three'], 80), [['one', 'two'], ['three']]);
    assert.deepEqual(layoutCaptionLines(measure, ['short'], 80), [['short']]);
  });
});
