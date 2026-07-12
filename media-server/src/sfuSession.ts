import {
  SfuRouter,
  type ForwardingDecision,
  type LayerSelectionOptions,
  type SimulcastLayer,
} from './sfuRouter.js';

/**
 * Per-room SFU orchestration on top of the {@link SfuRouter}.
 *
 * The router is a pure producer/consumer graph; this coordinator gives it room
 * semantics: every on-stage participant is a consumer subscribed to every other
 * participant's producer. It exposes join/publish/leave/downlink operations a
 * signaling layer calls, and emits only the forwarding decisions that changed so
 * a transport dispatches sparse `layer-change` updates rather than the full set.
 */

export interface SfuParticipantState {
  participantId: string;
  publishing: boolean;
  downlinkKbps: number;
}

export interface SfuLayerChange {
  consumerId: string;
  producerId: string;
  rid: string | null;
  reason: ForwardingDecision['reason'];
}

const MAX_SFU_PARTICIPANTS = 64;

export class SfuSessionCoordinator {
  private readonly router: SfuRouter;
  private readonly participants = new Map<string, SfuParticipantState>();

  constructor(options: LayerSelectionOptions = {}) {
    this.router = new SfuRouter(options);
  }

  hasParticipant(participantId: string): boolean {
    return this.participants.has(participantId);
  }

  getParticipantCount(): number {
    return this.participants.size;
  }

  listParticipants(): SfuParticipantState[] {
    return [...this.participants.values()].map((state) => ({ ...state }));
  }

  /** Add a participant as a consumer subscribed to every current producer. */
  join(participantId: string, downlinkKbps = 0): void {
    if (!participantId) throw new Error('participantId is required');
    if (this.participants.has(participantId)) {
      this.setDownlink(participantId, downlinkKbps);
      return;
    }
    if (this.participants.size >= MAX_SFU_PARTICIPANTS) {
      throw new Error(`SFU room is full (max ${MAX_SFU_PARTICIPANTS} participants)`);
    }
    this.participants.set(participantId, { participantId, publishing: false, downlinkKbps: Math.max(0, downlinkKbps) });
    this.router.addConsumer(participantId, Math.max(0, downlinkKbps));
    for (const other of this.participants.values()) {
      if (other.participantId !== participantId && other.publishing) {
        this.router.subscribe(participantId, other.participantId);
      }
    }
  }

  /** Register the participant's published simulcast layers and subscribe everyone else. */
  publish(participantId: string, layers: SimulcastLayer[]): void {
    const state = this.participants.get(participantId);
    if (!state) throw new Error('Participant must join before publishing');
    this.router.addProducer(participantId, layers);
    state.publishing = true;
    for (const other of this.participants.values()) {
      if (other.participantId !== participantId) {
        this.router.subscribe(other.participantId, participantId);
      }
    }
  }

  /** Stop the participant publishing but keep them in the room as a viewer. */
  unpublish(participantId: string): void {
    const state = this.participants.get(participantId);
    if (!state) return;
    this.router.removeProducer(participantId);
    state.publishing = false;
  }

  /** Remove the participant entirely (both their producer and their subscriptions). */
  leave(participantId: string): void {
    if (!this.participants.has(participantId)) return;
    this.router.removeProducer(participantId);
    this.router.removeConsumer(participantId);
    this.participants.delete(participantId);
  }

  setDownlink(participantId: string, downlinkKbps: number): void {
    const state = this.participants.get(participantId);
    if (!state) return;
    const clamped = Math.max(0, Number.isFinite(downlinkKbps) ? downlinkKbps : 0);
    state.downlinkKbps = clamped;
    this.router.setConsumerDownlink(participantId, clamped);
  }

  /** Recompute forwarding and return only the decisions whose layer changed. */
  pullLayerChanges(): SfuLayerChange[] {
    return this.router
      .computeForwardingDecisions()
      .filter((decision) => decision.changed)
      .map((decision) => ({
        consumerId: decision.consumerId,
        producerId: decision.producerId,
        rid: decision.rid,
        reason: decision.reason,
      }));
  }

  /** Return the current full forwarding plan, including unchanged selections. */
  listLayerSelections(consumerId?: string): SfuLayerChange[] {
    return this.router
      .computeForwardingDecisions()
      .filter((decision) => consumerId === undefined || decision.consumerId === consumerId)
      .map((decision) => ({
        consumerId: decision.consumerId,
        producerId: decision.producerId,
        rid: decision.rid,
        reason: decision.reason,
      }));
  }
}
