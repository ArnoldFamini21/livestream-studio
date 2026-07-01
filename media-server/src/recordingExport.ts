import path from 'node:path';

export type RecordingExportTrackKind = 'audio' | 'video' | 'screen' | 'program' | 'iso';
export type RecordingAudioStemFormat = 'wav' | 'mp3';

export interface RecordingExportTrack {
  id: string;
  label: string;
  kind: RecordingExportTrackKind;
  path: string;
  mimeType?: string;
  hasAudio?: boolean;
  hasVideo?: boolean;
}

export interface RecordingExportVideoOptions {
  width: number;
  height: number;
  frameRate: number;
  videoBitsPerSecond: number;
}

export interface RecordingExportAudioOptions {
  sampleRate: number;
  channelCount: number;
  audioBitsPerSecond: number;
}

export interface RecordingExportPlan {
  tracks: RecordingExportTrack[];
  outputDirectory: string;
  basename: string;
  video?: Partial<RecordingExportVideoOptions>;
  audio?: Partial<RecordingExportAudioOptions>;
}

export interface RecordingExportCommand {
  label: string;
  outputPath: string;
  args: string[];
}

export interface RecordingExportCommands {
  mp4: RecordingExportCommand;
  stems: RecordingExportCommand[];
}

const MAX_EXPORT_TRACKS = 64;
const MAX_EXPORT_PATH_LENGTH = 2048;
const MAX_EXPORT_DIMENSION = 3840;
const MAX_EXPORT_PIXELS = 3840 * 2160;
const MAX_EXPORT_FRAME_RATE = 60;
const MAX_EXPORT_VIDEO_BITRATE = 50_000_000;
const MAX_EXPORT_AUDIO_BITRATE = 320_000;
const AUDIO_INPUT_LIMIT = 16;

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value as number)));
}

function roundToEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export function sanitizeExportBasename(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'recording-export';
}

export function normalizeRecordingExportVideoOptions(
  options: Partial<RecordingExportVideoOptions> = {}
): RecordingExportVideoOptions {
  let width = roundToEven(clampNumber(options.width, 1920, 180, MAX_EXPORT_DIMENSION));
  let height = roundToEven(clampNumber(options.height, 1080, 180, MAX_EXPORT_DIMENSION));
  if (width * height > MAX_EXPORT_PIXELS) {
    const scale = Math.sqrt(MAX_EXPORT_PIXELS / (width * height));
    width = roundToEven(width * scale);
    height = roundToEven(height * scale);
  }
  return {
    width,
    height,
    frameRate: clampNumber(options.frameRate, 30, 15, MAX_EXPORT_FRAME_RATE),
    videoBitsPerSecond: clampNumber(options.videoBitsPerSecond, 12_000_000, 1_000_000, MAX_EXPORT_VIDEO_BITRATE),
  };
}

export function normalizeRecordingExportAudioOptions(
  options: Partial<RecordingExportAudioOptions> = {}
): RecordingExportAudioOptions {
  return {
    sampleRate: clampNumber(options.sampleRate, 48_000, 8_000, 48_000),
    channelCount: clampNumber(options.channelCount, 2, 1, 2),
    audioBitsPerSecond: clampNumber(options.audioBitsPerSecond, 192_000, 64_000, MAX_EXPORT_AUDIO_BITRATE),
  };
}

function validateLocalPath(filePath: string, label: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed) return `${label} path is required`;
  if (trimmed.length > MAX_EXPORT_PATH_LENGTH) return `${label} path is too long`;
  if (trimmed.includes('\0')) return `${label} path contains an invalid character`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !path.isAbsolute(trimmed)) {
    return `${label} path must be a local file path`;
  }
  return null;
}

export function validateRecordingExportTracks(tracks: RecordingExportTrack[]): string | null {
  if (!Array.isArray(tracks) || tracks.length === 0) return 'At least one recording track is required';
  if (tracks.length > MAX_EXPORT_TRACKS) return `A maximum of ${MAX_EXPORT_TRACKS} recording tracks can be exported at once`;

  const ids = new Set<string>();
  for (const track of tracks) {
    if (!track || typeof track !== 'object') return 'Invalid recording track';
    if (typeof track.id !== 'string' || !/^[\w-]{1,120}$/.test(track.id)) return 'Invalid recording track id';
    if (ids.has(track.id)) return 'Recording track ids must be unique';
    ids.add(track.id);
    if (typeof track.label !== 'string' || track.label.trim().length === 0 || track.label.length > 160) {
      return `${track.id}: invalid recording track label`;
    }
    if (!['audio', 'video', 'screen', 'program', 'iso'].includes(track.kind)) {
      return `${track.id}: invalid recording track kind`;
    }
    const pathIssue = validateLocalPath(track.path, track.label);
    if (pathIssue) return pathIssue;
  }
  return null;
}

