import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addTrackWithOptionalSimulcast,
  buildVideoSimulcastEncodings,
  buildVideoSimulcastEncodingsForTrack,
  refreshSenderVideoEncodingParameters,
  type PeerConnectionLike,
} from '../src/utils/webrtcSimulcast.ts';

function fakeTrack(
  kind: MediaStreamTrack['kind'],
  settings: MediaTrackSettings = {},
  readyState: MediaStreamTrackState = 'live'
): MediaStreamTrack {
  return {
    kind,
    readyState,
    getSettings: () => settings,
  } as MediaStreamTrack;
}

function fakeStream(): MediaStream {
  return {} as MediaStream;
}

describe('WebRTC simulcast sender policy', () => {
  it('builds three bounded layers for 1080p video', () => {
    const encodings = buildVideoSimulcastEncodings({
      width: 1920,
      height: 1080,
      frameRate: 30,
    });

    assert.deepEqual(
      encodings.map((encoding) => ({
        rid: encoding.rid,
        scaleResolutionDownBy: encoding.scaleResolutionDownBy,
        maxBitrate: encoding.maxBitrate,
        maxFramerate: encoding.maxFramerate,
      })),
      [
        { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 2_800_000, maxFramerate: 30 },
        { rid: 'm', scaleResolutionDownBy: 2, maxBitrate: 1_200_000, maxFramerate: 30 },
        { rid: 'l', scaleResolutionDownBy: 4, maxBitrate: 350_000, maxFramerate: 20 },
      ]
    );
  });

  it('builds two layers for 720p video and none for small video', () => {
    assert.deepEqual(
      buildVideoSimulcastEncodings({ width: 1280, height: 720, frameRate: 24 }).map((encoding) => encoding.rid),
      ['h', 'l']
    );

    assert.deepEqual(
      buildVideoSimulcastEncodings({ width: 640, height: 360, frameRate: 30 }),
      []
    );
  });

  it('ignores audio and ended video tracks', () => {
    assert.deepEqual(buildVideoSimulcastEncodingsForTrack(fakeTrack('audio')), []);
    assert.deepEqual(
      buildVideoSimulcastEncodingsForTrack(fakeTrack('video', { width: 1920, height: 1080 }, 'ended')),
      []
    );
  });

  it('uses addTransceiver with sendEncodings when simulcast is available', () => {
    const stream = fakeStream();
    const track = fakeTrack('video', { width: 1920, height: 1080, frameRate: 30 });
    const sender = {} as RTCRtpSender;
    const calls: Array<{ method: string; init?: RTCRtpTransceiverInit }> = [];
    const connection: PeerConnectionLike = {
      addTrack: () => {
        throw new Error('addTrack should not be called');
      },
      addTransceiver: (_trackOrKind, init) => {
        calls.push({ method: 'addTransceiver', init });
        return { sender } as RTCRtpTransceiver;
      },
    };

    const result = addTrackWithOptionalSimulcast(connection, track, stream);

    assert.equal(result, sender);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.direction, 'sendrecv');
    assert.equal(calls[0].init?.streams?.[0], stream);
    assert.deepEqual(calls[0].init?.sendEncodings?.map((encoding) => encoding.rid), ['h', 'm', 'l']);
  });

  it('falls back to addTrack when browser simulcast setup rejects', () => {
    const stream = fakeStream();
    const track = fakeTrack('video', { width: 1920, height: 1080, frameRate: 30 });
    const fallbackSender = {} as RTCRtpSender;
    const calls: string[] = [];
    const originalWarn = console.warn;
    const connection: PeerConnectionLike = {
      addTrack: (receivedTrack, receivedStream) => {
        assert.equal(receivedTrack, track);
        assert.equal(receivedStream, stream);
        calls.push('addTrack');
        return fallbackSender;
      },
      addTransceiver: () => {
        calls.push('addTransceiver');
        throw new Error('sendEncodings unsupported');
      },
    };

    try {
      console.warn = () => {};
      const result = addTrackWithOptionalSimulcast(connection, track, stream);

      assert.equal(result, fallbackSender);
      assert.deepEqual(calls, ['addTransceiver', 'addTrack']);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('refreshes existing sender encoding parameters after video track replacement', async () => {
    const track = fakeTrack('video', { width: 1920, height: 1080, frameRate: 60 });
    let appliedParameters: RTCRtpSendParameters | null = null;
    const sender = {
      getParameters: () => ({
        encodings: [
          { rid: 'h', maxBitrate: 100_000 },
          { rid: 'l', maxBitrate: 50_000 },
        ],
      }),
      setParameters: async (parameters: RTCRtpSendParameters) => {
        appliedParameters = parameters;
      },
    } as RTCRtpSender;

    const refreshed = await refreshSenderVideoEncodingParameters(sender, track);

    assert.equal(refreshed, true);
    assert.equal(appliedParameters?.encodings?.[0]?.maxBitrate, 2_800_000);
    assert.equal(appliedParameters?.encodings?.[0]?.maxFramerate, 60);
    assert.equal(appliedParameters?.encodings?.[1]?.maxBitrate, 1_200_000);
    assert.equal(appliedParameters?.encodings?.[1]?.maxFramerate, 30);
  });
});
