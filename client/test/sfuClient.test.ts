import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SfuClientSession,
  encodingsToWireLayers,
  type SfuClientOutbound,
} from '../src/utils/sfuClient.ts';
import { SfuWebRtcTransport, type SfuPeerConnectionLike } from '../src/utils/sfuWebRtcTransport.ts';

function createSession(events = {}) {
  const sent: SfuClientOutbound[] = [];
  const session = new SfuClientSession((message) => sent.push(message), events);
  return { session, sent };
}

describe('encodingsToWireLayers', () => {
  it('maps simulcast encodings to compact wire layers in kbps', () => {
    const layers = encodingsToWireLayers([
      { rid: 'h', maxBitrate: 2_800_000, scaleResolutionDownBy: 1 },
      { rid: 'm', maxBitrate: 1_200_000, scaleResolutionDownBy: 2 },
      { rid: 'l', maxBitrate: 350_000, scaleResolutionDownBy: 4 },
    ]);
    assert.deepEqual(layers, [
      { rid: 'h', bitrateKbps: 2800, scaleResolutionDownBy: 1 },
      { rid: 'm', bitrateKbps: 1200, scaleResolutionDownBy: 2 },
      { rid: 'l', bitrateKbps: 350, scaleResolutionDownBy: 4 },
    ]);
  });

  it('drops encodings without a usable bitrate and defaults rid/scale', () => {
    const layers = encodingsToWireLayers([
      { maxBitrate: 1_000_000 },
      { rid: 'x', maxBitrate: 0 },
      { rid: 'y' } as RTCRtpEncodingParameters,
    ]);
    assert.deepEqual(layers, [{ rid: 's0', bitrateKbps: 1000, scaleResolutionDownBy: 1 }]);
  });
});

describe('SfuClientSession outbound', () => {
  it('sends join with a clamped downlink', () => {
    const { session, sent } = createSession();
    session.join(6000);
    assert.deepEqual(sent, [{ type: 'sfu-join', downlinkKbps: 6000 }]);
  });

  it('publishes wire layers and refuses empty encodings', () => {
    const { session, sent } = createSession();
    assert.equal(session.publish([]), false);
    assert.equal(sent.length, 0);

    const ok = session.publish([{ rid: 'h', maxBitrate: 2_000_000, scaleResolutionDownBy: 1 }]);
    assert.equal(ok, true);
    assert.equal(session.isPublishing(), true);
    assert.equal(sent[0].type, 'sfu-publish');
  });

  it('supports audio-only publishing and advertises audio with video publishes', () => {
    const { session, sent } = createSession();
    assert.equal(session.publish([], true), true);
    assert.deepEqual(sent[0], { type: 'sfu-publish', layers: [], audio: true });

    session.publish([{ rid: 'h', maxBitrate: 1_000_000, scaleResolutionDownBy: 1 }], true);
    assert.deepEqual(sent[1], {
      type: 'sfu-publish',
      layers: [{ rid: 'h', bitrateKbps: 1000, scaleResolutionDownBy: 1 }],
      audio: true,
    });
  });

  it('only re-sends downlink when the estimate moves more than 10%', () => {
    const { session, sent } = createSession();
    session.join(4000);
    sent.length = 0;
    session.reportDownlink(4200); // within 10% -> ignored
    assert.equal(sent.length, 0);
    session.reportDownlink(6000); // >10% -> sent
    assert.deepEqual(sent, [{ type: 'sfu-downlink', downlinkKbps: 6000 }]);
  });

  it('unpublish only fires when publishing', () => {
    const { session, sent } = createSession();
    session.unpublish();
    assert.equal(sent.length, 0);
    session.publish([{ rid: 'h', maxBitrate: 1_000_000, scaleResolutionDownBy: 1 }]);
    sent.length = 0;
    session.unpublish();
    assert.deepEqual(sent, [{ type: 'sfu-unpublish' }]);
  });

  it('leave clears state and only fires when joined', () => {
    const { session, sent } = createSession();
    session.leave();
    assert.equal(sent.length, 0);
    session.join(5000);
    session.handleServerMessage({ type: 'sfu-producers', producers: ['alice'] });
    sent.length = 0;
    session.leave();
    assert.deepEqual(sent, [{ type: 'sfu-leave' }]);
    assert.deepEqual(session.getRemoteProducers(), []);
  });
});

