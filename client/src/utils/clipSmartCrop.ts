/**
 * Speaker-aware reframing for vertical and square clips ("Magic Clips").
 *
 * Inputs are face boxes sampled about every 0.5 s (MediaPipe FaceDetector,
 * see clipFaceAnalysis.ts) and, for multi-person program tracks, who was
 * talking from the per-participant audio tracks' loudness. Each sample picks
 * a target crop centre; the path is then cleaned (median filter, dead zone)
 * and eased with a critically damped spring that looks slightly ahead, so the
 * frame glides to a new speaker instead of jumping or lagging behind.
 * Coordinates are fractions of the source frame (0..1).
 */

export interface FaceBox {
  /** Left/top edge and size as fractions of the frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  score?: number;
}

export interface FaceSample {
  /** Seconds from the clip start. */
  seconds: number;
  faces: FaceBox[];
}

export interface SpeakerActivitySample {
  seconds: number;
  /** Index of the loudest participant track above the speech threshold, or null for silence. */
  activeSlot: number | null;
}

export interface SpeakerActivity {
  slotCount: number;
  samples: SpeakerActivitySample[];
}

export interface CropPath {
  /** Seconds from the clip start, evenly spaced. */
  times: number[];
  centersX: number[];
  centersY: number[];
}

export interface CropPathOptions {
  /** Width of the crop window as a fraction of the source width. */
  cropWidth: number;
  /** Height of the crop window as a fraction of the source height. */
  cropHeight: number;
  durationSeconds: number;
  activity?: SpeakerActivity | null;
  /** Output resolution of the path. */
  stepSeconds?: number;
  /** Spring stiffness (rad/s); ~6 settles in under a second. */
  omega?: number;
  /** How far ahead the spring aims, to cancel its lag. */
  lookaheadSeconds?: number;
  /** Target moves smaller than this (fraction of the frame) are ignored. */
  deadZone?: number;
}

