import type {
  SfuClientOutbound,
  SfuIceCandidate,
  SfuProducerMids,
  SfuTransportSide,
} from './sfuClient.ts';

export interface SfuTransportOffer {
  side: SfuTransportSide;
  sdp: string;
  producerMids?: Record<string, SfuProducerMids | string>;
}

export interface SfuPeerConnectionLike {
  remoteDescription: RTCSessionDescription | RTCSessionDescriptionInit | null;
  localDescription: RTCSessionDescription | RTCSessionDescriptionInit | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  ontrack: ((event: RTCTrackEvent) => void) | null;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  getTransceivers(): RTCRtpTransceiver[];
  close(): void;
}

export type SfuPeerConnectionFactory = (configuration?: RTCConfiguration) => SfuPeerConnectionLike;

export interface SfuWebRtcTransportOptions {
  iceConfiguration?: RTCConfiguration;
  createPeerConnection?: SfuPeerConnectionFactory;
  createMediaStream?: (tracks: MediaStreamTrack[]) => MediaStream;
  onRemoteStream?: (producerId: string, stream: MediaStream) => void;
  onRemoteStreamRemoved?: (producerId: string) => void;
  onTransportReady?: (side: SfuTransportSide) => void;
  onError?: (message: string) => void;
}

const MAX_PENDING_ICE = 50;

function defaultPeerConnectionFactory(configuration?: RTCConfiguration): SfuPeerConnectionLike {
  return new RTCPeerConnection(configuration);
}

function toIceCandidateInit(candidate: SfuIceCandidate): RTCIceCandidateInit {
  return {
    candidate: candidate.candidate,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    sdpMid: candidate.sdpMid ?? null,
  };
}

/**
 * Browser media-plane counterpart to the media-server SFU transport.
 *
 * The server is deliberately offerer for both independent connections: the
 * publish connection sends local audio plus simulcast video, while the
 * subscribe connection receives both media kinds for each remote producer.
 * Keeping the connections isolated avoids renegotiating inbound media when a
 * local device changes and gives the server a clear forwarding boundary.
 */
export class SfuWebRtcTransport {
  private publishPc: SfuPeerConnectionLike | null = null;
  private subscribePc: SfuPeerConnectionLike | null = null;
  private readonly publishTracks: Record<'audio' | 'video', MediaStreamTrack | null> = {
    audio: null,
    video: null,
  };
  private readonly pendingIce: Record<SfuTransportSide, SfuIceCandidate[]> = {
    publish: [],
    subscribe: [],
  };
  private readonly producerByMid = new Map<string, { producerId: string; kind: 'audio' | 'video' }>();
  private readonly tracksByProducer = new Map<string, Map<'audio' | 'video', MediaStreamTrack>>();
  private readonly streamByProducer = new Map<string, MediaStream>();

  constructor(
    private readonly send: (message: SfuClientOutbound) => void,
    private readonly options: SfuWebRtcTransportOptions = {}
  ) {}

  setPublishTrack(track: MediaStreamTrack | null): void {
    this.setPublishMediaTrack('video', track);
  }

  setPublishAudioTrack(track: MediaStreamTrack | null): void {
    this.setPublishMediaTrack('audio', track);
  }

