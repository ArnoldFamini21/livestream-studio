import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpPacket,
  useSdesRTPStreamId,
  type RTCIceCandidate,
} from 'werift';
import type { SfuIceConfig, SfuIceConfigProvider } from './sfuIceServers.js';

/**
 * WebRTC media transport for the studio SFU.
 *
 * Terminates one publisher connection per participant with optional Opus
 * audio and VP8 simulcast video. Each subscriber receives one audio and/or
 * video forward track for every producer. Video follows the control plane's
 * selected simulcast layer; audio is always forwarded. Packets are cloned per
 * consumer so sender header rewrites never alias across subscribers.
 */

export interface SfuSessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface SfuIceCandidatePayload {
  candidate: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
}

export type SfuTransportSide = 'publish' | 'subscribe';
export type SfuPeerConnectionFactory = (withRidExtension: boolean, iceConfig: SfuIceConfig | null) => RTCPeerConnection;

export interface SfuTransportOptions {
  /** TURN for the SFU's own candidates (see sfuIceServers.ts); none when omitted. */
  resolveIceConfig?: SfuIceConfigProvider;
  /** Shortest gap between two keyframe requests for one publisher layer. */
  keyframeRequestIntervalMs?: number;
}

/** Enough to ask the publisher's browser for a fresh keyframe (werift RTCRtpReceiver). */
interface KeyframeReceiver {
  sendRtcpPLI(mediaSsrc: number): Promise<void>;
}

const DEFAULT_KEYFRAME_REQUEST_INTERVAL_MS = 500;

export interface SfuTransportEvents {
  onIceCandidate?: (
    participantId: string,
    side: SfuTransportSide,
    candidate: SfuIceCandidatePayload
  ) => void;
}

export interface SfuProducerMedia {
  producerId: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface SfuProducerMids {
  video?: string;
  audio?: string;
}

const AUDIO_CODECS = [
  new RTCRtpCodecParameters({
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    payloadType: 111,
    parameters: 'minptime=10;useinbandfec=1',
  }),
];

const VIDEO_CODECS = [
  new RTCRtpCodecParameters({
    mimeType: 'video/VP8',
    clockRate: 90000,
    payloadType: 96,
    rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
  }),
];

const MAX_RIDS_PER_PUBLISHER = 3;

interface PublisherState {
  pc: RTCPeerConnection;
  rids: string[];
  packetCounts: Map<string, number>;
  audioPacketCount: number;
  videoReceiver: KeyframeReceiver | null;
  /** rid -> media SSRC, learnt from each layer's packets. */
  ridSsrcs: Map<string, number>;
  /** Layers a keyframe was asked for before their SSRC was known. */
  pendingKeyframes: Set<string>;
  lastKeyframeRequestAt: Map<string, number>;
  keyframeRequests: number;
}

interface SubscriberMediaForward {
  track: MediaStreamTrack;
  mid: string | null;
}

interface SubscriberVideoForward extends SubscriberMediaForward {
  rid: string | null;
}

interface SubscriberForward {
  video?: SubscriberVideoForward;
  audio?: SubscriberMediaForward;
}

interface SubscriberState {
  pc: RTCPeerConnection;
  forwards: Map<string, SubscriberForward>; // producerId -> forward
}

function clonePacket(rtp: RtpPacket): RtpPacket {
  return RtpPacket.deSerialize(rtp.serialize());
}

export class SfuMediaTransport {
  private readonly publishers = new Map<string, PublisherState>();
  private readonly subscribers = new Map<string, SubscriberState>();
  private readonly publishAttempts = new Map<string, symbol>();

  private readonly resolveIceConfig?: SfuIceConfigProvider;
  private readonly keyframeRequestIntervalMs: number;

  constructor(
    private readonly events: SfuTransportEvents = {},
    private readonly createPeerConnection?: SfuPeerConnectionFactory,
    options: SfuTransportOptions = {},
  ) {
    this.resolveIceConfig = options.resolveIceConfig;
    this.keyframeRequestIntervalMs = options.keyframeRequestIntervalMs ?? DEFAULT_KEYFRAME_REQUEST_INTERVAL_MS;
  }