function center(box: FaceBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Where one sample wants the crop centred, or null when it has no opinion
 * (no faces and no speech), in which case the previous target holds.
 */
export function chooseCropTarget(
  faces: FaceBox[],
  previous: { x: number; y: number } | null,
  cropWidth: number,
  activeSlot: number | null,
  slotCount: number
): { x: number; y: number } | null {
  const sorted = faces
    .filter((face) => face.width > 0 && face.height > 0)
    .sort((a, b) => center(a).x - center(b).x);
  if (sorted.length === 0) {
    if (activeSlot !== null && slotCount > 0) return { x: (activeSlot + 0.5) / slotCount, y: previous?.y ?? 0.5 };
    return null;
  }
  if (sorted.length === 1) return center(sorted[0]);
  if (activeSlot !== null && sorted.length === slotCount && sorted[activeSlot]) return center(sorted[activeSlot]);
  const left = Math.min(...sorted.map((face) => face.x));
  const right = Math.max(...sorted.map((face) => face.x + face.width));
  if (right - left <= cropWidth * 0.9) {
    const top = Math.min(...sorted.map((face) => face.y));
    const bottom = Math.max(...sorted.map((face) => face.y + face.height));
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
  if (previous) {
    // Stay with whoever is closest to where the frame already is.
    let nearest = sorted[0];
    for (const face of sorted) {
      if (Math.abs(center(face).x - previous.x) < Math.abs(center(nearest).x - previous.x)) nearest = face;
    }
    return center(nearest);
  }
  const largest = sorted.reduce((best, face) => (face.width * face.height > best.width * best.height ? face : best), sorted[0]);
  return center(largest);
}

function activeSlotAt(activity: SpeakerActivity | null | undefined, seconds: number): number | null {
  if (!activity || activity.samples.length === 0) return null;
  let best = activity.samples[0];
  for (const sample of activity.samples) {
    if (Math.abs(sample.seconds - seconds) < Math.abs(best.seconds - seconds)) best = sample;
  }
  return Math.abs(best.seconds - seconds) <= 1 ? best.activeSlot : null;
}

function median3(values: number[]): number[] {
  return values.map((value, index) => {
    if (index === 0 || index === values.length - 1) return value;
    const window = [values[index - 1], value, values[index + 1]].sort((a, b) => a - b);
    return window[1];
  });
}

function applyDeadZone(values: number[], deadZone: number): number[] {
  const output: number[] = [];
  let held = values[0];
  for (const value of values) {
    if (Math.abs(value - held) > deadZone) held = value;
    output.push(held);
  }
  return output;
}

function valueAt(times: number[], values: number[], seconds: number): number {
  if (values.length === 0) return 0.5;
  if (seconds <= times[0]) return values[0];
  for (let index = 1; index < times.length; index += 1) {
    if (seconds <= times[index]) {
      // Targets are steps: the latest decision holds until the next sample.
      return values[index - 1];
    }
  }
  return values[values.length - 1];
}

/** Critically damped spring following a step target, sampled every `stepSeconds`. */
function springFollow(
  targetAt: (seconds: number) => number,
  durationSeconds: number,
  stepSeconds: number,
  omega: number,
  lookaheadSeconds: number
): { times: number[]; values: number[] } {
  const dt = 1 / 60;
  let position = targetAt(lookaheadSeconds);
  let velocity = 0;
  const times: number[] = [];
  const values: number[] = [];
  let nextOutput = 0;
  for (let t = 0; t <= durationSeconds + 1e-9; t += dt) {
    if (t >= nextOutput - 1e-9) {
      times.push(Math.round(nextOutput * 1000) / 1000);
      values.push(position);
      nextOutput += stepSeconds;
    }
    const target = targetAt(t + lookaheadSeconds);
    const acceleration = omega * omega * (target - position) - 2 * omega * velocity;
    velocity += acceleration * dt;
    position += velocity * dt;
  }
  if (times[times.length - 1] < durationSeconds) {
    times.push(durationSeconds);
    values.push(position);
  }
  return { times, values };
}

export function buildCropPath(samples: FaceSample[], options: CropPathOptions): CropPath {
  const cropWidth = clamp(options.cropWidth, 0, 1);
  const cropHeight = clamp(options.cropHeight, 0, 1);
  const duration = Math.max(0, options.durationSeconds);
  const stepSeconds = options.stepSeconds ?? 0.1;
  const omega = options.omega ?? 6;
  const lookahead = options.lookaheadSeconds ?? 0.3;
  const deadZone = options.deadZone ?? 0.04;
  const slotCount = options.activity?.slotCount ?? 0;
  const ordered = [...samples].sort((a, b) => a.seconds - b.seconds);

  const sampleTimes: number[] = [];
  const rawX: Array<number | null> = [];
  const rawY: Array<number | null> = [];
  let previous: { x: number; y: number } | null = null;
  for (const sample of ordered) {
    const target = chooseCropTarget(sample.faces, previous, cropWidth, activeSlotAt(options.activity, sample.seconds), slotCount);
    sampleTimes.push(sample.seconds);
    rawX.push(target ? target.x : null);
    rawY.push(target ? target.y : null);
    if (target) previous = target;
  }
  const fill = (values: Array<number | null>): number[] => {
    const first = values.find((value): value is number => value !== null) ?? 0.5;
    let last = first;
    return values.map((value) => {
      if (value !== null) last = value;
      return last;
    });
  };
  const halfW = cropWidth / 2;
  const halfH = cropHeight / 2;
  const targetsX = applyDeadZone(median3(fill(rawX)), deadZone).map((value) => clamp(value, halfW, 1 - halfW));
  const targetsY = applyDeadZone(median3(fill(rawY)), deadZone).map((value) => clamp(value, halfH, 1 - halfH));
  if (sampleTimes.length === 0) {
    return { times: [0, duration], centersX: [0.5, 0.5], centersY: [0.5, 0.5] };
  }
  const x = springFollow((t) => valueAt(sampleTimes, targetsX, t), duration, stepSeconds, omega, lookahead);
  const y = springFollow((t) => valueAt(sampleTimes, targetsY, t), duration, stepSeconds, omega, lookahead);
  return {
    times: x.times,
    centersX: x.values.map((value) => clamp(value, halfW, 1 - halfW)),
    centersY: y.values.map((value) => clamp(value, halfH, 1 - halfH)),
  };
}

/** Crop centre at `seconds` from the clip start, interpolated between path points. */
export function sampleCropPath(path: CropPath | null | undefined, seconds: number): { x: number; y: number } {
  if (!path || path.times.length === 0) return { x: 0.5, y: 0.5 };
  const { times } = path;
  if (seconds <= times[0]) return { x: path.centersX[0], y: path.centersY[0] };
  for (let index = 1; index < times.length; index += 1) {
    if (seconds <= times[index]) {
      const span = times[index] - times[index - 1] || 1;
      const fraction = (seconds - times[index - 1]) / span;
      return {
        x: path.centersX[index - 1] + (path.centersX[index] - path.centersX[index - 1]) * fraction,
        y: path.centersY[index - 1] + (path.centersY[index] - path.centersY[index - 1]) * fraction,
      };
    }
  }
  const last = times.length - 1;
  return { x: path.centersX[last], y: path.centersY[last] };
}

/**
 * Loudest participant per step from per-track RMS levels (one array per
 * track, one value per step). Quiet steps (all below `threshold`) are null.
 */
export function buildSpeakerActivity(levels: number[][], stepSeconds: number, threshold = 0.01): SpeakerActivity {
  const steps = levels.reduce((max, track) => Math.max(max, track.length), 0);
  const samples: SpeakerActivitySample[] = [];
  for (let step = 0; step < steps; step += 1) {
    let best: number | null = null;
    let bestLevel = threshold;
    for (let slot = 0; slot < levels.length; slot += 1) {
      const level = levels[slot][step] ?? 0;
      if (level > bestLevel) {
        best = slot;
        bestLevel = level;
      }
    }
    samples.push({ seconds: step * stepSeconds + stepSeconds / 2, activeSlot: best });
  }
  return { slotCount: levels.length, samples };
}
