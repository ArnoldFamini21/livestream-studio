import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const ffmpeg = promisify(execFile);
const MAX_OFFSET_MS = 40;

function finiteNumbers(matches) {
  return Array.from(matches, match => Number(match[1]));
}

export function readFlashCues(output, threshold) {
  const samples = Array.from(output.matchAll(
    /frame:\s*\d+[^\n]*?pts_time:([\d.e+-]+)[^\n]*\n(?:\r?\n)?lavfi\.signalstats\.YAVG=([\d.e+-]+)/g,
  ), ([, time, luma]) => ({ time: Number(time), luma: Number(luma) }));
  if (!samples.some(sample => sample.luma < threshold)) {
    throw new Error('The video needs a visible dark background between flashes.');
  }

  return samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    const next = samples[index + 1];
    return previous?.luma < threshold && sample.luma >= threshold && next?.luma >= threshold
      ? [sample.time]
      : [];
  });
}

export function readPulseCues(output, timelineEnd = Infinity) {
  // silencedetect reports the real silence boundary after enough samples have
  // arrived to confirm it. A terminal silence endpoint has no following audio.
  const cues = finiteNumbers(output.matchAll(/silence_end:\s*([\d.e+-]+)/g));
  return cues.filter(cue => cue < timelineEnd - 0.02);
}

export function inspectCueAgreement(flashes, pulses, expectedCount) {
  if (!Number.isInteger(expectedCount) || expectedCount < 3) {
    throw new Error('Specify at least three cues spread across the take.');
  }
  if (flashes.length !== expectedCount || pulses.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} cues. Found ${flashes.length} flashes and ${pulses.length} audio pulses.`);
  }
  const cues = flashes.map((flashSeconds, index) => ({
    flashSeconds,
    pulseSeconds: pulses[index],
    offsetMs: (flashSeconds - pulses[index]) * 1000,
  }));
  const offsets = cues.map(cue => cue.offsetMs);
  const largestOffsetMs = Math.max(...offsets.map(Math.abs));
  const offsetChangeMs = Math.max(...offsets) - Math.min(...offsets);
  return {
    cues,
    largestOffsetMs,
    offsetChangeMs,
    limitMs: MAX_OFFSET_MS,
    passed: largestOffsetMs < MAX_OFFSET_MS && offsetChangeMs < MAX_OFFSET_MS,
  };
}

async function readPulseOutput(file) {
  const { stdout } = await ffmpeg(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const packets = stdout.trimEnd().split('\n');
  const last = packets.findLast(line => /^-?\d/.test(line));
  const [pts, duration = 0] = (last || '').split(',');
  const end = Number(pts) + (Number(duration) || 0);
  if (!Number.isFinite(end)) throw new Error('The file needs an audio track with a known end timestamp.');

  const { stderr } = await ffmpeg(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-nostdin', '-hide_banner', '-nostats', '-copyts', '-i', file, '-map', '0:a:0',
    '-af', 'highpass=f=850,lowpass=f=1150,silencedetect=noise=-26dB:d=0.12', '-f', 'null', '-',
  ]);
  return readPulseCues(stderr, end);
}

export async function analyzeRecordingCues(file, expectedCount, lumaThreshold = 150) {
  if (!Number.isFinite(lumaThreshold) || lumaThreshold < 0 || lumaThreshold > 255) {
    throw new Error('The luma threshold must be between 0 and 255.');
  }
  const { stdout } = await ffmpeg(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-copyts', '-i', file, '-map', '0:v:0',
    '-vf', 'crop=iw/3:ih/3,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-',
    '-an', '-f', 'null', '-',
  ], { maxBuffer: 12 * 1024 * 1024 });
  const flashes = readFlashCues(stdout, lumaThreshold);
  const pulses = await readPulseOutput(file);
  return inspectCueAgreement(flashes, pulses, expectedCount);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, cueCount, threshold] = process.argv.slice(2);
  if (!file || !cueCount) {
    console.error('Usage: node e2e/recording-cues.mjs FILE EXPECTED_CUES [LUMA_THRESHOLD]');
    process.exitCode = 2;
  } else {
    try {
      const result = await analyzeRecordingCues(file, Number(cueCount), threshold ? Number(threshold) : undefined);
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 2;
    }
  }
}