function selectPrimaryVideoTrack(tracks: RecordingExportTrack[]): RecordingExportTrack | null {
  return (
    tracks.find((track) => track.kind === 'program' && track.hasVideo !== false) ||
    tracks.find((track) => track.kind === 'iso' && track.hasVideo !== false) ||
    tracks.find((track) => track.kind === 'video' && track.hasVideo !== false) ||
    tracks.find((track) => track.kind === 'screen' && track.hasVideo !== false) ||
    null
  );
}

function selectAudioTracks(tracks: RecordingExportTrack[], primaryVideoTrack: RecordingExportTrack): RecordingExportTrack[] {
  if (primaryVideoTrack.kind === 'program' && primaryVideoTrack.hasAudio !== false) {
    return [];
  }
  return tracks
    .filter((track) => track.kind === 'audio' || (track.hasAudio === true && track.id !== primaryVideoTrack.id))
    .slice(0, AUDIO_INPUT_LIMIT);
}

export function createRecordingMp4Args(plan: RecordingExportPlan): RecordingExportCommand {
  const issue = validateRecordingExportTracks(plan.tracks);
  if (issue) throw new Error(issue);
  const primaryVideoTrack = selectPrimaryVideoTrack(plan.tracks);
  if (!primaryVideoTrack) throw new Error('At least one video, screen, ISO, or program track is required for MP4 export');
  const video = normalizeRecordingExportVideoOptions(plan.video);
  const audio = normalizeRecordingExportAudioOptions(plan.audio);
  const basename = sanitizeExportBasename(plan.basename);
  const outputPath = path.join(plan.outputDirectory, `${basename}.mp4`);
  const audioTracks = selectAudioTracks(plan.tracks, primaryVideoTrack);
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
    '-i', primaryVideoTrack.path,
  ];

  audioTracks.forEach((track) => {
    args.push('-i', track.path);
  });

  const videoFilter = `scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease,pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const videoBitrateKbps = Math.round(video.videoBitsPerSecond / 1000);
  const audioBitrateKbps = Math.round(audio.audioBitsPerSecond / 1000);

  if (audioTracks.length > 0) {
    const audioInputs = audioTracks.map((_, index) => `[${index + 1}:a:0]`).join('');
    args.push(
      '-filter_complex',
      `[0:v:0]${videoFilter}[vout];${audioInputs}amix=inputs=${audioTracks.length}:duration=longest:dropout_transition=2[aout]`,
      '-map', '[vout]',
      '-map', '[aout]'
    );
  } else {
    args.push(
      '-vf', videoFilter,
      '-map', '0:v:0',
      '-map', '0:a:0?'
    );
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-r', String(video.frameRate),
    '-b:v', `${videoBitrateKbps}k`,
    '-maxrate', `${Math.round(videoBitrateKbps * 1.15)}k`,
    '-bufsize', `${videoBitrateKbps * 2}k`,
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channelCount),
    '-movflags', '+faststart',
    outputPath
  );

  return { label: 'Final MP4', outputPath, args };
}

export function createRecordingAudioStemArgs(
  track: RecordingExportTrack,
  outputDirectory: string,
  basename: string,
  format: RecordingAudioStemFormat,
  options: Partial<RecordingExportAudioOptions> = {}
): RecordingExportCommand {
  if (track.kind !== 'audio' && track.hasAudio !== true) {
    throw new Error(`${track.label} does not contain an exportable audio track`);
  }
  const pathIssue = validateLocalPath(track.path, track.label);
  if (pathIssue) throw new Error(pathIssue);
  const audio = normalizeRecordingExportAudioOptions(options);
  const outputBase = sanitizeExportBasename(`${basename}_${track.label}`);
  const outputPath = path.join(outputDirectory, `${outputBase}.${format}`);
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', track.path,
    '-vn',
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channelCount),
  ];

  if (format === 'wav') {
    args.push('-c:a', 'pcm_s16le');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', `${Math.round(audio.audioBitsPerSecond / 1000)}k`);
  }
  args.push(outputPath);

  return {
    label: `${track.label} ${format.toUpperCase()} stem`,
    outputPath,
    args,
  };
}

export function createRecordingExportCommands(plan: RecordingExportPlan): RecordingExportCommands {
  const mp4 = createRecordingMp4Args(plan);
  const basename = sanitizeExportBasename(plan.basename);
  const audioTracks = plan.tracks.filter((track) => track.kind === 'audio' || track.hasAudio === true).slice(0, AUDIO_INPUT_LIMIT);
  const stems = audioTracks.flatMap((track) => [
    createRecordingAudioStemArgs(track, plan.outputDirectory, basename, 'wav', plan.audio),
    createRecordingAudioStemArgs(track, plan.outputDirectory, basename, 'mp3', plan.audio),
  ]);

  return { mp4, stems };
}