  /** The ICE config for a new peer connection; a TURN outage must not stop the SFU trying. */
  private async iceConfig(): Promise<SfuIceConfig | null> {
    if (!this.resolveIceConfig) return null;
    try {
      return await this.resolveIceConfig();
    } catch {
      return null;
    }
  }

  /** How many keyframe requests were sent to a publisher (for tests/metrics). */
  getPublisherKeyframeRequestCount(participantId: string): number {
    return this.publishers.get(participantId)?.keyframeRequests ?? 0;
  }

  /**
   * Ask a publisher for a keyframe on one simulcast layer, so a subscriber
   * that just joined or switched layer gets a picture now instead of after
   * the next periodic keyframe (Chrome's VP8 sends none on its own).
   */
  requestKeyframe(producerId: string, rid: string): boolean {
    const state = this.publishers.get(producerId);
    if (!state?.videoReceiver) return false;
    const ssrc = state.ridSsrcs.get(rid);
    if (ssrc === undefined) {
      // The layer has not sent a packet yet; ask as soon as it does.
      state.pendingKeyframes.add(rid);
      return false;
    }
    const now = Date.now();
    const last = state.lastKeyframeRequestAt.get(rid);
    if (last !== undefined && now - last < this.keyframeRequestIntervalMs) return false;
    state.lastKeyframeRequestAt.set(rid, now);
    state.keyframeRequests += 1;
    void state.videoReceiver.sendRtcpPLI(ssrc).catch(() => undefined);
    return true;
  }

  /** Keyframes for every layer a subscriber currently receives (it just connected). */
  private requestKeyframesFor(consumerId: string): void {
    const state = this.subscribers.get(consumerId);
    if (!state) return;
    for (const [producerId, forward] of state.forwards) {
      if (forward.video?.rid) this.requestKeyframe(producerId, forward.video.rid);
    }
  }

