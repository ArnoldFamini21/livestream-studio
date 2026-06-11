import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFinalCutProXml,
  createRecordingBundle,
  type RecordingMarker,
} from '../src/components/RecordingPanel.tsx';

const source = {
  roomName: 'Launch <Demo> & Review',
  sessionId: 'session-1',
  createdAt: '2026-06-11T10:00:00.000Z',
  durationSeconds: 65,
  files: [],
};

const bundleFiles = [
  {
    label: 'Host Camera',
    fileName: 'host.webm',
    zipPath: 'tracks/01_host.webm',
    size: 128,
    type: 'video/webm',
    kind: 'video' as const,
  },
  {
    label: 'Host Mic',
    fileName: 'host-audio.webm',
    zipPath: 'tracks/02_host-audio.webm',
    size: 64,
    type: 'audio/webm',
    kind: 'audio' as const,
  },
];

const audioStemFiles = [
  {
    label: 'Host Mic WAV stem',
    format: 'wav' as const,
    zipPath: 'audio-stems/02_host-audio.wav',
    size: 1024,
    type: 'audio/wav',
    sourceTrackIndex: 2,
    sourceZipPath: 'tracks/02_host-audio.webm',
    sampleRate: 48000,
    channels: 1,
    bitDepth: 16 as const,
    encoding: 'pcm_s16le' as const,
  },
];

const markers: RecordingMarker[] = [
  {
    id: 'marker-1',
    label: 'Clip this "answer"',
    seconds: 12.5,
    createdAt: '2026-06-11T10:00:12.500Z',
  },
];

describe('recording bundle editor export', () => {
  it('builds a Final Cut Pro XML project starter with tracks, stems, and markers', () => {
    const xml = buildFinalCutProXml(source, bundleFiles, audioStemFiles, markers);

    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<fcpxml version="1\.10">/);
    assert.match(xml, /Launch &lt;Demo&gt; &amp; Review/);
    assert.match(xml, /src="\.\.\/tracks\/01_host\.webm"/);
    assert.match(xml, /src="\.\.\/audio-stems\/02_host-audio\.wav"/);
    assert.match(xml, /audioRole="dialogue"/);
    assert.match(xml, /value="Clip this &quot;answer&quot;"/);
  });

  it('includes the FCPXML sidecar and manifest entry in recording bundles', async () => {
    const bundle = await createRecordingBundle({
      ...source,
      files: [
        {
          label: 'Host Camera',
          fileName: 'host.webm',
          blob: new Blob(['video-track'], { type: 'video/webm' }),
          kind: 'video',
        },
      ],
      markers,
    } as any);
    const text = new TextDecoder().decode(await bundle.arrayBuffer());

    assert.match(text, /editor\/local_recording_timeline\.fcpxml/);
    assert.match(text, /Final Cut Pro XML/);
    assert.match(text, /<fcpxml version="1\.10">/);
  });
});
