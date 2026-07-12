/**
 * Client-side SFU publish/subscribe state machine.
 *
 * Mirrors the media-server signaling hub on the client: it turns local
 * simulcast encodings into an `sfu-publish` message, tracks which remote
 * producers exist (so the UI knows which tiles to render), and records the
 * quality layer the server has chosen to forward for each producer. It is
 * transport-agnostic — constructed with a `send` sink — so the RTCPeerConnection
 * wiring layers on top of this deterministic core.
 */

export interface SfuWireLayer {
  rid: string;
  bitrateKbps: number;
  scaleResolutionDownBy: number;
}

export interface SfuProducerMids {
  video?: string;
  audio?: string;
}

export type SfuClientOutbound =
  | { type: 'sfu-join'; downlinkKbps: number }
  | { type: 'sfu-publish'; layers: SfuWireLayer[]; audio: boolean }
  | { type: 'sfu-unpublish' }
  | { type: 'sfu-downlink'; downlinkKbps: number }
  | { type: 'sfu-transport-answer'; side: SfuTransportSide; sdp: string }
  | { type: 'sfu-transport-ice'; side: SfuTransportSide; candidate: SfuIceCandidate }
  | { type: 'sfu-leave' };

export type SfuTransportSide = 'publish' | 'subscribe';

export interface SfuIceCandidate {
  candidate: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
}

export type SfuClientInbound =
  | { type: 'sfu-producers'; producers: string[] }
  | { type: 'sfu-producer-added'; producerId: string }
  | { type: 'sfu-producer-removed'; producerId: string }
  | { type: 'sfu-layer'; producerId: string; rid: string | null; reason?: string }
  | {
    type: 'sfu-transport-offer';
    side: SfuTransportSide;
    sdp: string;
    producerMids?: Record<string, SfuProducerMids>;
  }
  | { type: 'sfu-transport-ice'; side: SfuTransportSide; candidate: SfuIceCandidate }
  | { type: 'sfu-error'; message: string };

export type SfuClientSend = (message: SfuClientOutbound) => void;

export interface SfuClientEvents {
  onProducersChanged?: (producers: string[]) => void;
  onLayerChanged?: (producerId: string, rid: string | null) => void;
  onTransportOffer?: (offer: Extract<SfuClientInbound, { type: 'sfu-transport-offer' }>) => void;
  onTransportIce?: (side: SfuTransportSide, candidate: SfuIceCandidate) => void;
  onError?: (message: string) => void;
}

/**
 * Convert RTCRtpEncodingParameters (as produced by webrtcSimulcast) into the
 * compact wire layer the SFU expects. Encodings without a usable bitrate/rid
 * are dropped.
 */
export function encodingsToWireLayers(encodings: RTCRtpEncodingParameters[]): SfuWireLayer[] {
  const layers: SfuWireLayer[] = [];
  encodings.forEach((encoding, index) => {
    const rid = typeof encoding.rid === 'string' && encoding.rid ? encoding.rid : `s${index}`;
    const maxBitrate = typeof encoding.maxBitrate === 'number' ? encoding.maxBitrate : 0;
    if (!Number.isFinite(maxBitrate) || maxBitrate <= 0) return;
    const scale = typeof encoding.scaleResolutionDownBy === 'number' && encoding.scaleResolutionDownBy >= 1
      ? encoding.scaleResolutionDownBy
      : 1;
    layers.push({
      rid,
      bitrateKbps: Math.round(maxBitrate / 1000),
      scaleResolutionDownBy: scale,
    });
  });
  return layers;
}

export class SfuClientSession {
  private readonly producers = new Set<string>();
  private readonly layers = new Map<string, string | null>();
  private joined = false;
  private publishing = false;
  private downlinkKbps = 0;

  constructor(
    private readonly send: SfuClientSend,
    private readonly events: SfuClientEvents = {}
  ) {}

  join(downlinkKbps: number): void {
    this.downlinkKbps = Math.max(0, Math.round(downlinkKbps) || 0);
    this.joined = true;
    this.send({ type: 'sfu-join', downlinkKbps: this.downlinkKbps });
  }

  publish(encodings: RTCRtpEncodingParameters[], audio = false): boolean {
    const layers = encodingsToWireLayers(encodings);
    if (layers.length === 0 && !audio) return false;
    this.publishing = true;
    this.send({ type: 'sfu-publish', layers, audio });
    return true;
  }

  unpublish(): void {
    if (!this.publishing) return;
    this.publishing = false;
    this.send({ type: 'sfu-unpublish' });
  }

  reportDownlink(downlinkKbps: number): void {
    const next = Math.max(0, Math.round(downlinkKbps) || 0);
    // Only signal when the estimate moves enough to matter (>10% or first report).
    if (this.downlinkKbps > 0 && Math.abs(next - this.downlinkKbps) < this.downlinkKbps * 0.1) return;
    this.downlinkKbps = next;
    this.send({ type: 'sfu-downlink', downlinkKbps: next });
  }

  leave(): void {
    if (!this.joined) return;
    this.joined = false;
    this.publishing = false;
    this.send({ type: 'sfu-leave' });
    this.producers.clear();
    this.layers.clear();
  }

  handleServerMessage(message: SfuClientInbound): void {
    switch (message.type) {
      case 'sfu-producers': {
        this.producers.clear();
        for (const id of message.producers) {
          if (typeof id === 'string' && id) this.producers.add(id);
        }
        this.emitProducers();
        return;
      }
      case 'sfu-producer-added': {
        if (message.producerId && !this.producers.has(message.producerId)) {
          this.producers.add(message.producerId);
          this.emitProducers();
        }
        return;
      }
      case 'sfu-producer-removed': {
        if (this.producers.delete(message.producerId)) {
          this.layers.delete(message.producerId);
          this.emitProducers();
        }
        return;
      }
      case 'sfu-layer': {
        this.layers.set(message.producerId, message.rid);
        this.events.onLayerChanged?.(message.producerId, message.rid);
        return;
      }
      case 'sfu-transport-offer': {
        this.events.onTransportOffer?.(message);
        return;
      }
      case 'sfu-transport-ice': {
        this.events.onTransportIce?.(message.side, message.candidate);
        return;
      }
      case 'sfu-error': {
        this.events.onError?.(message.message);
        return;
      }
    }
  }

  getRemoteProducers(): string[] {
    return [...this.producers];
  }

  getForwardedLayer(producerId: string): string | null {
    return this.layers.get(producerId) ?? null;
  }

  isPublishing(): boolean {
    return this.publishing;
  }

  private emitProducers(): void {
    this.events.onProducersChanged?.([...this.producers]);
  }
}
