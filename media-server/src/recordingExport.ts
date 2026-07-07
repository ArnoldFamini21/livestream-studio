import path from 'node:path';

export type RecordingExportTrackKind = 'audio' | 'video' | 'screen' | 'program' | 'iso';
export type RecordingAudioStemFormat = 'wav' | 'mp3';
export type RecordingExportVideoCodec = 'h264' | 'h265';

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
  codec: RecordingExportVideoCodec;
}

export interface RecordingExportAudioOptions {
  sampleRate: number;
  channelCount: number;
  audioBitsPerSecond: number;
}

export type RecordingExportClipAspect = 'source' | 'vertical' | 'square';

export interface RecordingExportClipRange {
  startSeconds: number;
  endSeconds: number;
  aspect?: RecordingExportClipAspect;
}

export interface RecordingExportPlan {
  tracks: RecordingExportTrack[];
  outputDirectory: string;
  basename: string;
  video?: Partial<RecordingExportVideoOptions>;
  audio?: Partial<RecordingExportAudioOptions>;
  clip?: RecordingExportClipRange | null;
}

export interface RecordingExportCommand {
  label: string;
  outputPath: string;
  args: string[];
  artifactId?: string;
}

export interface RecordingExportCommands {
  mp4: RecordingExportCommand;
  isolatedVideos: RecordingExportCommand[];
  stems: RecordingExportCommand[];
}

const MAX_EXPORT_TRACKS = 64;
const MIN_EXPORT_CLIP_DURATION_SECONDS = 1;
const MAX_EXPORT_CLIP_DURATION_SECONDS = 6 * 60 * 60;
const MAX_EXPORT_CLIP_START_SECONDS = 24 * 60 * 60;
const MAX_EXPORT_PATH_LENGTH = 2048;
const MAX_EXPORT_DIMENSION = 3840;
const MAX_EXPORT_PIXELS = 3840 * 2160;
const MAX_EXPORT_FRAME_RATE = 60;
const MAX_EXPORT_VIDEO_BITRATE = 50_000_000;
const MAX_EXPORT_AUDIO_BITRATE = 320_000;
const AUDIO_INPUT_LIMIT = 16;
const ISOLATED_VIDEO_INPUT_LIMIT = 16;

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value as number)));
}

function roundToEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function normalizeRecordingExportVideoCodec(value: unknown): RecordingExportVideoCodec {
  return value === 'h265' ? 'h265' : 'h264';
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

export function getRecordingExportClipIssue(clip: unknown): string | null {
  if (clip === undefined || clip === null) return null;
  if (typeof clip !== 'object') return 'Invalid clip range';
  const { startSeconds, endSeconds } = clip as { startSeconds?: unknown; endSeconds?: unknown };
  if (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds < 0) {
    return 'Clip start must be a non-negative number of seconds';
  }
  if (startSeconds > MAX_EXPORT_CLIP_START_SECONDS) {
    return 'Clip start is beyond the supported recording length';
  }
  if (typeof endSeconds !== 'number' || !Number.isFinite(endSeconds) || endSeconds <= 0) {
    return 'Clip end must be a positive number of seconds';
  }
  if (endSeconds <= startSeconds) return 'Clip end must be after the clip start';
  const duration = endSeconds - startSeconds;
  if (duration < MIN_EXPORT_CLIP_DURATION_SECONDS) {
    return `Clips must be at least ${MIN_EXPORT_CLIP_DURATION_SECONDS} second long`;
  }
  if (duration > MAX_EXPORT_CLIP_DURATION_SECONDS) {
    return `Clips are limited to ${Math.round(MAX_EXPORT_CLIP_DURATION_SECONDS / 3600)} hours`;
  }
  const { aspect } = clip as { aspect?: unknown };
  if (aspect !== undefined && aspect !== 'source' && aspect !== 'vertical' && aspect !== 'square') {
    return 'Clip aspect must be source, vertical, or square';
  }
  return null;
}

export function normalizeRecordingExportClipRange(
  clip: RecordingExportClipRange | null | undefined
): RecordingExportClipRange | null {
  if (!clip) return null;
  const issue = getRecordingExportClipIssue(clip);
  if (issue) throw new Error(issue);
  return {
    startSeconds: Math.round(clip.startSeconds * 1000) / 1000,
    endSeconds: Math.round(clip.endSeconds * 1000) / 1000,
    aspect: clip.aspect === 'vertical' || clip.aspect === 'square' ? clip.aspect : 'source',
  };
}

function formatClipSeconds(value: number): string {
  return value.toFixed(3);
}

export function buildClipBasenameSuffix(clip: RecordingExportClipRange | null | undefined): string {
  if (!clip) return '';
  const formatPart = (seconds: number) => {
    const whole = Math.floor(seconds);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${m}m${String(s).padStart(2, '0')}s`;
  };
  const aspectPart = clip.aspect === 'vertical' ? '_9x16' : clip.aspect === 'square' ? '_1x1' : '';
  return `_clip_${formatPart(clip.startSeconds)}-${formatPart(clip.endSeconds)}${aspectPart}`;
}

export function getClipVideoGeometry(
  video: RecordingExportVideoOptions,
  clip: RecordingExportClipRange | null
): { width: number; height: number; filter: string } {
  const aspect = clip?.aspect;
  if (aspect === 'vertical' || aspect === 'square') {
    const height = video.height;
    const width = aspect === 'square' ? height : roundToEven((height * 9) / 16);
    return {
      width,
      height,
      filter: `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
    };
  }
  return {
    width: video.width,
    height: video.height,
    filter: `scale=${video.width}:${video.height}:force_original_aspect_ratio=decrease,pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
  };
}

function pushClipInputSeekArgs(args: string[], clip: RecordingExportClipRange | null) {
  if (!clip) return;
  args.push('-ss', formatClipSeconds(clip.startSeconds));
}

function pushClipOutputDurationArgs(args: string[], clip: RecordingExportClipRange | null) {
  if (!clip) return;
  args.push('-t', formatClipSeconds(clip.endSeconds - clip.startSeconds));
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
    codec: normalizeRecordingExportVideoCodec(options.codec),
  };
}

function pushVideoEncodingArgs(args: string[], video: RecordingExportVideoOptions) {
  const videoBitrateKbps = Math.round(video.videoBitsPerSecond / 1000);
  if (video.codec === 'h265') {
    args.push(
      '-c:v', 'libx265',
      '-preset', 'medium',
      '-tag:v', 'hvc1',
      '-pix_fmt', 'yuv420p',
      '-r', String(video.frameRate),
      '-b:v', `${videoBitrateKbps}k`,
      '-maxrate', `${Math.round(videoBitrateKbps * 1.15)}k`,
      '-bufsize', `${videoBitrateKbps * 2}k`,
      '-x265-params', 'log-level=error'
    );
    return;
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-pix_fmt', 'yuv420p',
    '-r', String(video.frameRate),
    '-b:v', `${videoBitrateKbps}k`,
    '-maxrate', `${Math.round(videoBitrateKbps * 1.15)}k`,
    '-bufsize', `${videoBitrateKbps * 2}k`
  );
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

function selectIsolatedVideoTracks(tracks: RecordingExportTrack[]): RecordingExportTrack[] {
  return tracks
    .filter((track) => track.kind === 'iso' || track.kind === 'video' || track.kind === 'screen')
    .filter((track) => track.hasVideo !== false)
    .slice(0, ISOLATED_VIDEO_INPUT_LIMIT);
}

function sanitizeArtifactId(value: string): string {
  return value.trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'track';
}

export function createRecordingMp4Args(plan: RecordingExportPlan): RecordingExportCommand {
  const issue = validateRecordingExportTracks(plan.tracks);
  if (issue) throw new Error(issue);
  const primaryVideoTrack = selectPrimaryVideoTrack(plan.tracks);
  if (!primaryVideoTrack) throw new Error('At least one video, screen, ISO, or program track is required for MP4 export');
  const video = normalizeRecordingExportVideoOptions(plan.video);
  const audio = normalizeRecordingExportAudioOptions(plan.audio);
  const clip = normalizeRecordingExportClipRange(plan.clip);
  const basename = `${sanitizeExportBasename(plan.basename)}${buildClipBasenameSuffix(clip)}`;
  const outputPath = path.join(plan.outputDirectory, `${basename}.mp4`);
  const audioTracks = selectAudioTracks(plan.tracks, primaryVideoTrack);
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
  ];
  pushClipInputSeekArgs(args, clip);
  args.push('-i', primaryVideoTrack.path);

  audioTracks.forEach((track) => {
    pushClipInputSeekArgs(args, clip);
    args.push('-i', track.path);
  });

  const videoFilter = getClipVideoGeometry(video, clip).filter;
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

  pushVideoEncodingArgs(args, video);
  args.push(
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channelCount)
  );
  pushClipOutputDurationArgs(args, clip);
  args.push('-movflags', '+faststart', outputPath);

  return {
    label: clip ? 'Final MP4 clip' : 'Final MP4',
    outputPath,
    args,
    artifactId: 'final-mp4',
  };
}

export function createRecordingIsolatedVideoArgs(
  track: RecordingExportTrack,
  outputDirectory: string,
  basename: string,
  videoOptions: Partial<RecordingExportVideoOptions> = {},
  audioOptions: Partial<RecordingExportAudioOptions> = {},
  clipRange: RecordingExportClipRange | null | undefined = null
): RecordingExportCommand {
  if (!['video', 'screen', 'iso'].includes(track.kind) || track.hasVideo === false) {
    throw new Error(`${track.label} does not contain an exportable video track`);
  }
  const pathIssue = validateLocalPath(track.path, track.label);
  if (pathIssue) throw new Error(pathIssue);
  const video = normalizeRecordingExportVideoOptions(videoOptions);
  const audio = normalizeRecordingExportAudioOptions(audioOptions);
  const clip = normalizeRecordingExportClipRange(clipRange);
  const outputBase = `${sanitizeExportBasename(`${basename}_${track.label}_video`)}${buildClipBasenameSuffix(clip)}`;
  const outputPath = path.join(outputDirectory, `${outputBase}.mp4`);
  const videoFilter = getClipVideoGeometry(video, clip).filter;
  const audioBitrateKbps = Math.round(audio.audioBitsPerSecond / 1000);
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',
  ];
  pushClipInputSeekArgs(args, clip);
  args.push(
    '-i', track.path,
    '-vf', videoFilter,
    '-map', '0:v:0',
    '-map', '0:a:0?',
  );
  pushVideoEncodingArgs(args, video);
  args.push(
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channelCount)
  );
  pushClipOutputDurationArgs(args, clip);
  args.push('-movflags', '+faststart', outputPath);

  return {
    label: clip ? `${track.label} isolated MP4 clip` : `${track.label} isolated MP4`,
    outputPath,
    args,
    artifactId: `isolated-video-${sanitizeArtifactId(track.id)}`,
  };
}

export function createRecordingAudioStemArgs(
  track: RecordingExportTrack,
  outputDirectory: string,
  basename: string,
  format: RecordingAudioStemFormat,
  options: Partial<RecordingExportAudioOptions> = {},
  clipRange: RecordingExportClipRange | null | undefined = null
): RecordingExportCommand {
  if (track.kind !== 'audio' && track.hasAudio !== true) {
    throw new Error(`${track.label} does not contain an exportable audio track`);
  }
  const pathIssue = validateLocalPath(track.path, track.label);
  if (pathIssue) throw new Error(pathIssue);
  const audio = normalizeRecordingExportAudioOptions(options);
  const clip = normalizeRecordingExportClipRange(clipRange);
  const outputBase = `${sanitizeExportBasename(`${basename}_${track.label}`)}${buildClipBasenameSuffix(clip)}`;
  const outputPath = path.join(outputDirectory, `${outputBase}.${format}`);
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
  ];
  pushClipInputSeekArgs(args, clip);
  args.push(
    '-i', track.path,
    '-vn',
    '-ar', String(audio.sampleRate),
    '-ac', String(audio.channelCount),
  );

  if (format === 'wav') {
    args.push('-c:a', 'pcm_s16le');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', `${Math.round(audio.audioBitsPerSecond / 1000)}k`);
  }
  pushClipOutputDurationArgs(args, clip);
  args.push(outputPath);

  return {
    label: clip
      ? `${track.label} ${format.toUpperCase()} stem clip`
      : `${track.label} ${format.toUpperCase()} stem`,
    outputPath,
    args,
  };
}

export function createRecordingExportCommands(plan: RecordingExportPlan): RecordingExportCommands {
  const clip = normalizeRecordingExportClipRange(plan.clip);
  const mp4 = createRecordingMp4Args(plan);
  const basename = sanitizeExportBasename(plan.basename);
  const isolatedVideos = selectIsolatedVideoTracks(plan.tracks).map((track) => (
    createRecordingIsolatedVideoArgs(track, plan.outputDirectory, basename, plan.video, plan.audio, clip)
  ));
  const audioTracks = plan.tracks.filter((track) => track.kind === 'audio' || track.hasAudio === true).slice(0, AUDIO_INPUT_LIMIT);
  const stems = audioTracks.flatMap((track) => [
    createRecordingAudioStemArgs(track, plan.outputDirectory, basename, 'wav', plan.audio, clip),
    createRecordingAudioStemArgs(track, plan.outputDirectory, basename, 'mp3', plan.audio, clip),
  ]);

  return { mp4, isolatedVideos, stems };
}
