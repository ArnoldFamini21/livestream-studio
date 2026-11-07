/**
 * FFmpeg's machine-readable progress report (`-progress pipe:2`), parsed out
 * of the process's stderr. Each report is a block of key=value lines ending
 * in `progress=continue` (or `progress=end`); everything else on stderr is an
 * ordinary log line and is handed back untouched.
 */

/** Arguments that make FFmpeg write a progress block to stderr every `periodSeconds`. */
export function ffmpegProgressArgs(periodSeconds = 2): string[] {
  return ['-nostats', '-progress', 'pipe:2', '-stats_period', String(periodSeconds)];
}

export interface FfmpegProgress {
  frame: number | null;
  fps: number | null;
  /** Output bitrate in kbit/s, as FFmpeg reports it for the muxed output. */
  bitrateKbps: number | null;
  totalSizeBytes: number | null;
  outTimeMs: number | null;
  /** Processing speed against real time (1 = keeping up). */
  speed: number | null;
  droppedFrames: number;
  duplicatedFrames: number;
  ended: boolean;
}

const PROGRESS_KEYS = new Set([
  'frame',
  'fps',
  'stream_0_0_q',
  'stream_0_1_q',
  'stream_1_0_q',
  'stream_1_1_q',
  'bitrate',
  'total_size',
  'out_time_us',
  'out_time_ms',
  'out_time',
  'dup_frames',
  'drop_frames',
  'speed',
  'progress',
]);

const PROGRESS_LINE = /^([a-z0-9_]+)=(.*)$/;
/** Per-stream quantizer lines such as stream_0_0_q=28.0. */
const STREAM_QUALITY_KEY = /^stream_\d+_\d+_q$/;

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'N/A') return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "4512.3kbits/s" -> 4512.3; "N/A" -> null. */
export function parseFfmpegBitrateKbps(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([\d.]+)\s*kbits\/s$/i);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "0.98x" -> 0.98; "N/A" -> null. */
export function parseFfmpegSpeed(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([\d.]+)x$/i);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function toProgress(fields: Map<string, string>): FfmpegProgress {
  const outTimeUs = parseNumber(fields.get('out_time_us'));
  const frame = parseNumber(fields.get('frame'));
  const totalSize = parseNumber(fields.get('total_size'));
  return {
    frame,
    fps: parseNumber(fields.get('fps')),
    bitrateKbps: parseFfmpegBitrateKbps(fields.get('bitrate')),
    totalSizeBytes: totalSize,
    outTimeMs: outTimeUs === null ? null : Math.round(outTimeUs / 1000),
    speed: parseFfmpegSpeed(fields.get('speed')),
    droppedFrames: parseNumber(fields.get('drop_frames')) ?? 0,
    duplicatedFrames: parseNumber(fields.get('dup_frames')) ?? 0,
    ended: fields.get('progress') === 'end',
  };
}

export class FfmpegProgressParser {
  private partial = '';
  private fields = new Map<string, string>();

  /**
   * Feed a stderr chunk. Returns the completed progress reports and the log
   * lines that are not part of a report.
   */
  push(chunk: Buffer | string): { reports: FfmpegProgress[]; logLines: string[] } {
    const text = this.partial + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    const lines = text.split(/\r?\n|\r/);
    this.partial = lines.pop() ?? '';
    // A runaway line without a newline is a log line, not a report.
    if (this.partial.length > 4096) {
      lines.push(this.partial);
      this.partial = '';
    }
    const reports: FfmpegProgress[] = [];
    const logLines: string[] = [];
    for (const line of lines) {
      const match = line.match(PROGRESS_LINE);
      if (match && (PROGRESS_KEYS.has(match[1]) || STREAM_QUALITY_KEY.test(match[1]))) {
        this.fields.set(match[1], match[2]);
        if (match[1] === 'progress') {
          reports.push(toProgress(this.fields));
          this.fields = new Map();
        }
        continue;
      }
      const trimmed = line.trim();
      if (trimmed) logLines.push(trimmed);
    }
    return { reports, logLines };
  }
}

/**
 * FFmpeg reports bitrate and speed as averages since the process started,
 * which hides a recent stall behind a long healthy run. The rate over the
 * last report interval comes from the change in output size and media time.
 */
export class FfmpegRateMeter {
  private last: { atMs: number; totalSizeBytes: number | null; outTimeMs: number | null } | null = null;

  sample(progress: FfmpegProgress, nowMs: number): { bitrateKbps: number | null; speed: number | null } {
    const previous = this.last;
    this.last = { atMs: nowMs, totalSizeBytes: progress.totalSizeBytes, outTimeMs: progress.outTimeMs };
    const elapsedMs = previous ? nowMs - previous.atMs : 0;
    if (!previous || elapsedMs < 250) {
      return { bitrateKbps: progress.bitrateKbps, speed: progress.speed };
    }
    const bitrateKbps = progress.totalSizeBytes !== null && previous.totalSizeBytes !== null
      ? Math.max(0, ((progress.totalSizeBytes - previous.totalSizeBytes) * 8) / elapsedMs)
      : progress.bitrateKbps;
    const speed = progress.outTimeMs !== null && previous.outTimeMs !== null
      ? Math.max(0, (progress.outTimeMs - previous.outTimeMs) / elapsedMs)
      : progress.speed;
    return { bitrateKbps, speed };
  }
}
