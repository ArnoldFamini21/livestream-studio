import { getTrackStartOffsetsSeconds } from './recordingTakeManifest.ts';
import { toCleanedTime, type TimeRange } from './transcriptCleanup.ts';

/**
 * Edit lists for the transcript cleanup: the same kept ranges the cleaned
 * audio, the browser render and the media-server export use, written as
 * FCPXML 1.10 (Final Cut Pro, DaVinci Resolve free), CMX3600 EDLs and a
 * re-timed SRT, so the edit can be finished in a free local editor.
 *
 * Kept ranges are in the time of the transcribed track. Every other track is
 * aligned by its capture start (recordingCaptureMetadata via the take
 * manifest timing): a track that started 1.2 s after the transcribed one
 * reads its media 1.2 s earlier for the same moment.
 */

export const EDIT_LIST_FRAME_RATE = 30;
const MAX_CUE_WORDS = 8;
const MAX_CUE_SECONDS = 4;
const MAX_CUE_GAP_SECONDS = 1;

export interface EditListTrackInput {
  label: string;
  fileName: string;
  kind?: string;
  /** MIME type of the file. */
  type?: string;
  capture?: unknown;
}

export type EditListTrackRole = 'video' | 'audio' | 'screen';

/** One kept piece of one track: read [sourceStart, sourceEnd) of the file, place it at recordStart on the cleaned timeline. */
export interface EditSegment {
  sourceStart: number;
  sourceEnd: number;
  recordStart: number;
}

export interface EditListTrack {
  label: string;
  fileName: string;
  role: EditListTrackRole;
  /** Seconds added to a kept-range time to get this file's media time. */
  alignmentSeconds: number;
  segments: EditSegment[];
}

export interface EditListMarker {
  label: string;
  /** Seconds on the transcribed track's timeline. */
  seconds: number;
}

