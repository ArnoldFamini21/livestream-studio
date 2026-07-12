import { SfuSessionCoordinator } from './sfuSession.js';
import type { LayerSelectionOptions, SimulcastLayer } from './sfuRouter.js';
import type {
  SfuIceCandidatePayload,
  SfuProducerMedia,
  SfuProducerMids,
  SfuSessionDescription,
} from './sfuTransport.js';

/**
 * SFU signaling protocol + hub.
 *
 * Translates the client<->server wire messages into {@link SfuSessionCoordinator}
 * operations and back into outgoing messages, for a single room. The hub is
 * handed a `send(participantId, message)` sink, so a WebSocket layer (or a test
 * double) can drive it. When a media transport is attached, publish/subscribe
 * offers and ICE flow through the same protocol and every layer decision is
 * applied to the transport's forwarding.
 */

export type SfuTransportSideName = 'publish' | 'subscribe';

/** The subset of SfuMediaTransport the hub drives (kept narrow so tests can fake it). */
export interface SfuTransportLike {
  createPublishOffer(participantId: string, rids: string[], hasAudio: boolean): Promise<SfuSessionDescription>;
  closePublisher(participantId: string): Promise<void>;
  setPublishAnswer(participantId: string, answer: { sdp: string }): Promise<void>;
  addPublishIceCandidate(participantId: string, candidate: SfuIceCandidatePayload): Promise<void>;
  createSubscribeOffer(
    consumerId: string,
    producers: SfuProducerMedia[]
  ): Promise<{ description: SfuSessionDescription; producerMids: Record<string, SfuProducerMids> }>;
  setSubscribeAnswer(consumerId: string, answer: { sdp: string }): Promise<void>;
  addSubscribeIceCandidate(consumerId: string, candidate: SfuIceCandidatePayload): Promise<void>;
  setForwardedLayer(consumerId: string, producerId: string, rid: string | null): void;
  removeProducer(producerId: string): void;
  closeParticipant(participantId: string): Promise<void>;
}

export type SfuClientMessage =
  | { type: 'sfu-join'; downlinkKbps?: number }
  | { type: 'sfu-publish'; layers: SimulcastLayer[]; audio: boolean }
  | { type: 'sfu-unpublish' }
  | { type: 'sfu-downlink'; downlinkKbps: number }
  | { type: 'sfu-transport-answer'; side: SfuTransportSideName; sdp: string }
  | { type: 'sfu-transport-ice'; side: SfuTransportSideName; candidate: SfuIceCandidatePayload }
  | { type: 'sfu-leave' };

export type SfuServerMessage =
  | { type: 'sfu-producers'; producers: string[] }
  | { type: 'sfu-producer-added'; producerId: string }
  | { type: 'sfu-producer-removed'; producerId: string }
  | { type: 'sfu-layer'; producerId: string; rid: string | null; reason: string }
  | {
    type: 'sfu-transport-offer';
    side: SfuTransportSideName;
    sdp: string;
    producerMids?: Record<string, SfuProducerMids>;
  }
  | { type: 'sfu-transport-ice'; side: SfuTransportSideName; candidate: SfuIceCandidatePayload }
  | { type: 'sfu-error'; message: string };

export type SfuSendFn = (participantId: string, message: SfuServerMessage) => void;

const MAX_LAYERS_PER_PRODUCER = 5;
const MAX_RID_LENGTH = 32;
const MAX_SDP_LENGTH = 128 * 1024;
const MAX_ICE_CANDIDATE_LENGTH = 1024;
const SUBSCRIPTION_ANSWER_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeDownlink(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function parseLayer(value: unknown): SimulcastLayer | null {
  if (!isRecord(value)) return null;
  const { rid, bitrateKbps, scaleResolutionDownBy } = value;
  if (typeof rid !== 'string' || rid.length === 0 || rid.length > MAX_RID_LENGTH) return null;
  const bitrate = Number(bitrateKbps);
  if (!Number.isFinite(bitrate) || bitrate <= 0) return null;
  const scale = Number(scaleResolutionDownBy);
  return {
    rid,
    bitrateKbps: Math.floor(bitrate),
    scaleResolutionDownBy: Number.isFinite(scale) && scale >= 1 ? scale : 1,
  };
}

export function parseSfuClientMessage(value: unknown): SfuClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'sfu-join':
      return { type: 'sfu-join', downlinkKbps: normalizeDownlink(value.downlinkKbps) };
    case 'sfu-publish': {
      if (!Array.isArray(value.layers)) return null;
      const layers = value.layers
        .map(parseLayer)
        .filter((layer): layer is SimulcastLayer => layer !== null)
        .slice(0, MAX_LAYERS_PER_PRODUCER);
      const audio = value.audio === true;
      if (layers.length === 0 && !audio) return null;
      return { type: 'sfu-publish', layers, audio };
    }
    case 'sfu-unpublish':
      return { type: 'sfu-unpublish' };
    case 'sfu-downlink':
      return { type: 'sfu-downlink', downlinkKbps: normalizeDownlink(value.downlinkKbps) };
    case 'sfu-transport-answer': {
      const side = parseTransportSide(value.side);
      if (!side) return null;
      if (typeof value.sdp !== 'string' || value.sdp.length === 0 || value.sdp.length > MAX_SDP_LENGTH) return null;
      return { type: 'sfu-transport-answer', side, sdp: value.sdp };
    }
    case 'sfu-transport-ice': {
      const side = parseTransportSide(value.side);
      if (!side) return null;
      const candidate = parseIceCandidate(value.candidate);
      if (!candidate) return null;
      return { type: 'sfu-transport-ice', side, candidate };
    }
    case 'sfu-leave':
      return { type: 'sfu-leave' };
    default:
      return null;
  }
}

