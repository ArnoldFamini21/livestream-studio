import { resolveSfuWsUrl } from './apiClient.ts';
import {
  SfuClientSession,
  type SfuClientInbound,
  type SfuClientOutbound,
  type SfuProducerMids,
} from './sfuClient.ts';
import { SfuWebRtcTransport } from './sfuWebRtcTransport.ts';
import { buildVideoSimulcastEncodingsForTrack } from './webrtcSimulcast.ts';

const SOCKET_OPEN = 1;
const MAX_SFU_PRODUCERS = 64;
const MAX_PRODUCER_ID_LENGTH = 128;
const MAX_SFU_SDP_LENGTH = 128 * 1024;
const MAX_SFU_ICE_LENGTH = 1024;

export interface SfuSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SfuSocketSessionOptions {
  token: string;
  localVideoTrack: MediaStreamTrack | null;
  localAudioTrack?: MediaStreamTrack | null;
  downlinkKbps: number;
  url?: string;
  createWebSocket?: (url: string) => SfuSocketLike;
  iceConfiguration?: RTCConfiguration;
  onRemoteStream?: (producerId: string, stream: MediaStream) => void;
  onRemoteStreamRemoved?: (producerId: string) => void;
  onRemoteMediaReady?: () => void;
  onRemoteMediaPending?: () => void;
  onReady?: () => void;
  onPublishStart?: () => void;
  onPublishReady?: () => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isProducerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PRODUCER_ID_LENGTH;
}

function parseProducerMids(value: unknown): Record<string, SfuProducerMids> | null {
  if (!isObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_SFU_PRODUCERS) return null;
  const producerMids: Record<string, SfuProducerMids> = {};
  for (const [id, rawMids] of entries) {
    if (!isProducerId(id)) continue;
    if (typeof rawMids === 'string' && rawMids.length > 0 && rawMids.length <= 64) {
      producerMids[id] = { video: rawMids };
      continue;
    }
    if (!isObject(rawMids)) continue;
    const video = typeof rawMids.video === 'string' && rawMids.video.length > 0 && rawMids.video.length <= 64
      ? rawMids.video
      : undefined;
    const audio = typeof rawMids.audio === 'string' && rawMids.audio.length > 0 && rawMids.audio.length <= 64
      ? rawMids.audio
      : undefined;
    if (video || audio) producerMids[id] = { ...(video ? { video } : {}), ...(audio ? { audio } : {}) };
  }
  return producerMids;
}

function parseSfuInbound(value: unknown): SfuClientInbound | null {
  if (!isObject(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'sfu-producers':
      return Array.isArray(value.producers) && value.producers.length <= MAX_SFU_PRODUCERS && value.producers.every(isProducerId)
        ? { type: 'sfu-producers', producers: value.producers }
        : null;
    case 'sfu-producer-added':
    case 'sfu-producer-removed':
      return isProducerId(value.producerId) ? { type: value.type, producerId: value.producerId } : null;
    case 'sfu-layer':
      return isProducerId(value.producerId) && (typeof value.rid === 'string' || value.rid === null)
        ? { type: 'sfu-layer', producerId: value.producerId, rid: value.rid, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) }
        : null;
    case 'sfu-transport-offer': {
      if (
        (value.side !== 'publish' && value.side !== 'subscribe') ||
        typeof value.sdp !== 'string' ||
        value.sdp.length === 0 ||
        value.sdp.length > MAX_SFU_SDP_LENGTH
      ) return null;
      const producerMids = value.producerMids === undefined ? undefined : parseProducerMids(value.producerMids);
      if (producerMids === null) return null;
      return { type: 'sfu-transport-offer', side: value.side, sdp: value.sdp, ...(producerMids ? { producerMids } : {}) };
    }
    case 'sfu-transport-ice':
      return (value.side === 'publish' || value.side === 'subscribe') &&
        isObject(value.candidate) &&
        typeof value.candidate.candidate === 'string' &&
        value.candidate.candidate.length > 0 &&
        value.candidate.candidate.length <= MAX_SFU_ICE_LENGTH
        ? {
          type: 'sfu-transport-ice',
          side: value.side,
          candidate: {
            candidate: value.candidate.candidate,
            sdpMLineIndex: typeof value.candidate.sdpMLineIndex === 'number' ? value.candidate.sdpMLineIndex : null,
            sdpMid: typeof value.candidate.sdpMid === 'string' ? value.candidate.sdpMid : null,
          },
        }
        : null;
    case 'sfu-error':
      return typeof value.message === 'string' && value.message.length <= 1000 ? { type: 'sfu-error', message: value.message } : null;
    default:
      return null;
  }
}