export interface EditListWord {
  word: string;
  start: number;
  end: number;
  removed?: boolean;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function inferEditListTrackRole(track: Pick<EditListTrackInput, 'kind' | 'type' | 'label' | 'fileName'>): EditListTrackRole {
  if (track.kind === 'program' || track.kind === 'iso') return 'video';
  if (track.kind === 'screen') return 'screen';
  const label = `${track.label} ${track.fileName}`.toLowerCase();
  if (label.includes('screen')) return 'screen';
  if (track.kind === 'audio' || (track.type || '').startsWith('audio/') || /\.(wav|m4a|mp3|ogg|opus|flac)$/i.test(track.fileName)) return 'audio';
  return 'video';
}

/** Seconds to add to the transcribed track's time to read each track (0 when timing is unknown). */
export function getTrackAlignmentSeconds(tracks: Array<{ capture?: unknown }>, sourceIndex: number): number[] {
  const offsets = getTrackStartOffsetsSeconds(tracks);
  const sourceOffset = offsets[sourceIndex] ?? 0;
  return offsets.map((offset) => round3(sourceOffset - offset));
}

/**
 * Kept ranges (transcribed-track time) as segments of one track. A part
 * before the track's first frame is skipped and the segment placed later on
 * the cleaned timeline, so the tracks stay in sync.
 */
export function mapKeepRangesToTrack(
  keepRanges: TimeRange[],
  alignmentSeconds: number,
  trackDurationSeconds?: number | null,
): EditSegment[] {
  const segments: EditSegment[] = [];
  let recordCursor = 0;
  const limit = trackDurationSeconds && Number.isFinite(trackDurationSeconds) && trackDurationSeconds > 0
    ? trackDurationSeconds
    : Number.POSITIVE_INFINITY;
  for (const range of keepRanges) {
    const length = range.endSeconds - range.startSeconds;
    if (!(length > 0)) continue;
    let sourceStart = range.startSeconds + alignmentSeconds;
    let sourceEnd = range.endSeconds + alignmentSeconds;
    let recordStart = recordCursor;
    recordCursor += length;
    if (sourceStart < 0) {
      recordStart -= sourceStart;
      sourceStart = 0;
    }
    sourceEnd = Math.min(sourceEnd, limit);
    if (sourceEnd - sourceStart <= 0.001) continue;
    segments.push({ sourceStart: round3(sourceStart), sourceEnd: round3(sourceEnd), recordStart: round3(recordStart) });
  }
  return segments;
}

export function getCleanedDurationSeconds(keepRanges: TimeRange[]): number {
  return round3(keepRanges.reduce((sum, range) => sum + Math.max(0, range.endSeconds - range.startSeconds), 0));
}

export function buildEditListTracks(
  tracks: EditListTrackInput[],
  sourceIndex: number,
  keepRanges: TimeRange[],
  options: { trackDurationsSeconds?: Array<number | null | undefined> } = {},
): EditListTrack[] {
  const alignment = getTrackAlignmentSeconds(tracks, sourceIndex);
  return tracks.map((track, index) => ({
    label: track.label || track.fileName,
    fileName: track.fileName,
    role: inferEditListTrackRole(track),
    alignmentSeconds: alignment[index] ?? 0,
    segments: mapKeepRangesToTrack(keepRanges, alignment[index] ?? 0, options.trackDurationsSeconds?.[index]),
  }));
}

// ---------- FCPXML 1.10 ----------

function xmlEscape(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toFrames(seconds: number, frameRate: number): number {
  return Math.max(0, Math.round(seconds * frameRate));
}

function fcpxTime(frames: number, frameRate: number): string {
  return frames > 0 ? `${frames}/${frameRate}s` : '0s';
}

/** A relative URL for a file next to the edit list (spaces and non-ASCII percent-encoded). */
export function toRelativeMediaUrl(fileName: string): string {
  return `./${fileName.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

export interface CleanupFcpxmlInput {
  projectName: string;
  tracks: EditListTrack[];
  cleanedDurationSeconds: number;
  markers?: EditListMarker[];
  keepRanges?: TimeRange[];
  frameRate?: number;
  width?: number;
  height?: number;
}

/**
 * FCPXML 1.10: a gap spans the cleaned timeline and every kept piece of every
 * track is connected to it on that track's lane (lane 1 is the first track),
 * with offset = where it lands on the cleaned timeline and start = where it
 * is read from in the file.
 */
export function buildCleanupFcpxml(input: CleanupFcpxmlInput): string {
  const frameRate = input.frameRate ?? EDIT_LIST_FRAME_RATE;
  const width = input.width ?? 1920;
  const height = input.height ?? 1080;
  const totalFrames = Math.max(1, toFrames(input.cleanedDurationSeconds, frameRate));
  const projectName = input.projectName.trim() || 'LiveStream Studio cleanup';

  const assetLines: string[] = [];
  const clipLines: string[] = [];
  input.tracks.forEach((track, trackIndex) => {
    if (track.segments.length === 0) return;
    const assetId = `r${trackIndex + 2}`;
    const hasVideo = track.role !== 'audio';
    const lastSourceEnd = Math.max(...track.segments.map((segment) => segment.sourceEnd));
    assetLines.push(
      `    <asset id="${assetId}" name="${xmlEscape(track.label)}" start="0s" duration="${fcpxTime(Math.max(1, toFrames(lastSourceEnd, frameRate)), frameRate)}" hasVideo="${hasVideo ? 1 : 0}" hasAudio="1"${hasVideo ? ' format="r1"' : ''} audioSources="1" audioChannels="2" audioRate="48000">`,
      `      <media-rep kind="original-media" src="${xmlEscape(toRelativeMediaUrl(track.fileName))}"/>`,
      '    </asset>',
    );
    for (const segment of track.segments) {
      const offset = toFrames(segment.recordStart, frameRate);
      const end = toFrames(segment.recordStart + (segment.sourceEnd - segment.sourceStart), frameRate);
      const duration = end - offset;
      if (duration <= 0) continue;
      clipLines.push(
        `              <asset-clip name="${xmlEscape(track.label)}" ref="${assetId}" lane="${trackIndex + 1}" offset="${fcpxTime(offset, frameRate)}" start="${fcpxTime(toFrames(segment.sourceStart, frameRate), frameRate)}" duration="${fcpxTime(duration, frameRate)}"${hasVideo ? '' : ' audioRole="dialogue"'}/>`,
      );
    }
  });

  const markerLines = (input.markers || [])
    .filter((marker) => !input.keepRanges || isInsideKeepRanges(input.keepRanges, marker.seconds))
    .map((marker) => {
      const seconds = input.keepRanges ? toCleanedTime(input.keepRanges, marker.seconds) : marker.seconds;
      return `              <marker start="${fcpxTime(toFrames(seconds, frameRate), frameRate)}" duration="1/${frameRate}s" value="${xmlEscape(marker.label)}"/>`;
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    `    <format id="r1" name="FFVideoFormat${height}p${frameRate}" frameDuration="1/${frameRate}s" width="${width}" height="${height}"/>`,
    ...assetLines,
    '  </resources>',
    '  <library>',
    `    <event name="${xmlEscape(projectName)}">`,
    `      <project name="${xmlEscape(projectName)}">`,
    `        <sequence format="r1" duration="${fcpxTime(totalFrames, frameRate)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    '          <spine>',
    `            <gap name="Cleaned timeline" offset="0s" start="0s" duration="${fcpxTime(totalFrames, frameRate)}">`,
    ...clipLines,
    ...markerLines,
    '            </gap>',
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

function isInsideKeepRanges(keepRanges: TimeRange[], seconds: number): boolean {
  return keepRanges.some((range) => seconds >= range.startSeconds && seconds < range.endSeconds);
}

// ---------- CMX3600 EDL ----------

/** HH:MM:SS:FF, non-drop frame. */
export function formatEdlTimecode(frames: number, frameRate = EDIT_LIST_FRAME_RATE): string {
  const total = Math.max(0, Math.round(frames));
  const ff = total % frameRate;
  const totalSeconds = Math.floor(total / frameRate);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(ff)}`;
}

function edlReelName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return (base || 'AX').slice(0, 8).padEnd(8, ' ');
}

/**
 * One CMX3600 EDL per track (an EDL holds one picture track). Record time
 * starts at 01:00:00:00, the editors' default. Events past 999 get four-digit
 * numbers, which Resolve and Premiere read.
 */
export function buildCleanupEdl(input: { title: string; track: EditListTrack; frameRate?: number }): string {
  const frameRate = input.frameRate ?? EDIT_LIST_FRAME_RATE;
  const recordOrigin = 3600 * frameRate;
  const channel = input.track.role === 'audio' ? 'AA   ' : 'AA/V ';
  const reel = edlReelName(input.track.fileName);
  const title = input.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 70) || 'Cleanup';
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  let event = 0;
  for (const segment of input.track.segments) {
    const sourceIn = toFrames(segment.sourceStart, frameRate);
    const recordIn = toFrames(segment.recordStart, frameRate);
    const recordOut = toFrames(segment.recordStart + (segment.sourceEnd - segment.sourceStart), frameRate);
    const length = recordOut - recordIn;
    if (length <= 0) continue;
    event += 1;
    lines.push(
      `${String(event).padStart(3, '0')}  ${reel} ${channel} C        ${formatEdlTimecode(sourceIn, frameRate)} ${formatEdlTimecode(sourceIn + length, frameRate)} ${formatEdlTimecode(recordOrigin + recordIn, frameRate)} ${formatEdlTimecode(recordOrigin + recordOut, frameRate)}`,
      `* FROM CLIP NAME: ${input.track.fileName}`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------- Re-timed SRT ----------

function formatSrtTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)},${pad(ms, 3)}`;
}

export interface SrtCue {
  start: number;
  end: number;
  text: string;
}

/**
 * Captions on the cleaned timeline: cut words are dropped, kept words move
 * with the cuts, and cues break at sentence ends, long gaps, or after a few
 * words so they stay readable.
 */
export function buildRetimedCues(words: EditListWord[], keepRanges: TimeRange[]): SrtCue[] {
  const cues: SrtCue[] = [];
  let current: { words: string[]; start: number; end: number } | null = null;
  const flush = () => {
    if (current && current.words.length > 0 && current.end > current.start) {
      cues.push({ start: current.start, end: current.end, text: current.words.join(' ').replace(/\s+([,.!?;:])/g, '$1') });
    }
    current = null;
  };
  for (const word of words) {
    if (word.removed || !word.word.trim()) continue;
    const midpoint = (word.start + word.end) / 2;
    if (keepRanges.length > 0 && !isInsideKeepRanges(keepRanges, midpoint)) continue;
    const start = toCleanedTime(keepRanges, Math.max(word.start, 0));
    const end = Math.max(start + 0.05, toCleanedTime(keepRanges, word.end));
    if (current && (
      current.words.length >= MAX_CUE_WORDS ||
      end - current.start > MAX_CUE_SECONDS ||
      start - current.end > MAX_CUE_GAP_SECONDS
    )) flush();
    if (!current) current = { words: [], start, end };
    current.words.push(word.word.trim());
    current.end = end;
    if (/[.!?]["')\]]?$/.test(word.word.trim())) flush();
  }
  flush();
  // Never overlap: a cue ends where the next one starts.
  for (let index = 0; index < cues.length - 1; index += 1) {
    if (cues[index].end > cues[index + 1].start) cues[index].end = cues[index + 1].start;
  }
  return cues.filter((cue) => cue.end > cue.start);
}

export function buildSrt(cues: SrtCue[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text}\n`)
    .join('\n');
}

// ---------- Bundle ----------

export interface EditListFile {
  name: string;
  text: string;
  mimeType: string;
}

function fileSafe(value: string, fallback: string): string {
  return value.normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || fallback;
}

export function buildCleanupEditListFiles(input: {
  baseName: string;
  tracks: EditListTrackInput[];
  sourceIndex: number;
  keepRanges: TimeRange[];
  words: EditListWord[];
  markers?: EditListMarker[];
  trackDurationsSeconds?: Array<number | null | undefined>;
}): EditListFile[] {
  const base = fileSafe(input.baseName, 'recording');
  const tracks = buildEditListTracks(input.tracks, input.sourceIndex, input.keepRanges, { trackDurationsSeconds: input.trackDurationsSeconds });
  const cleanedDurationSeconds = getCleanedDurationSeconds(input.keepRanges);
  // Markers are in take time; the kept ranges are in the transcribed track's time.
  const sourceOffset = getTrackStartOffsetsSeconds(input.tracks)[input.sourceIndex] ?? 0;
  const markers = input.markers?.map((marker) => ({ ...marker, seconds: marker.seconds - sourceOffset }));
  const files: EditListFile[] = [{
    name: `${base}_cleanup.fcpxml`,
    text: buildCleanupFcpxml({ projectName: `${input.baseName} cleaned`, tracks, cleanedDurationSeconds, markers, keepRanges: input.keepRanges }),
    mimeType: 'application/xml',
  }];
  const usedNames = new Set<string>();
  tracks.forEach((track, index) => {
    if (track.segments.length === 0) return;
    let name = `${base}_cleanup_${fileSafe(track.label, `track${index + 1}`)}.edl`;
    if (usedNames.has(name)) name = name.replace(/\.edl$/, `_${index + 1}.edl`);
    usedNames.add(name);
    files.push({ name, text: buildCleanupEdl({ title: `${input.baseName} - ${track.label}`, track }), mimeType: 'text/plain' });
  });
  files.push({ name: `${base}_cleaned.srt`, text: buildSrt(buildRetimedCues(input.words, input.keepRanges)), mimeType: 'application/x-subrip' });
  files.push({
    name: 'README.txt',
    mimeType: 'text/plain',
    text: [
      'Transcript cleanup edit list',
      '',
      `${base}_cleanup.fcpxml  Final Cut Pro / DaVinci Resolve (File > Import > Timeline). One lane per track, every kept range placed back to back.`,
      `*.edl                   CMX3600 edit decision list, one per track, for editors that import EDLs.`,
      `${base}_cleaned.srt     Captions re-timed to the cleaned timeline.`,
      '',
      'Put these files in the same folder as the recording\'s track files (they refer to them by file name),',
      'or relink the media in your editor when it asks. Tracks are aligned by their recorded start times.',
      `Cleaned length: ${formatSrtTime(cleanedDurationSeconds).replace(',', '.')} at ${EDIT_LIST_FRAME_RATE} fps.`,
      '',
    ].join('\n'),
  });
  return files;
}