  getPublisherCount(): number {
    return this.publishers.size;
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  /** Per-rid RTP packet counts received from a publisher (for tests/metrics). */
  getPublisherRidCounts(participantId: string): Record<string, number> {
    const state = this.publishers.get(participantId);
    if (!state) return {};
    return Object.fromEntries(state.packetCounts);
  }

  getPublisherAudioPacketCount(participantId: string): number {
    return this.publishers.get(participantId)?.audioPacketCount ?? 0;
  }

  private newPeerConnection(withRidExtension: boolean, iceConfig: SfuIceConfig | null): RTCPeerConnection {
    if (this.createPeerConnection) return this.createPeerConnection(withRidExtension, iceConfig);
    return new RTCPeerConnection({
      codecs: { audio: AUDIO_CODECS, video: VIDEO_CODECS },
      // A relay candidate on TURN: the only one a browser can reach on Render.
      ...(iceConfig ? { iceServers: iceConfig.iceServers, iceTransportPolicy: iceConfig.iceTransportPolicy } : {}),
      // One transport from the start. With werift's default "max-compat", each
      // m-line gets its own ICE transport; once the answer bundles them, the
      // extra one is orphaned and pc.close() never releases its UDP socket.
      bundlePolicy: 'max-bundle',
      ...(withRidExtension ? { headerExtensions: { video: [useSdesRTPStreamId()] } } : {}),
    });
  }

  private emitIce(participantId: string, side: SfuTransportSide, pc: RTCPeerConnection): void {
    pc.onIceCandidate.subscribe((candidate: RTCIceCandidate | undefined) => {
      if (!candidate) return;
      const current = side === 'publish' ? this.publishers.get(participantId) : this.subscribers.get(participantId);
      if (current?.pc !== pc) return;
      this.events.onIceCandidate?.(participantId, side, {
        candidate: candidate.candidate,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        sdpMid: candidate.sdpMid ?? null,
      });
    });
  }

  /** Create the server-side offer that receives a publisher's audio and simulcast video. */
  async createPublishOffer(
    participantId: string,
    rids: string[],
    hasAudio = false
  ): Promise<SfuSessionDescription> {
    const cleanRids = [...new Set(rids.filter((rid) => typeof rid === 'string' && rid.length > 0))]
      .slice(0, MAX_RIDS_PER_PUBLISHER);
    if (cleanRids.length === 0 && !hasAudio) {
      throw new Error('At least one audio or video track is required to publish');
    }
    // Reserve before waiting for the old PC. A disconnect or newer publish
    // invalidates this attempt even if it has not installed a PC yet.
    const attempt = Symbol(participantId);
    this.publishAttempts.set(participantId, attempt);
    const previous = this.publishers.get(participantId);
    this.publishers.delete(participantId);
    const iceConfig = this.resolveIceConfig ? this.iceConfig() : null;
    if (previous) await previous.pc.close().catch(() => undefined);
    const ice = iceConfig ? await iceConfig : null;
    if (this.publishAttempts.get(participantId) !== attempt) throw new Error('Publish transport was superseded');

    const pc = this.newPeerConnection(true, ice);
    const state: PublisherState = {
      pc,
      rids: cleanRids,
      packetCounts: new Map(),
      audioPacketCount: 0,
      videoReceiver: null,
      ridSsrcs: new Map(),
      pendingKeyframes: new Set(),
      lastKeyframeRequestAt: new Map(),
      keyframeRequests: 0,
    };
    this.publishers.set(participantId, state);
    this.emitIce(participantId, 'publish', pc);

    if (cleanRids.length > 0) {
      const transceiver = pc.addTransceiver('video', {
        direction: 'recvonly',
        simulcast: cleanRids.map((rid) => ({ rid, direction: 'recv' as const })),
      });
      state.videoReceiver = (transceiver as { receiver?: KeyframeReceiver }).receiver ?? null;

      transceiver.onTrack.subscribe((track: MediaStreamTrack) => {
        if (this.publishers.get(participantId) !== state) return;
        const rid = track.rid;
        if (!rid) return;
        if (typeof track.ssrc === 'number') state.ridSsrcs.set(rid, track.ssrc);
        track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
          if (this.publishers.get(participantId) !== state) return;
          this.injectPublisherRtp(participantId, rid, rtp);
        });
      });
    }