function defaultCreateWebSocket(url: string): SfuSocketLike {
  return new WebSocket(url);
}

function getSfuVideoEncodings(track: MediaStreamTrack): RTCRtpEncodingParameters[] {
  const encodings = buildVideoSimulcastEncodingsForTrack(track);
  if (encodings.length > 0) return encodings;
  return [{ rid: 'h', maxBitrate: 700_000, maxFramerate: 30, scaleResolutionDownBy: 1 }];
}

export function areSfuRemoteStreamsReady(
  producerIds: Iterable<string>,
  expectedMediaByProducer: ReadonlyMap<string, ReadonlySet<'audio' | 'video'>>,
  remoteStreams: ReadonlyMap<string, MediaStream>
): boolean {
  const ids = [...producerIds];
  if (ids.length === 0) return false;
  for (const producerId of ids) {
    const expected = expectedMediaByProducer.get(producerId);
    const stream = remoteStreams.get(producerId);
    if (!expected || expected.size === 0 || !stream) return false;
    const hasVideo = stream.getVideoTracks().some((track) => track.readyState === 'live');
    const hasAudio = stream.getAudioTracks().some((track) => track.readyState === 'live');
    if ((expected.has('video') && !hasVideo) || (expected.has('audio') && !hasAudio)) return false;
  }
  return true;
}

/**
 * Owns the authenticated `/sfu` socket and browser media-plane transports.
 * It intentionally has no React dependency so StudioRoom can use it for a
 * staged mesh-to-SFU rollout and tests can run it with a fake socket.
 */
export class SfuSocketSession {
  private socket: SfuSocketLike | null = null;
  private readonly transport: SfuWebRtcTransport;
  private readonly session: SfuClientSession;
  private readonly knownProducers = new Set<string>();
  private readonly expectedMediaByProducer = new Map<string, Set<'audio' | 'video'>>();
  private readonly remoteStreams = new Map<string, MediaStream>();
  private localVideoTrack: MediaStreamTrack | null;
  private localAudioTrack: MediaStreamTrack | null;
  private publishedMediaSignature: string | null = null;
  private remoteMediaReady = false;
  private ready = false;

  constructor(private readonly options: SfuSocketSessionOptions) {
    this.localVideoTrack = options.localVideoTrack?.kind === 'video' && options.localVideoTrack.readyState === 'live'
      ? options.localVideoTrack
      : null;
    this.localAudioTrack = options.localAudioTrack?.kind === 'audio' && options.localAudioTrack.readyState === 'live'
      ? options.localAudioTrack
      : null;
    this.transport = new SfuWebRtcTransport((message) => this.send(message), {
      iceConfiguration: options.iceConfiguration,
      onRemoteStream: (producerId, stream) => {
        this.remoteStreams.set(producerId, stream);
        options.onRemoteStream?.(producerId, stream);
        this.checkRemoteMediaReadiness();
      },
      onRemoteStreamRemoved: (producerId) => {
        this.remoteStreams.delete(producerId);
        options.onRemoteStreamRemoved?.(producerId);
        this.checkRemoteMediaReadiness();
      },
      onTransportReady: (side) => {
        if (side === 'publish') options.onPublishReady?.();
      },
      onError: options.onError,
    });
    this.transport.setPublishTrack(this.localVideoTrack);
    this.transport.setPublishAudioTrack(this.localAudioTrack);
    this.session = new SfuClientSession((message) => this.send(message), {
      onTransportOffer: (offer) => {
        if (offer.side === 'subscribe') this.recordExpectedMedia(offer.producerMids);
        void this.transport.handleOffer(offer);
      },
      onTransportIce: (side, candidate) => { void this.transport.handleIce(side, candidate); },
      onProducersChanged: (producers) => {
        this.removeMissingProducers(producers);
        this.checkRemoteMediaReadiness();
      },
      onError: options.onError,
    });
  }

  connect(): void {
    if (this.socket) return;
    const socket = (this.options.createWebSocket ?? defaultCreateWebSocket)(this.options.url ?? resolveSfuWsUrl());
    this.socket = socket;
    socket.onopen = () => this.sendRaw({ type: 'sfu-auth', token: this.options.token });
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => this.options.onError?.('The SFU media connection encountered a network error.');
    socket.onclose = () => {
      this.ready = false;
      this.socket = null;
      this.transport.close();
      this.knownProducers.clear();
      this.expectedMediaByProducer.clear();
      this.remoteStreams.clear();
      this.setRemoteMediaReady(false);
      this.options.onClose?.();
    };
  }