  async handleOffer(offer: SfuTransportOffer): Promise<void> {
    if (!offer.sdp) {
      this.reportError('The SFU sent an empty transport offer.');
      return;
    }

    const pc = this.getOrCreatePeerConnection(offer.side);
    if (offer.side === 'subscribe') this.setProducerMids(offer.producerMids);

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      if (offer.side === 'publish') await this.attachPublishTrack(pc);
      await this.drainPendingIce(offer.side, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!pc.localDescription?.sdp) throw new Error('Unable to create an SFU transport answer.');
      this.send({ type: 'sfu-transport-answer', side: offer.side, sdp: pc.localDescription.sdp });
      this.options.onTransportReady?.(offer.side);
    } catch (error) {
      this.reportError(error instanceof Error ? error.message : 'Unable to negotiate the SFU transport.');
    }
  }

  async handleIce(side: SfuTransportSide, candidate: SfuIceCandidate): Promise<void> {
    const pc = side === 'publish' ? this.publishPc : this.subscribePc;
    if (!pc || !pc.remoteDescription) {
      const pending = this.pendingIce[side];
      if (pending.length < MAX_PENDING_ICE) pending.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(toIceCandidateInit(candidate));
    } catch (error) {
      this.reportError(error instanceof Error ? error.message : 'Unable to add an SFU ICE candidate.');
    }
  }

  removeProducer(producerId: string): void {
    this.streamByProducer.delete(producerId);
    this.tracksByProducer.delete(producerId);
    for (const [mid, mapped] of this.producerByMid) {
      if (mapped.producerId === producerId) this.producerByMid.delete(mid);
    }
    this.options.onRemoteStreamRemoved?.(producerId);
  }

  close(): void {
    this.publishPc?.close();
    this.subscribePc?.close();
    this.publishPc = null;
    this.subscribePc = null;
    this.pendingIce.publish.length = 0;
    this.pendingIce.subscribe.length = 0;
    for (const producerId of this.streamByProducer.keys()) this.options.onRemoteStreamRemoved?.(producerId);
    this.streamByProducer.clear();
    this.tracksByProducer.clear();
    this.producerByMid.clear();
  }

  private getOrCreatePeerConnection(side: SfuTransportSide): SfuPeerConnectionLike {
    const existing = side === 'publish' ? this.publishPc : this.subscribePc;
    if (existing) return existing;

    const pc = (this.options.createPeerConnection ?? defaultPeerConnectionFactory)(this.options.iceConfiguration);
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (!candidate.candidate) return;
      this.send({
        type: 'sfu-transport-ice',
        side,
        candidate: {
          candidate: candidate.candidate,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          sdpMid: candidate.sdpMid ?? null,
        },
      });
    };
    if (side === 'subscribe') {
      pc.ontrack = (event) => {
        const mapped = event.transceiver.mid ? this.producerByMid.get(event.transceiver.mid) : undefined;
        if (!mapped) {
          this.reportError('Received an SFU track without a producer mapping.');
          return;
        }
        const kind = event.track.kind === 'audio' ? 'audio' : event.track.kind === 'video' ? 'video' : null;
        if (!kind || kind !== mapped.kind) {
          this.reportError('Received an SFU track with an invalid media mapping.');
          return;
        }
        let delivered = false;
        const deliver = () => {
          if (delivered || event.track.readyState !== 'live') return;
          delivered = true;
          let tracks = this.tracksByProducer.get(mapped.producerId);
          if (!tracks) {
            tracks = new Map();
            this.tracksByProducer.set(mapped.producerId, tracks);
          }
          tracks.set(kind, event.track);
          this.emitRemoteStream(mapped.producerId);
        };
        if (event.track.muted === true && typeof event.track.addEventListener === 'function') {
          event.track.addEventListener('unmute', deliver, { once: true });
        } else {
          deliver();
        }
        if (typeof event.track.addEventListener === 'function') {
          event.track.addEventListener('ended', () => {
            const tracks = this.tracksByProducer.get(mapped.producerId);
            if (tracks?.get(kind) !== event.track) return;
            tracks.delete(kind);
            if (tracks.size === 0) {
              this.removeProducer(mapped.producerId);
            } else {
              this.emitRemoteStream(mapped.producerId);
            }
          }, { once: true });
        }
      };
    }
    if (side === 'publish') this.publishPc = pc;
    else this.subscribePc = pc;
    return pc;
  }

  private setProducerMids(producerMids: Record<string, SfuProducerMids | string> | undefined): void {
    if (!producerMids) return;
    this.producerByMid.clear();
    for (const [producerId, rawMids] of Object.entries(producerMids)) {
      const mids = typeof rawMids === 'string' ? { video: rawMids } : rawMids;
      if (producerId && mids.video) {
        this.producerByMid.set(mids.video, { producerId, kind: 'video' });
      }
      if (producerId && mids.audio) {
        this.producerByMid.set(mids.audio, { producerId, kind: 'audio' });
      }
    }
  }

  private async attachPublishTrack(pc: SfuPeerConnectionLike): Promise<void> {
    const transceivers = pc.getTransceivers().filter((item) => (
      item.receiver.track.kind === 'audio' || item.receiver.track.kind === 'video'
    ));
    if (transceivers.length === 0) throw new Error('The SFU publish offer does not contain a media transceiver.');
    for (const transceiver of transceivers) {
      const kind = transceiver.receiver.track.kind as 'audio' | 'video';
      const track = this.publishTracks[kind];
      if (!track) throw new Error(`No local ${kind} track is available for SFU publishing.`);
      await transceiver.sender.replaceTrack(track);
      transceiver.direction = 'sendonly';
    }
  }

  private setPublishMediaTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null): void {
    this.publishTracks[kind] = track?.kind === kind && track.readyState === 'live' ? track : null;
    const pc = this.publishPc;
    if (!pc) return;
    const transceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === kind);
    if (!transceiver) return;
    void transceiver.sender.replaceTrack(this.publishTracks[kind]).catch((error) => {
      this.reportError(error instanceof Error ? error.message : `Unable to update the SFU ${kind} track.`);
    });
    transceiver.direction = 'sendonly';
  }

  private emitRemoteStream(producerId: string): void {
    const tracks = [...(this.tracksByProducer.get(producerId)?.values() || [])]
      .filter((track) => track.readyState === 'live');
    if (tracks.length === 0) {
      this.removeProducer(producerId);
      return;
    }
    const stream = (this.options.createMediaStream ?? ((items) => new MediaStream(items)))(tracks);
    this.streamByProducer.set(producerId, stream);
    this.options.onRemoteStream?.(producerId, stream);
  }

  private async drainPendingIce(side: SfuTransportSide, pc: SfuPeerConnectionLike): Promise<void> {
    const pending = this.pendingIce[side].splice(0);
    for (const candidate of pending) await pc.addIceCandidate(toIceCandidateInit(candidate));
  }

  private reportError(message: string): void {
    this.options.onError?.(message);
  }
}
