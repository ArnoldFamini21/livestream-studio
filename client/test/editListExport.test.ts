import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCleanupEdl,
  buildCleanupEditListFiles,
  buildCleanupFcpxml,
  buildEditListTracks,
  buildRetimedCues,
  buildSrt,
  formatEdlTimecode,
  getCleanedDurationSeconds,
  getTrackAlignmentSeconds,
  inferEditListTrackRole,
  mapKeepRangesToTrack,
  toRelativeMediaUrl,
} from '../src/utils/editListExport.ts';

const keepRanges = [
  { startSeconds: 0, endSeconds: 2 },
  { startSeconds: 3, endSeconds: 5.5 },
  { startSeconds: 7, endSeconds: 10 },
];

function capture(sourceKind: string, startedAt: string) {
  return { sourceKind, startedAt, sourceId: sourceKind, mimeType: 'video/webm', tracks: [] };
}

const tracks = [
  { label: 'Program', fileName: 'program.webm', kind: 'program', type: 'video/webm', capture: capture('program', '2026-11-08T10:00:00.000Z') },
  { label: 'Host mic', fileName: 'host mic.webm', kind: 'audio', type: 'audio/webm', capture: capture('audio', '2026-11-08T10:00:01.000Z') },
  { label: 'Guest camera', fileName: 'guest.webm', kind: 'video', type: 'video/webm', capture: capture('video', '2026-11-08T10:00:02.500Z') },
];