    if (hasAudio) {
      const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
      transceiver.onTrack.subscribe((track: MediaStreamTrack) => {
        if (this.publishers.get(participantId) !== state) return;
        track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
          if (this.publishers.get(participantId) !== state) return;
          this.injectPublisherAudioRtp(participantId, rtp);
        });
      });
    }

    const isCurrent = () => this.publishAttempts.get(participantId) === attempt && this.publishers.get(participantId) === state;
    try {
      const offer = await pc.createOffer();
      if (!isCurrent()) throw new Error('Publish transport was superseded');
      await pc.setLocalDescription(offer);
      if (!isCurrent()) throw new Error('Publish transport was superseded');
      const local = pc.localDescription;
      if (!local) throw new Error('Failed to create publish offer');
      return { type: 'offer', sdp: local.sdp };
    } catch (error) {
      if (this.publishers.get(participantId) === state) this.publishers.delete(participantId);
      if (this.publishAttempts.get(participantId) === attempt) this.publishAttempts.delete(participantId);
      await pc.close().catch(() => undefined);
      throw error;
    }
  }

  async setPublishAnswer(participantId: string, answer: { sdp: string }): Promise<void> {
    const state = this.publishers.get(participantId);
    if (!state) throw new Error('No publish transport for this participant');
    await state.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }

  async addPublishIceCandidate(participantId: string, candidate: SfuIceCandidatePayload): Promise<void> {
    const state = this.publishers.get(participantId);
    if (!state) return;
    await state.pc.addIceCandidate(candidate as never);
  }

  /**
   * Create (or extend) the server-side offer that sends forwarded producer
   * video to a subscriber. Returns the offer plus producer->mid mapping so the
   * client can associate ontrack events with producers.
   */
  async createSubscribeOffer(
    consumerId: string,
    producers: SfuProducerMedia[]
  ): Promise<{ description: SfuSessionDescription; producerMids: Record<string, SfuProducerMids> }> {
    const ice = this.resolveIceConfig && !this.subscribers.has(consumerId) ? await this.iceConfig() : null;
    let state = this.subscribers.get(consumerId);
    if (!state) {
      const pc = this.newPeerConnection(false, ice);
      const created: SubscriberState = { pc, forwards: new Map() };
      state = created;
      this.subscribers.set(consumerId, created);
      this.emitIce(consumerId, 'subscribe', pc);
      // Packets forwarded before DTLS is up are dropped, the first keyframe
      // with them: ask again once the subscriber can actually receive.
      pc.connectionStateChange?.subscribe((connectionState) => {
        if (connectionState === 'connected' && this.subscribers.get(consumerId) === created) {
          this.requestKeyframesFor(consumerId);
        }
      });
    }

    for (const producer of producers) {
      let forward = state.forwards.get(producer.producerId);
      if (!forward) {
        forward = {};
        state.forwards.set(producer.producerId, forward);
      }
      if (producer.hasVideo && !forward.video) {
        const track = new MediaStreamTrack({ kind: 'video' });
        const transceiver = state.pc.addTransceiver(track, { direction: 'sendonly' });
        const videoForward: SubscriberVideoForward = { track, mid: transceiver.mid ?? null, rid: null };
        forward.video = videoForward;
        // The subscriber lost a picture (packet loss, decoder reset): pass its
        // PLI on to the publisher of the layer it is watching.
        const subscriber = state;
        const producerId = producer.producerId;
        transceiver.sender?.onPictureLossIndication?.subscribe(() => {
          if (this.subscribers.get(consumerId) !== subscriber) return;
          if (subscriber.forwards.get(producerId)?.video !== videoForward || !videoForward.rid) return;
          this.requestKeyframe(producerId, videoForward.rid);
        });
      } else if (!producer.hasVideo) {
        forward.video = undefined;
      }
      if (producer.hasAudio && !forward.audio) {
        const track = new MediaStreamTrack({ kind: 'audio' });
        const transceiver = state.pc.addTransceiver(track, { direction: 'sendonly' });
        forward.audio = { track, mid: transceiver.mid ?? null };
      } else if (!producer.hasAudio) {
        forward.audio = undefined;
      }
    }

    const offer = await state.pc.createOffer();
    if (this.subscribers.get(consumerId) !== state) throw new Error('Subscribe transport was superseded');
    await state.pc.setLocalDescription(offer);
    if (this.subscribers.get(consumerId) !== state) throw new Error('Subscribe transport was superseded');
    const local = state.pc.localDescription;
    if (!local) throw new Error('Failed to create subscribe offer');

    const producerMids: Record<string, SfuProducerMids> = {};
    for (const [producerId, forward] of state.forwards) {
      const mids: SfuProducerMids = {};
      if (forward.video) {
        const transceiver = state.pc.getTransceivers().find((t) => t.sender.track === forward.video?.track);
        forward.video.mid = transceiver?.mid ?? forward.video.mid;
        if (forward.video.mid) mids.video = forward.video.mid;
      }
      if (forward.audio) {
        const transceiver = state.pc.getTransceivers().find((t) => t.sender.track === forward.audio?.track);
        forward.audio.mid = transceiver?.mid ?? forward.audio.mid;
        if (forward.audio.mid) mids.audio = forward.audio.mid;
      }
      if (mids.video || mids.audio) producerMids[producerId] = mids;
    }

    return { description: { type: 'offer', sdp: local.sdp }, producerMids };
  }

  async setSubscribeAnswer(consumerId: string, answer: { sdp: string }): Promise<void> {
    const state = this.subscribers.get(consumerId);
    if (!state) throw new Error('No subscribe transport for this consumer');
    await state.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }

  async addSubscribeIceCandidate(consumerId: string, candidate: SfuIceCandidatePayload): Promise<void> {
    const state = this.subscribers.get(consumerId);
    if (!state) return;
    await state.pc.addIceCandidate(candidate as never);
  }

  /**
   * Feed one publisher RTP packet into the forwarding fan-out. The negotiated
   * publish transceiver calls this for every packet demuxed per rid; tests and
   * future taps (server-side recording, RTX) use it directly, since werift can
   * receive browser simulcast but cannot itself send rid-tagged packets
   * ("sender simulcast unsupported" in werift's RTCRtpSender).
   */
  injectPublisherRtp(participantId: string, rid: string, rtp: RtpPacket): void {
    const state = this.publishers.get(participantId);
    if (!state) return;
    state.packetCounts.set(rid, (state.packetCounts.get(rid) || 0) + 1);
    const ssrc = rtp.header?.ssrc;
    if (typeof ssrc === 'number' && state.ridSsrcs.get(rid) !== ssrc) state.ridSsrcs.set(rid, ssrc);
    if (state.pendingKeyframes.delete(rid)) this.requestKeyframe(participantId, rid);
    this.forwardPacket(participantId, rid, rtp);
  }

  /** Feed one publisher Opus RTP packet into the always-on audio fan-out. */
  injectPublisherAudioRtp(participantId: string, rtp: RtpPacket): void {
    const state = this.publishers.get(participantId);
    if (!state) return;
    state.audioPacketCount += 1;
    for (const subscriber of this.subscribers.values()) {
      const forward = subscriber.forwards.get(participantId)?.audio;
      if (!forward) continue;
      try {
        forward.track.writeRtp(clonePacket(rtp));
      } catch {
        // A closing subscriber may race a write; the disconnect path cleans up.
      }
    }
  }

  /** Apply an sfu-layer decision: forward `rid` (or nothing) from a producer to a consumer. */
  setForwardedLayer(consumerId: string, producerId: string, rid: string | null): void {
    const forward = this.subscribers.get(consumerId)?.forwards.get(producerId)?.video;
    if (!forward) return;
    const changed = forward.rid !== rid;
    forward.rid = rid;
    // A new layer (or a first one) starts at a keyframe, or the subscriber
    // shows a frozen or broken picture until the next one.
    if (changed && rid) this.requestKeyframe(producerId, rid);
  }

  private forwardPacket(producerId: string, rid: string, rtp: RtpPacket): void {
    for (const state of this.subscribers.values()) {
      const forward = state.forwards.get(producerId)?.video;
      if (!forward || forward.rid !== rid) continue;
      try {
        forward.track.writeRtp(clonePacket(rtp));
      } catch {
        // A closing subscriber may race a write; the disconnect path cleans up.
      }
    }
  }

  async closePublisher(participantId: string): Promise<void> {
    this.publishAttempts.delete(participantId);
    const state = this.publishers.get(participantId);
    if (!state) return;
    this.publishers.delete(participantId);
    await state.pc.close().catch(() => undefined);
  }

  /** Remove a producer's forwards from every subscriber (producer left). */
  removeProducer(producerId: string): void {
    for (const state of this.subscribers.values()) {
      state.forwards.delete(producerId);
    }
  }

  async closeParticipant(participantId: string): Promise<void> {
    // Detach both sides before either close yields. A replacement subscriber
    // created while an old publisher closes belongs to the next lifecycle.
    const publisher = this.publishers.get(participantId);
    const subscriber = this.subscribers.get(participantId);
    this.publishAttempts.delete(participantId);
    this.publishers.delete(participantId);
    this.subscribers.delete(participantId);
    this.removeProducer(participantId);
    await Promise.all([
      publisher?.pc.close().catch(() => undefined),
      subscriber?.pc.close().catch(() => undefined),
    ]);
  }

  async closeAll(): Promise<void> {
    const ids = new Set([...this.publishers.keys(), ...this.subscribers.keys(), ...this.publishAttempts.keys()]);
    await Promise.all([...ids].map((id) => this.closeParticipant(id)));
  }
}
