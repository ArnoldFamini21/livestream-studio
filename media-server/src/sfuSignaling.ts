import { SfuSessionCoordinator } from './sfuSession.js';
import type { LayerSelectionOptions, SimulcastLayer } from './sfuRouter.js';

/**
 * SFU signaling protocol + hub.
 *
 * Translates the client<->server wire messages into {@link SfuSessionCoordinator}
 * operations and back into outgoing messages, for a single room. The hub is
 * transport-agnostic: it is handed a `send(participantId, message)` sink, so a
 * WebSocket layer (or a test double) can drive it. This is the signaling brain
 * that sits between the socket and the forwarding core.
 */

export type SfuClientMessage =
  | { type: 'sfu-join'; downlinkKbps?: number }
  | { type: 'sfu-publish'; layers: SimulcastLayer[] }
  | { type: 'sfu-unpublish' }
  | { type: 'sfu-downlink'; downlinkKbps: number }
  | { type: 'sfu-leave' };

export type SfuServerMessage =
  | { type: 'sfu-producers'; producers: string[] }
  | { type: 'sfu-producer-added'; producerId: string }
  | { type: 'sfu-producer-removed'; producerId: string }
  | { type: 'sfu-layer'; producerId: string; rid: string | null; reason: string }
  | { type: 'sfu-error'; message: string };

export type SfuSendFn = (participantId: string, message: SfuServerMessage) => void;

const MAX_LAYERS_PER_PRODUCER = 5;
const MAX_RID_LENGTH = 32;

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
      if (layers.length === 0) return null;
      return { type: 'sfu-publish', layers };
    }
    case 'sfu-unpublish':
      return { type: 'sfu-unpublish' };
    case 'sfu-downlink':
      return { type: 'sfu-downlink', downlinkKbps: normalizeDownlink(value.downlinkKbps) };
    case 'sfu-leave':
      return { type: 'sfu-leave' };
    default:
      return null;
  }
}

export class SfuSignalingHub {
  private readonly room: SfuSessionCoordinator;
  private readonly publishers = new Set<string>();

  constructor(private readonly send: SfuSendFn, options: LayerSelectionOptions = {}) {
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
          producers: [...this.publishers].filter((id) => id !== participantId),
        });
        this.flushLayers();
        return;
      }
      case 'sfu-publish': {
        this.room.publish(participantId, message.layers);
        this.publishers.add(participantId);
        this.broadcastExcept(participantId, { type: 'sfu-producer-added', producerId: participantId });
        this.flushLayers();
        return;
      }
      case 'sfu-unpublish': {
        if (this.publishers.delete(participantId)) {
          this.room.unpublish(participantId);
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
      case 'sfu-leave': {
        this.removeParticipant(participantId);
        return;
      }
    }
  }

  private removeParticipant(participantId: string): void {
    const wasPublishing = this.publishers.delete(participantId);
    this.room.leave(participantId);
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
      this.send(change.consumerId, {
        type: 'sfu-layer',
        producerId: change.producerId,
        rid: change.rid,
        reason: change.reason,
      });
    }
  }
}