describe('cleanup edit lists', () => {
  it('infers track roles', () => {
    assert.equal(inferEditListTrackRole({ kind: 'program', label: 'Program', fileName: 'p.webm' }), 'video');
    assert.equal(inferEditListTrackRole({ kind: 'audio', label: 'Mic', fileName: 'm.webm' }), 'audio');
    assert.equal(inferEditListTrackRole({ label: 'Mic', fileName: 'm.wav' }), 'audio');
    assert.equal(inferEditListTrackRole({ label: 'Screen share', fileName: 's.webm' }), 'screen');
    assert.equal(inferEditListTrackRole({ label: 'Camera', fileName: 'c.webm', type: 'video/webm' }), 'video');
  });

  it('aligns every track to the transcribed one by its capture start', () => {
    // The transcript came from the host mic, which started 1 s after the program.
    assert.deepEqual(getTrackAlignmentSeconds(tracks, 1), [1, 0, -1.5]);
    assert.deepEqual(getTrackAlignmentSeconds([{}, {}], 0), [0, 0]);
  });

  it('places kept ranges back to back with per-track source offsets', () => {
    assert.deepEqual(mapKeepRangesToTrack(keepRanges, 1), [
      { sourceStart: 1, sourceEnd: 3, recordStart: 0 },
      { sourceStart: 4, sourceEnd: 6.5, recordStart: 2 },
      { sourceStart: 8, sourceEnd: 11, recordStart: 4.5 },
    ]);
  });

  it('skips media before a late track started and keeps it in sync', () => {
    assert.deepEqual(mapKeepRangesToTrack(keepRanges, -1.5), [
      { sourceStart: 0, sourceEnd: 0.5, recordStart: 1.5 },
      { sourceStart: 1.5, sourceEnd: 4, recordStart: 2 },
      { sourceStart: 5.5, sourceEnd: 8.5, recordStart: 4.5 },
    ]);
    assert.deepEqual(mapKeepRangesToTrack([{ startSeconds: 0, endSeconds: 1 }], -2), []);
  });

  it('clamps segments to a known track duration', () => {
    assert.deepEqual(mapKeepRangesToTrack(keepRanges, 0, 8), [
      { sourceStart: 0, sourceEnd: 2, recordStart: 0 },
      { sourceStart: 3, sourceEnd: 5.5, recordStart: 2 },
      { sourceStart: 7, sourceEnd: 8, recordStart: 4.5 },
    ]);
  });

  it('writes FCPXML 1.10 with one asset-clip per kept range per track', () => {
    const editTracks = buildEditListTracks(tracks, 1, keepRanges);
    const xml = buildCleanupFcpxml({
      projectName: 'Show & Tell',
      tracks: editTracks,
      cleanedDurationSeconds: getCleanedDurationSeconds(keepRanges),
      keepRanges,
      markers: [{ label: 'Intro', seconds: 3.5 }, { label: 'Cut away', seconds: 2.5 }],
    });
    assert.match(xml, /<fcpxml version="1\.10">/);
    assert.match(xml, /<sequence format="r1" duration="225\/30s"/);
    assert.equal((xml.match(/<asset-clip /g) || []).length, 9);
    // Program (lane 1) reads 1 s later than the mic for the same moment.
    assert.match(xml, /ref="r2" lane="1" offset="60\/30s" start="120\/30s" duration="75\/30s"/);
    // The mic (lane 2) is audio only.
    assert.match(xml, /ref="r3" lane="2" offset="0s" start="0s" duration="60\/30s" audioRole="dialogue"/);
    assert.match(xml, /<media-rep kind="original-media" src="\.\/host%20mic\.webm"\/>/);
    assert.match(xml, /hasVideo="0"/);
    assert.match(xml, /Show &amp; Tell/);
    // Markers move with the cuts; one inside a cut is dropped.
    assert.match(xml, /<marker start="75\/30s" duration="1\/30s" value="Intro"\/>/);
    assert.doesNotMatch(xml, /Cut away/);
  });

  it('writes a CMX3600 EDL per track', () => {
    const [program] = buildEditListTracks(tracks, 1, keepRanges);
    const edl = buildCleanupEdl({ title: 'Episode 12', track: program });
    const lines = edl.split('\n');
    assert.equal(lines[0], 'TITLE: Episode 12');
    assert.equal(lines[1], 'FCM: NON-DROP FRAME');
    assert.equal(lines[3], '001  PROGRAM  AA/V  C        00:00:01:00 00:00:03:00 01:00:00:00 01:00:02:00');
    assert.equal(lines[4], '* FROM CLIP NAME: program.webm');
    assert.match(edl, /003 {2}PROGRAM {2}AA\/V {2}C {8}00:00:08:00 00:00:11:00 01:00:04:15 01:00:07:15/);
    assert.equal(formatEdlTimecode(30 * 3725 + 7), '01:02:05:07');
  });

  it('re-times captions and drops cut words', () => {
    const cues = buildRetimedCues([
      { word: 'Hello', start: 0.2, end: 1.5 },
      { word: 'um', start: 2.2, end: 2.6, removed: true },
      { word: 'there.', start: 3.1, end: 3.6 },
      { word: 'Next', start: 7.5, end: 7.9 },
      { word: 'cut', start: 6, end: 6.5 },
      { word: 'line', start: 8, end: 8.4 },
    ], keepRanges);
    assert.deepEqual(cues.map((cue) => cue.text), ['Hello there.', 'Next line']);
    assert.equal(cues[0].start, 0.2);
    assert.equal(cues[0].end, 2.6);
    assert.equal(cues[1].start, 5);
    const srt = buildSrt(cues);
    assert.match(srt, /^1\n00:00:00,200 --> 00:00:02,600\nHello there\.\n/);
    assert.match(srt, /2\n00:00:05,000 --> 00:00:05,900\nNext line\n/);
  });

  it('bundles FCPXML, EDLs, SRT and a README', () => {
    const files = buildCleanupEditListFiles({
      baseName: 'My Show',
      tracks,
      sourceIndex: 1,
      keepRanges,
      words: [{ word: 'Hi', start: 0, end: 0.5 }],
    });
    assert.deepEqual(files.map((file) => file.name), [
      'My_Show_cleanup.fcpxml',
      'My_Show_cleanup_Program.edl',
      'My_Show_cleanup_Host_mic.edl',
      'My_Show_cleanup_Guest_camera.edl',
      'My_Show_cleaned.srt',
      'README.txt',
    ]);
  });

  it('encodes relative media URLs', () => {
    assert.equal(toRelativeMediaUrl('Ana María/cam #1.webm'), './Ana%20Mar%C3%ADa/cam%20%231.webm');
  });
});