function parseTransportSide(value: unknown): SfuTransportSideName | null {
  return value === 'publish' || value === 'subscribe' ? value : null;
}

function parseIceCandidate(value: unknown): SfuIceCandidatePayload | null {
  if (!isRecord(value)) return null;
  const { candidate, sdpMLineIndex, sdpMid } = value;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > MAX_ICE_CANDIDATE_LENGTH) {
    return null;
  }
  return {
    candidate,
    sdpMLineIndex: typeof sdpMLineIndex === 'number' && Number.isInteger(sdpMLineIndex) ? sdpMLineIndex : null,
    sdpMid: typeof sdpMid === 'string' ? sdpMid : null,
  };
}

export class SfuSignalingHub {
  private readonly room: SfuSessionCoordinator;
  private readonly publishers = new Map<string, SfuProducerMedia>();
  private readonly subscriptionNegotiating = new Set<string>();
  private readonly subscriptionQueued = new Set<string>();
  private readonly subscriptionAnswerTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly send: SfuSendFn,
    options: LayerSelectionOptions = {},
    private readonly transport: SfuTransportLike | null = null
  ) {
    this.room = new SfuSessionCoordinator(options);
  }

  getRoom(): SfuSessionCoordinator {
    return this.room;
  }

  /** Handle a raw inbound message from a participant. Returns true when handled. */
  handleMessage(participantId: string, raw: unknown): boolean {
    const message = parseSfuClientMessage(raw);
    if (!participantId || !message) {
      if (participantId) this.send(participantId, { type: 'sfu-error', message: 'Invalid SFU message' });
      return false;
    }

    try {
      this.dispatch(participantId, message);
      return true;
    } catch (err) {
      this.send(participantId, {
        type: 'sfu-error',
        message: err instanceof Error ? err.message : 'SFU error',
      });
      return false;
    }
  }

  /** Drop a participant on socket close without an explicit leave message. */
  handleDisconnect(participantId: string): void {
    if (!this.room.hasParticipant(participantId)) return;
    this.removeParticipant(participantId);
  }

  private dispatch(participantId: string, message: SfuClientMessage): void {
    switch (message.type) {
      case 'sfu-join': {
        this.room.join(participantId, message.downlinkKbps);
        // Tell the joiner which producers already exist.
        this.send(participantId, {
          type: 'sfu-producers',
          producers: [...this.publishers.keys()].filter((id) => id !== participantId),
        });
        // A joiner in a room with publishers gets a subscribe transport offer.
        this.offerSubscription(participantId);
        this.flushLayers();
        return;
      }
      case 'sfu-publish': {
        this.room.publish(participantId, message.layers);
        const wasPublishing = this.publishers.has(participantId);
        this.publishers.set(participantId, {
          producerId: participantId,
          hasVideo: message.layers.length > 0,
          hasAudio: message.audio,
        });
        if (!wasPublishing) {
          this.broadcastExcept(participantId, { type: 'sfu-producer-added', producerId: participantId });
        }
        if (this.transport) {
          const rids = message.layers.map((layer) => layer.rid);
          this.runTransportOp(participantId, async (transport) => {
            const offer = await transport.createPublishOffer(participantId, rids, message.audio);
            this.send(participantId, { type: 'sfu-transport-offer', side: 'publish', sdp: offer.sdp });
          });
          // Every other participant needs a (re)negotiated subscribe offer for the new producer.
          for (const participant of this.room.listParticipants()) {
            if (participant.participantId !== participantId) {
              this.offerSubscription(participant.participantId);
            }
          }
        }
        this.flushLayers();
        return;
      }
      case 'sfu-unpublish': {
        if (this.publishers.delete(participantId)) {
          this.room.unpublish(participantId);
          this.transport?.removeProducer(participantId);
          if (this.transport) {
            this.runTransportOp(participantId, (transport) => transport.closePublisher(participantId));
          }
          this.broadcastExcept(participantId, { type: 'sfu-producer-removed', producerId: participantId });
          this.flushLayers();
        }
        return;
      }
      case 'sfu-downlink': {
        this.room.setDownlink(participantId, message.downlinkKbps);
        this.flushLayers();
        return;
      }
      case 'sfu-transport-answer': {
        if (message.side === 'subscribe') {
          this.acceptSubscriptionAnswer(participantId, message.sdp);
          return;
        }
        this.runTransportOp(participantId, async (transport) => {
          await transport.setPublishAnswer(participantId, { sdp: message.sdp });
        });
        return;
      }
      case 'sfu-transport-ice': {
        this.runTransportOp(participantId, async (transport) => {
          if (message.side === 'publish') {
            await transport.addPublishIceCandidate(participantId, message.candidate);
          } else {
            await transport.addSubscribeIceCandidate(participantId, message.candidate);
          }
        });
        return;
      }
      case 'sfu-leave': {
        this.removeParticipant(participantId);
        return;
      }
    }
  }

  /** Send (or renegotiate) a subscribe transport offer covering all current producers. */
  private offerSubscription(consumerId: string): void {
    if (!this.transport) return;
    const producers = [...this.publishers.values()].filter((producer) => producer.producerId !== consumerId);
    if (producers.length === 0) return;
    if (this.subscriptionNegotiating.has(consumerId)) {
      this.subscriptionQueued.add(consumerId);
      return;
    }

    this.subscriptionNegotiating.add(consumerId);
    void this.transport.createSubscribeOffer(consumerId, producers).then(({ description, producerMids }) => {
      if (!this.room.hasParticipant(consumerId)) {
        this.subscriptionNegotiating.delete(consumerId);
        this.subscriptionQueued.delete(consumerId);
        void this.transport?.closeParticipant(consumerId).catch(() => undefined);
        return;
      }
      for (const selection of this.room.listLayerSelections(consumerId)) {
        this.transport?.setForwardedLayer(consumerId, selection.producerId, selection.rid);
      }
      this.send(consumerId, {
        type: 'sfu-transport-offer',
        side: 'subscribe',
        sdp: description.sdp,
        producerMids,
      });
      const timer = setTimeout(() => {
        this.subscriptionAnswerTimers.delete(consumerId);
        this.send(consumerId, { type: 'sfu-error', message: 'SFU subscription negotiation timed out' });
        this.finishSubscriptionNegotiation(consumerId);
      }, SUBSCRIPTION_ANSWER_TIMEOUT_MS);
      this.subscriptionAnswerTimers.set(consumerId, timer);
    }).catch((err) => {
      this.send(consumerId, {
        type: 'sfu-error',
        message: err instanceof Error ? err.message : 'SFU subscription transport error',
      });
      this.finishSubscriptionNegotiation(consumerId);
    });
  }

  private acceptSubscriptionAnswer(consumerId: string, sdp: string): void {
    if (!this.transport) return;
    if (!this.subscriptionNegotiating.has(consumerId)) {
      this.send(consumerId, { type: 'sfu-error', message: 'No SFU subscription offer is awaiting an answer' });
      return;
    }
    void this.transport.setSubscribeAnswer(consumerId, { sdp }).then(() => {
      this.finishSubscriptionNegotiation(consumerId);
    }).catch((err) => {
      this.send(consumerId, {
        type: 'sfu-error',
        message: err instanceof Error ? err.message : 'SFU subscription answer failed',
      });
      this.finishSubscriptionNegotiation(consumerId);
    });
  }

  private finishSubscriptionNegotiation(consumerId: string): void {
    const timer = this.subscriptionAnswerTimers.get(consumerId);
    if (timer) clearTimeout(timer);
    this.subscriptionAnswerTimers.delete(consumerId);
    this.subscriptionNegotiating.delete(consumerId);
    if (!this.room.hasParticipant(consumerId)) {
      this.subscriptionQueued.delete(consumerId);
      return;
    }
    if (!this.subscriptionQueued.delete(consumerId)) return;
    this.offerSubscription(consumerId);
  }

  private runTransportOp(
    participantId: string,
    op: (transport: SfuTransportLike) => Promise<void>
  ): void {
    if (!this.transport) return;
    void op(this.transport).catch((err) => {
      this.send(participantId, {
        type: 'sfu-error',
        message: err instanceof Error ? err.message : 'SFU transport error',
      });
    });
  }

  private removeParticipant(participantId: string): void {
    const timer = this.subscriptionAnswerTimers.get(participantId);
    if (timer) clearTimeout(timer);
    this.subscriptionAnswerTimers.delete(participantId);
    this.subscriptionNegotiating.delete(participantId);
    this.subscriptionQueued.delete(participantId);
    const wasPublishing = this.publishers.delete(participantId);
    this.room.leave(participantId);
    if (this.transport) {
      this.transport.removeProducer(participantId);
      void this.transport.closeParticipant(participantId).catch(() => undefined);
    }
    if (wasPublishing) {
      this.broadcastExcept(participantId, { type: 'sfu-producer-removed', producerId: participantId });
    }
    this.flushLayers();
  }

  private broadcastExcept(excludeId: string, message: SfuServerMessage): void {
    for (const participant of this.room.listParticipants()) {
      if (participant.participantId !== excludeId) {
        this.send(participant.participantId, message);
      }
    }
  }

  private flushLayers(): void {
    for (const change of this.room.pullLayerChanges()) {
      this.transport?.setForwardedLayer(change.consumerId, change.producerId, change.rid);
      this.send(change.consumerId, {
        type: 'sfu-layer',
        producerId: change.producerId,
        rid: change.rid,
        reason: change.reason,
      });
    }
  }
}