  setLocalVideoTrack(track: MediaStreamTrack | null): void {
    this.localVideoTrack = track?.kind === 'video' && track.readyState === 'live' ? track : null;
    this.transport.setPublishTrack(this.localVideoTrack);
    this.syncPublishing();
  }

  setLocalAudioTrack(track: MediaStreamTrack | null): void {
    this.localAudioTrack = track?.kind === 'audio' && track.readyState === 'live' ? track : null;
    this.transport.setPublishAudioTrack(this.localAudioTrack);
    this.syncPublishing();
  }

  reportDownlink(downlinkKbps: number): void {
    this.session.reportDownlink(downlinkKbps);
  }

  close(): void {
    if (this.ready) this.session.leave();
    this.ready = false;
    this.transport.close();
    this.knownProducers.clear();
    this.expectedMediaByProducer.clear();
    this.remoteStreams.clear();
    this.publishedMediaSignature = null;
    this.setRemoteMediaReady(false);
    this.socket?.close(1000, 'Studio left SFU');
    this.socket = null;
  }

  private handleMessage(data: unknown): void {
    let message: unknown = null;
    try {
      message = typeof data === 'string' ? JSON.parse(data) : null;
    } catch {
      this.options.onError?.('The SFU sent an invalid signaling message.');
      return;
    }
    if (!isObject(message)) return;
    if (message.type === 'sfu-ready') {
      this.ready = true;
      this.session.join(this.options.downlinkKbps);
      this.transport.setPublishTrack(this.localVideoTrack);
      this.transport.setPublishAudioTrack(this.localAudioTrack);
      this.syncPublishing();
      this.options.onReady?.();
      return;
    }

    const inbound = parseSfuInbound(message);
    if (!inbound) {
      this.options.onError?.('The SFU sent an unsupported signaling message.');
      return;
    }
    this.session.handleServerMessage(inbound);
  }

  private send(message: SfuClientOutbound): void {
    this.sendRaw(message);
  }

  private sendRaw(message: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private removeMissingProducers(producers: string[]): void {
    const next = new Set(producers);
    for (const producerId of this.knownProducers) {
      if (!next.has(producerId)) {
        this.transport.removeProducer(producerId);
        this.expectedMediaByProducer.delete(producerId);
        this.remoteStreams.delete(producerId);
      }
    }
    this.knownProducers.clear();
    for (const producerId of next) this.knownProducers.add(producerId);
  }

  private syncPublishing(): void {
    if (!this.ready) return;
    const hasVideo = this.localVideoTrack?.readyState === 'live';
    const hasAudio = this.localAudioTrack?.readyState === 'live';
    if (!hasVideo && !hasAudio) {
      this.session.unpublish();
      this.publishedMediaSignature = null;
      return;
    }

    const signature = `${hasVideo ? 'video' : ''}:${hasAudio ? 'audio' : ''}`;
    if (this.session.isPublishing() && this.publishedMediaSignature === signature) return;
    this.options.onPublishStart?.();
    const encodings = hasVideo && this.localVideoTrack ? getSfuVideoEncodings(this.localVideoTrack) : [];
    if (this.session.publish(encodings, Boolean(hasAudio))) {
      this.publishedMediaSignature = signature;
    }
  }

  private recordExpectedMedia(producerMids: Record<string, SfuProducerMids> | undefined): void {
    if (!producerMids) return;
    this.expectedMediaByProducer.clear();
    for (const [producerId, mids] of Object.entries(producerMids)) {
      const kinds = new Set<'audio' | 'video'>();
      if (mids.video) kinds.add('video');
      if (mids.audio) kinds.add('audio');
      if (kinds.size > 0) this.expectedMediaByProducer.set(producerId, kinds);
    }
    this.checkRemoteMediaReadiness();
  }

  private checkRemoteMediaReadiness(): void {
    this.setRemoteMediaReady(areSfuRemoteStreamsReady(
      this.knownProducers,
      this.expectedMediaByProducer,
      this.remoteStreams
    ));
  }

  private setRemoteMediaReady(ready: boolean): void {
    if (this.remoteMediaReady === ready) return;
    this.remoteMediaReady = ready;
    if (ready) this.options.onRemoteMediaReady?.();
    else this.options.onRemoteMediaPending?.();
  }
}

export { parseSfuInbound };