describe('SfuClientSession inbound', () => {
  it('tracks the producer set from the initial list and add/remove events', () => {
    const changes: string[][] = [];
    const { session } = createSession({ onProducersChanged: (p: string[]) => changes.push(p) });
    session.handleServerMessage({ type: 'sfu-producers', producers: ['alice', 'bob'] });
    session.handleServerMessage({ type: 'sfu-producer-added', producerId: 'carol' });
    session.handleServerMessage({ type: 'sfu-producer-removed', producerId: 'alice' });

    assert.deepEqual(session.getRemoteProducers().sort(), ['bob', 'carol']);
    assert.deepEqual(changes[changes.length - 1].sort(), ['bob', 'carol']);
  });

  it('ignores duplicate producer-added and unknown producer-removed', () => {
    let changeCount = 0;
    const { session } = createSession({ onProducersChanged: () => { changeCount += 1; } });
    session.handleServerMessage({ type: 'sfu-producer-added', producerId: 'alice' });
    session.handleServerMessage({ type: 'sfu-producer-added', producerId: 'alice' });
    session.handleServerMessage({ type: 'sfu-producer-removed', producerId: 'ghost' });
    assert.equal(changeCount, 1);
    assert.deepEqual(session.getRemoteProducers(), ['alice']);
  });

  it('records the forwarded layer per producer and emits layer changes', () => {
    const layerChanges: Array<[string, string | null]> = [];
    const { session } = createSession({ onLayerChanged: (id: string, rid: string | null) => layerChanges.push([id, rid]) });
    session.handleServerMessage({ type: 'sfu-layer', producerId: 'alice', rid: 'h' });
    assert.equal(session.getForwardedLayer('alice'), 'h');
    session.handleServerMessage({ type: 'sfu-layer', producerId: 'alice', rid: 'm', reason: 'downgrade' });
    assert.equal(session.getForwardedLayer('alice'), 'm');
    assert.equal(session.getForwardedLayer('bob'), null);
    assert.deepEqual(layerChanges, [['alice', 'h'], ['alice', 'm']]);
  });

  it('surfaces server errors', () => {
    const errors: string[] = [];
    const { session } = createSession({ onError: (message: string) => errors.push(message) });
    session.handleServerMessage({ type: 'sfu-error', message: 'nope' });
    assert.deepEqual(errors, ['nope']);
  });

  it('clears the forwarded layer when its producer is removed', () => {
    const { session } = createSession();
    session.handleServerMessage({ type: 'sfu-producer-added', producerId: 'alice' });
    session.handleServerMessage({ type: 'sfu-layer', producerId: 'alice', rid: 'h' });
    session.handleServerMessage({ type: 'sfu-producer-removed', producerId: 'alice' });
    assert.equal(session.getForwardedLayer('alice'), null);
  });

  it('routes transport offers and ICE candidates to the media-plane owner', () => {
    const offers: string[] = [];
    const candidates: string[] = [];
    const { session } = createSession({
      onTransportOffer: (offer: { sdp: string }) => offers.push(offer.sdp),
      onTransportIce: (_side: string, candidate: { candidate: string }) => candidates.push(candidate.candidate),
    });
    session.handleServerMessage({ type: 'sfu-transport-offer', side: 'publish', sdp: 'offer-sdp' });
    session.handleServerMessage({
      type: 'sfu-transport-ice',
      side: 'subscribe',
      candidate: { candidate: 'candidate:1', sdpMLineIndex: 0 },
    });
    assert.deepEqual(offers, ['offer-sdp']);
    assert.deepEqual(candidates, ['candidate:1']);
  });
});

class FakePeerConnection implements SfuPeerConnectionLike {
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  readonly candidates: RTCIceCandidateInit[] = [];
  readonly replacedTracks: Array<MediaStreamTrack | null> = [];
  closed = false;
  readonly transceivers: RTCRtpTransceiver[];
  readonly transceiver: RTCRtpTransceiver;

  constructor(kinds: Array<'audio' | 'video'> = ['video']) {
    this.transceivers = kinds.map((kind, index) => ({
      mid: `${kind}-${index}`,
      direction: 'recvonly',
      receiver: { track: { kind } },
      sender: { replaceTrack: async (track: MediaStreamTrack | null) => { this.replacedTracks.push(track); } },
    } as unknown as RTCRtpTransceiver));
    this.transceiver = this.transceivers[0];
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-sdp' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.candidates.push(candidate);
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers;
  }

  close(): void {
    this.closed = true;
  }
}

function fakeMediaStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  } as unknown as MediaStream;
}

