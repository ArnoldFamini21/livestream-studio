import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAudioCodecPreferences,
  applyAudioSenderPriority,
  orderAudioCodecs,
  setOpusMusicParameters,
  transformDescriptionForMusicMode,
} from '../src/utils/audioTransport.ts';

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 111',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:111 H264/90000',
  'a=fmtp:111 level-asymmetry-allowed=1;packetization-mode=1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 109',
  'a=mid:2',
  'a=rtpmap:109 opus/48000/2',
  '',
].join('\r\n');

describe('music mode Opus parameters', () => {
  it('sets stereo and the music bitrate on every Opus fmtp, and only on Opus in audio sections', () => {
    const munged = setOpusMusicParameters(SDP);
    const lines = munged.split('\r\n');
    assert.ok(lines.includes('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000'));
    assert.ok(lines.includes('a=fmtp:63 111/111'), 'RED is left alone');
    assert.ok(lines.includes('a=fmtp:111 level-asymmetry-allowed=1;packetization-mode=1'), 'a video payload type 111 is not Opus');
    const added = lines.indexOf('a=fmtp:109 stereo=1;sprop-stereo=1;maxaveragebitrate=128000');
    assert.equal(added, lines.indexOf('a=rtpmap:109 opus/48000/2') + 1, 'a missing fmtp is added after its rtpmap');
    assert.ok(munged.endsWith('\r\n'), 'keeps the trailing line break');
  });

  it('replaces existing values instead of duplicating them, so munging twice is stable', () => {
    const sdp = SDP.replace('a=fmtp:111 minptime=10;useinbandfec=1', 'a=fmtp:111 minptime=10;stereo=0;maxaveragebitrate=32000');
    const once = setOpusMusicParameters(sdp);
    assert.ok(once.includes('a=fmtp:111 minptime=10;stereo=1;maxaveragebitrate=128000;sprop-stereo=1\r\n'));
    assert.equal(setOpusMusicParameters(once), once);
  });

  it('only rewrites descriptions in music mode', () => {
    const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: SDP };
    assert.equal(transformDescriptionForMusicMode(offer, false), offer);
    assert.match(transformDescriptionForMusicMode(offer, true).sdp!, /stereo=1;sprop-stereo=1/);
    const rollback: RTCSessionDescriptionInit = { type: 'rollback' };
    assert.equal(transformDescriptionForMusicMode(rollback, true), rollback);
  });
});

const codecs = [
  { mimeType: 'audio/opus', clockRate: 48_000, channels: 2 },
  { mimeType: 'audio/red', clockRate: 48_000, channels: 2 },
  { mimeType: 'audio/G722', clockRate: 8_000 },
];

describe('audio codec order', () => {
  it('puts RED first for voice and drops it for music', () => {
    assert.deepEqual(orderAudioCodecs(codecs, false)!.map((codec) => codec.mimeType), ['audio/red', 'audio/opus', 'audio/G722']);
    assert.deepEqual(orderAudioCodecs(codecs, true)!.map((codec) => codec.mimeType), ['audio/opus', 'audio/G722']);
    assert.equal(orderAudioCodecs([codecs[0]], false), null, 'no RED: keep the browser defaults');
  });

  it('applies the order to live audio transceivers only', () => {
    const calls: Array<{ id: string; codecs: unknown[] }> = [];
    const transceiver = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
      receiver: { track: { kind } },
      setCodecPreferences: (list: unknown[]) => { calls.push({ id, codecs: list }); },
      ...extra,
    });
    const pc = {
      getTransceivers: () => [
        transceiver('mic', 'audio'),
        transceiver('camera', 'video'),
        transceiver('old', 'audio', { stopped: true }),
        { receiver: { track: { kind: 'audio' } } },
      ],
    };
    assert.equal(applyAudioCodecPreferences(pc, false, () => ({ codecs: codecs as RTCRtpCodec[] })), 1);
    assert.equal(calls[0].id, 'mic');
    assert.equal((calls[0].codecs[0] as RTCRtpCodec).mimeType, 'audio/red');
    assert.equal(applyAudioCodecPreferences(pc, false, null), 0, 'no capabilities API');
  });
});

describe('audio sender priority', () => {
  it('marks every encoding high priority', async () => {
    let applied: RTCRtpSendParameters | null = null;
    const sender = {
      getParameters: () => ({ encodings: [{ active: true }] }) as unknown as RTCRtpSendParameters,
      setParameters: async (parameters: RTCRtpSendParameters) => { applied = parameters; },
    };
    assert.equal(await applyAudioSenderPriority(sender), true);
    assert.deepEqual(applied!.encodings, [{ active: true, priority: 'high', networkPriority: 'high' }]);
  });

  it('skips senders that are not negotiated yet or refuse the change', async () => {
    assert.equal(await applyAudioSenderPriority(null), false);
    assert.equal(await applyAudioSenderPriority({
      getParameters: () => ({ encodings: [] }) as unknown as RTCRtpSendParameters,
      setParameters: async () => {},
    }), false);
    assert.equal(await applyAudioSenderPriority({
      getParameters: () => ({ encodings: [{}] }) as unknown as RTCRtpSendParameters,
      setParameters: async () => { throw new Error('InvalidModificationError'); },
    }), false);
  });
});
