import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpPacket,
  useSdesRTPStreamId,
  type RTCIceCandidate,
} from 'werift';

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

  constructor(private readonly events: SfuTransportEvents = {}) {}

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

  private newPeerConnection(withRidExtension: boolean): RTCPeerConnection {
    return new RTCPeerConnection({
      codecs: { audio: AUDIO_CODECS, video: VIDEO_CODECS },
      ...(withRidExtension ? { headerExtensions: { video: [useSdesRTPStreamId()] } } : {}),
    });
  }

  private emitIce(participantId: string, side: SfuTransportSide, pc: RTCPeerConnection): void {
    pc.onIceCandidate.subscribe((candidate: RTCIceCandidate | undefined) => {
      if (!candidate) return;
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
    await this.closePublisher(participantId);

    const pc = this.newPeerConnection(true);
    const state: PublisherState = {
      pc,
      rids: cleanRids,
      packetCounts: new Map(),
      audioPacketCount: 0,
    };
    this.publishers.set(participantId, state);
    this.emitIce(participantId, 'publish', pc);

    if (cleanRids.length > 0) {
      const transceiver = pc.addTransceiver('video', {
        direction: 'recvonly',
        simulcast: cleanRids.map((rid) => ({ rid, direction: 'recv' as const })),
      });

      transceiver.onTrack.subscribe((track: MediaStreamTrack) => {
        const rid = track.rid;
        if (!rid) return;
        track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
          this.injectPublisherRtp(participantId, rid, rtp);
        });
      });
    }

    if (hasAudio) {
      const transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
      transceiver.onTrack.subscribe((track: MediaStreamTrack) => {
        track.onReceiveRtp.subscribe((rtp: RtpPacket) => {
          this.injectPublisherAudioRtp(participantId, rtp);
        });
      });
    }

    await pc.setLocalDescription(await pc.createOffer());
    const local = pc.localDescription;
    if (!local) throw new Error('Failed to create publish offer');
    return { type: 'offer', sdp: local.sdp };
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
    let state = this.subscribers.get(consumerId);
    if (!state) {
      const pc = this.newPeerConnection(false);
      state = { pc, forwards: new Map() };
      this.subscribers.set(consumerId, state);
      this.emitIce(consumerId, 'subscribe', pc);
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
        forward.video = { track, mid: transceiver.mid ?? null, rid: null };
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

    await state.pc.setLocalDescription(await state.pc.createOffer());
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
    forward.rid = rid;
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
    const state = this.publishers.get(participantId);
    if (!state) return;
    this.publishers.delete(participantId);
    await state.pc.close().catch(() => undefined);
  }

  private async closeSubscriber(consumerId: string): Promise<void> {
    const state = this.subscribers.get(consumerId);
    if (!state) return;
    this.subscribers.delete(consumerId);
    await state.pc.close().catch(() => undefined);
  }

  /** Remove a producer's forwards from every subscriber (producer left). */
  removeProducer(producerId: string): void {
    for (const state of this.subscribers.values()) {
      state.forwards.delete(producerId);
    }
  }

  async closeParticipant(participantId: string): Promise<void> {
    await this.closePublisher(participantId);
    await this.closeSubscriber(participantId);
    this.removeProducer(participantId);
  }

  async closeAll(): Promise<void> {
    const ids = new Set([...this.publishers.keys(), ...this.subscribers.keys()]);
    for (const id of ids) {
      await this.closeParticipant(id);
    }
  }
}