describe('SfuWebRtcTransport', () => {
  it('answers a publish offer, attaches the local video, and drains early ICE', async () => {
    const sent: SfuClientOutbound[] = [];
    const publishPc = new FakePeerConnection();
    const transport = new SfuWebRtcTransport((message) => sent.push(message), {
      createPeerConnection: () => publishPc,
    });
    const track = { kind: 'video', readyState: 'live' } as MediaStreamTrack;
    transport.setPublishTrack(track);
    await transport.handleIce('publish', { candidate: 'candidate:early', sdpMLineIndex: 0 });
    await transport.handleOffer({ side: 'publish', sdp: 'publish-offer' });

    assert.equal(publishPc.replacedTracks[0], track);
    assert.deepEqual(publishPc.candidates, [{ candidate: 'candidate:early', sdpMLineIndex: 0, sdpMid: null }]);
    assert.deepEqual(sent, [{ type: 'sfu-transport-answer', side: 'publish', sdp: 'answer-sdp' }]);
  });

  it('replaces an established publish track without rebuilding the transport', async () => {
    const publishPc = new FakePeerConnection();
    const transport = new SfuWebRtcTransport(() => undefined, {
      createPeerConnection: () => publishPc,
    });
    const first = { kind: 'video', readyState: 'live', id: 'camera' } as MediaStreamTrack;
    const second = { kind: 'video', readyState: 'live', id: 'screen' } as MediaStreamTrack;
    transport.setPublishTrack(first);
    await transport.handleOffer({ side: 'publish', sdp: 'publish-offer' });
    transport.setPublishTrack(second);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(publishPc.replacedTracks, [first, second]);
  });

  it('attaches local audio and video to one SFU publish connection', async () => {
    const publishPc = new FakePeerConnection(['video', 'audio']);
    const transport = new SfuWebRtcTransport(() => undefined, {
      createPeerConnection: () => publishPc,
    });
    const video = { kind: 'video', readyState: 'live', id: 'camera' } as MediaStreamTrack;
    const audio = { kind: 'audio', readyState: 'live', id: 'microphone' } as MediaStreamTrack;
    transport.setPublishTrack(video);
    transport.setPublishAudioTrack(audio);
    await transport.handleOffer({ side: 'publish', sdp: 'publish-offer' });

    assert.deepEqual(publishPc.replacedTracks, [video, audio]);
  });

  it('maps subscribed tracks to the producer supplied by the server', async () => {
    const sent: SfuClientOutbound[] = [];
    const subscribePc = new FakePeerConnection();
    const delivered: string[] = [];
    const transport = new SfuWebRtcTransport((message) => sent.push(message), {
      createPeerConnection: () => subscribePc,
      createMediaStream: fakeMediaStream,
      onRemoteStream: (producerId) => delivered.push(producerId),
    });
    await transport.handleOffer({
      side: 'subscribe',
      sdp: 'subscribe-offer',
      producerMids: { alice: { video: 'video-0' } },
    });
    subscribePc.ontrack?.({
      transceiver: subscribePc.transceiver,
      streams: [{} as MediaStream],
      track: { kind: 'video', readyState: 'live', muted: false } as MediaStreamTrack,
    } as RTCTrackEvent);

    assert.deepEqual(delivered, ['alice']);
    assert.deepEqual(sent, [{ type: 'sfu-transport-answer', side: 'subscribe', sdp: 'answer-sdp' }]);
  });

  it('waits for incoming RTP before exposing a muted subscribed track', async () => {
    const subscribePc = new FakePeerConnection();
    const delivered: string[] = [];
    const transport = new SfuWebRtcTransport(() => undefined, {
      createPeerConnection: () => subscribePc,
      createMediaStream: fakeMediaStream,
      onRemoteStream: (producerId) => delivered.push(producerId),
    });
    await transport.handleOffer({
      side: 'subscribe',
      sdp: 'subscribe-offer',
      producerMids: { alice: { video: 'video-0' } },
    });
    let onUnmute: (() => void) | null = null;
    const remoteTrack = {
      kind: 'video',
      readyState: 'live',
      muted: true,
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'unmute' && typeof listener === 'function') onUnmute = listener as () => void;
      },
    } as unknown as MediaStreamTrack;
    subscribePc.ontrack?.({
      transceiver: subscribePc.transceiver,
      streams: [{} as MediaStream],
      track: remoteTrack,
    } as RTCTrackEvent);

    assert.deepEqual(delivered, []);
    assert.ok(onUnmute);
    (onUnmute as () => void)();
    assert.deepEqual(delivered, ['alice']);
  });

  it('combines subscribed audio and video tracks into one producer stream', async () => {
    const subscribePc = new FakePeerConnection(['video', 'audio']);
    const delivered: MediaStream[] = [];
    const transport = new SfuWebRtcTransport(() => undefined, {
      createPeerConnection: () => subscribePc,
      createMediaStream: fakeMediaStream,
      onRemoteStream: (_producerId, stream) => delivered.push(stream),
    });
    await transport.handleOffer({
      side: 'subscribe',
      sdp: 'subscribe-offer',
      producerMids: { alice: { video: 'video-0', audio: 'audio-1' } },
    });
    const video = { kind: 'video', readyState: 'live', muted: false } as MediaStreamTrack;
    const audio = { kind: 'audio', readyState: 'live', muted: false } as MediaStreamTrack;

    subscribePc.ontrack?.({
      transceiver: subscribePc.transceivers[0],
      streams: [],
      track: video,
    } as unknown as RTCTrackEvent);
    subscribePc.ontrack?.({
      transceiver: subscribePc.transceivers[1],
      streams: [],
      track: audio,
    } as unknown as RTCTrackEvent);

    assert.equal(delivered.length, 2);
    assert.deepEqual(delivered[1].getVideoTracks(), [video]);
    assert.deepEqual(delivered[1].getAudioTracks(), [audio]);
  });
});
