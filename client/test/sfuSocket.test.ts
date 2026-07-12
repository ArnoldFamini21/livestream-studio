import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSfuWsUrl } from '../src/utils/apiClient.ts';
import {
  areSfuRemoteStreamsReady,
  parseSfuInbound,
  SfuSocketSession,
  type SfuSocketLike,
} from '../src/utils/sfuSocket.ts';

function mediaTrack(kind: 'audio' | 'video', readyState: MediaStreamTrackState = 'live'): MediaStreamTrack {
  return { kind, readyState } as MediaStreamTrack;
}

function mediaStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  } as MediaStream;
}

class FakeSocket implements SfuSocketLike {
  readonly readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({} as Event);
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

describe('SFU socket URL resolution', () => {
  it('uses the media server configuration while switching the endpoint to /sfu', () => {
    assert.equal(resolveSfuWsUrl({ VITE_MEDIA_WS_URL: 'wss://media.example.test/rtmp' }), 'wss://media.example.test/sfu');
    assert.equal(resolveSfuWsUrl({ VITE_MEDIA_WS_URL: 'ws://localhost:3002/rtmp/' }), 'ws://localhost:3002/sfu');
  });
});

describe('parseSfuInbound', () => {
  it('only accepts bounded SFU message shapes', () => {
    assert.deepEqual(parseSfuInbound({ type: 'sfu-producer-added', producerId: 'alice' }), {
      type: 'sfu-producer-added', producerId: 'alice',
    });
    assert.deepEqual(parseSfuInbound({
      type: 'sfu-transport-ice', side: 'subscribe', candidate: { candidate: 'candidate:1', sdpMLineIndex: 0 },
    }), {
      type: 'sfu-transport-ice', side: 'subscribe', candidate: { candidate: 'candidate:1', sdpMLineIndex: 0, sdpMid: null },
    });
    assert.deepEqual(parseSfuInbound({
      type: 'sfu-transport-offer',
      side: 'subscribe',
      sdp: 'offer',
      producerMids: { alice: { video: 'video-0', audio: 'audio-1' } },
    }), {
      type: 'sfu-transport-offer',
      side: 'subscribe',
      sdp: 'offer',
      producerMids: { alice: { video: 'video-0', audio: 'audio-1' } },
    });
    assert.equal(parseSfuInbound({ type: 'sfu-transport-offer', side: 'bad', sdp: 'x' }), null);
  });
});

describe('SFU remote media readiness', () => {
  it('waits for every advertised audio and video track before cutting mesh media', () => {
    const producers = new Set(['alice', 'bob']);
    const expected = new Map([
      ['alice', new Set<'audio' | 'video'>(['audio', 'video'])],
      ['bob', new Set<'audio' | 'video'>(['audio'])],
    ]);
    const incomplete = new Map([
      ['alice', mediaStream([mediaTrack('video'), mediaTrack('audio')])],
      ['bob', mediaStream([mediaTrack('audio', 'ended')])],
    ]);
    assert.equal(areSfuRemoteStreamsReady(producers, expected, incomplete), false);

    const complete = new Map(incomplete);
    complete.set('bob', mediaStream([mediaTrack('audio')]));
    assert.equal(areSfuRemoteStreamsReady(producers, expected, complete), true);
  });

  it('does not declare readiness before producers and their media map arrive', () => {
    assert.equal(areSfuRemoteStreamsReady([], new Map(), new Map()), false);
    assert.equal(areSfuRemoteStreamsReady(['alice'], new Map(), new Map()), false);
  });
});

describe('SfuSocketSession', () => {
  it('authenticates before joining and only publishes when a local video is available', () => {
    const socket = new FakeSocket();
    let ready = 0;
    const session = new SfuSocketSession({
      token: 'signed-token',
      localVideoTrack: null,
      downlinkKbps: 4500,
      url: 'ws://media.test/sfu',
      createWebSocket: () => socket,
      onReady: () => { ready += 1; },
    });
    session.connect();
    socket.open();
    socket.receive({ type: 'sfu-ready', roomId: 'room-1', participantId: 'guest-1' });

    assert.deepEqual(socket.sent, [
      { type: 'sfu-auth', token: 'signed-token' },
      { type: 'sfu-join', downlinkKbps: 4500 },
    ]);
    assert.equal(ready, 1);
    session.close();
    assert.equal(socket.closed, true);
  });

  it('publishes a camera that becomes available after joining and unpublishes when it stops', () => {
    const socket = new FakeSocket();
    const session = new SfuSocketSession({
      token: 'signed-token',
      localVideoTrack: null,
      downlinkKbps: 4500,
      url: 'ws://media.test/sfu',
      createWebSocket: () => socket,
    });
    session.connect();
    socket.open();
    socket.receive({ type: 'sfu-ready', roomId: 'room-1', participantId: 'guest-1' });
    const camera = {
      kind: 'video',
      readyState: 'live',
      getSettings: () => ({ width: 640, height: 360, frameRate: 30 }),
    } as MediaStreamTrack;

    session.setLocalVideoTrack(camera);
    session.setLocalVideoTrack(null);

    assert.equal((socket.sent[2] as { type?: string }).type, 'sfu-publish');
    assert.deepEqual((socket.sent[2] as { layers?: unknown }).layers, [
      { rid: 'h', bitrateKbps: 700, scaleResolutionDownBy: 1 },
    ]);
    assert.deepEqual(socket.sent[3], { type: 'sfu-unpublish' });
    session.close();
  });

  it('publishes microphone-only sessions and renegotiates when video becomes available', () => {
    const socket = new FakeSocket();
    const microphone = { kind: 'audio', readyState: 'live', id: 'microphone' } as MediaStreamTrack;
    const session = new SfuSocketSession({
      token: 'signed-token',
      localVideoTrack: null,
      localAudioTrack: microphone,
      downlinkKbps: 4500,
      url: 'ws://media.test/sfu',
      createWebSocket: () => socket,
    });
    session.connect();
    socket.open();
    socket.receive({ type: 'sfu-ready', roomId: 'room-1', participantId: 'guest-1' });

    assert.deepEqual(socket.sent[2], { type: 'sfu-publish', layers: [], audio: true });

    const camera = {
      kind: 'video',
      readyState: 'live',
      getSettings: () => ({ width: 640, height: 360, frameRate: 30 }),
    } as MediaStreamTrack;
    session.setLocalVideoTrack(camera);
    assert.deepEqual(socket.sent[3], {
      type: 'sfu-publish',
      layers: [{ rid: 'h', bitrateKbps: 700, scaleResolutionDownBy: 1 }],
      audio: true,
    });
    session.close();
  });
});
