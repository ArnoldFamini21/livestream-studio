/**
 * Selective-forwarding core for the studio SFU.
 *
 * This module holds the routing brain of an SFU — the producer/consumer graph
 * and the per-consumer simulcast layer selection — independent of the WebRTC
 * transport. A transport layer (mediasoup/raw RTP) applies the forwarding
 * decisions this router produces. Keeping it pure makes the hard part —
 * choosing which quality layer to forward to each subscriber under changing
 * bandwidth — deterministic and testable.
 */

export interface SimulcastLayer {
  rid: string;
  bitrateKbps: number;
  scaleResolutionDownBy: number;
}

export interface LayerSelectionOptions {
  // A higher layer is only chosen when the budget clears its bitrate by this factor,
  // preventing rapid flapping between layers on small bandwidth fluctuations.
  upgradeMargin?: number;
  // When even the lowest layer exceeds the budget, forward the lowest layer anyway
  // (degraded) rather than pausing the consumer.
  forwardLowestWhenStarved?: boolean;
}

export interface LayerSelectionResult {
  rid: string | null;
  reason: 'no-layers' | 'fits' | 'downgrade' | 'held' | 'degraded' | 'paused';
}

export const DEFAULT_LAYER_SELECTION_OPTIONS: Required<LayerSelectionOptions> = {
  upgradeMargin: 1.15,
  forwardLowestWhenStarved: true,
};

function sortLayersDescending(layers: SimulcastLayer[]): SimulcastLayer[] {
  return layers.slice().sort((a, b) => b.bitrateKbps - a.bitrateKbps);
}

/**
 * Pick the simulcast layer to forward to a consumer given its downlink budget.
 * With a current layer, applies hysteresis: downgrade immediately when the
 * current layer no longer fits, but only upgrade when the budget clears the
 * higher layer's bitrate by `upgradeMargin`.
 */
export function selectSimulcastLayer(
  layers: SimulcastLayer[],
  budgetKbps: number,
  currentRid: string | null = null,
  options: LayerSelectionOptions = {}
): LayerSelectionResult {
  const config = { ...DEFAULT_LAYER_SELECTION_OPTIONS, ...options };
  if (layers.length === 0) return { rid: null, reason: 'no-layers' };
  const sorted = sortLayersDescending(layers);
  const budget = Number.isFinite(budgetKbps) && budgetKbps > 0 ? budgetKbps : 0;

  const bestFit = sorted.find((layer) => layer.bitrateKbps <= budget) || null;

  if (!bestFit) {
    if (config.forwardLowestWhenStarved) {
      return { rid: sorted[sorted.length - 1].rid, reason: 'degraded' };
    }
    return { rid: null, reason: 'paused' };
  }

  if (!currentRid) {
    return { rid: bestFit.rid, reason: 'fits' };
  }

  const current = sorted.find((layer) => layer.rid === currentRid);
  // The current layer disappeared (producer changed encodings) — take the best fit.
  if (!current) return { rid: bestFit.rid, reason: 'fits' };

  // Current layer no longer fits the budget: downgrade right away.
  if (current.bitrateKbps > budget) {
    return { rid: bestFit.rid, reason: 'downgrade' };
  }

  // Best fit is a higher layer than current — only upgrade past the margin.
  if (bestFit.bitrateKbps > current.bitrateKbps) {
    if (budget >= bestFit.bitrateKbps * config.upgradeMargin) {
      return { rid: bestFit.rid, reason: 'fits' };
    }
    return { rid: current.rid, reason: 'held' };
  }

  // Best fit is the current layer (or lower but current still fits) — stay put.
  return { rid: current.rid, reason: 'held' };
}

interface ProducerState {
  participantId: string;
  layers: SimulcastLayer[];
}

interface ConsumerState {
  consumerId: string;
  downlinkKbps: number;
  subscriptions: Set<string>; // producer participant ids
  activeLayers: Map<string, string | null>; // producerId -> currently forwarded rid
}

export interface ForwardingDecision {
  consumerId: string;
  producerId: string;
  rid: string | null;
  reason: LayerSelectionResult['reason'];
  changed: boolean;
}

export class SfuRouter {
  private readonly producers = new Map<string, ProducerState>();
  private readonly consumers = new Map<string, ConsumerState>();
  private readonly options: LayerSelectionOptions;

  constructor(options: LayerSelectionOptions = {}) {
    this.options = options;
  }

  addProducer(participantId: string, layers: SimulcastLayer[]): void {
    this.producers.set(participantId, { participantId, layers: layers.slice() });
  }

  removeProducer(participantId: string): void {
    this.producers.delete(participantId);
    for (const consumer of this.consumers.values()) {
      consumer.subscriptions.delete(participantId);
      consumer.activeLayers.delete(participantId);
    }
  }

  addConsumer(consumerId: string, downlinkKbps = 0): void {
    if (this.consumers.has(consumerId)) return;
    this.consumers.set(consumerId, {
      consumerId,
      downlinkKbps: Math.max(0, downlinkKbps),
      subscriptions: new Set(),
      activeLayers: new Map(),
    });
  }

  removeConsumer(consumerId: string): void {
    this.consumers.delete(consumerId);
  }

  subscribe(consumerId: string, producerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) return;
    consumer.subscriptions.add(producerId);
  }

  unsubscribe(consumerId: string, producerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) return;
    consumer.subscriptions.delete(producerId);
    consumer.activeLayers.delete(producerId);
  }

  setConsumerDownlink(consumerId: string, downlinkKbps: number): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) return;
    consumer.downlinkKbps = Math.max(0, Number.isFinite(downlinkKbps) ? downlinkKbps : 0);
  }

  getProducerCount(): number {
    return this.producers.size;
  }

  getConsumerCount(): number {
    return this.consumers.size;
  }

  /**
   * Recompute the layer each consumer should receive from each producer it is
   * subscribed to, splitting the consumer's downlink budget evenly across its
   * subscriptions. Returns every current decision and marks which changed.
   */
  computeForwardingDecisions(): ForwardingDecision[] {
    const decisions: ForwardingDecision[] = [];
    for (const consumer of this.consumers.values()) {
      const subscriptionCount = consumer.subscriptions.size;
      if (subscriptionCount === 0) continue;
      const perStreamBudget = consumer.downlinkKbps / subscriptionCount;
      for (const producerId of consumer.subscriptions) {
        const producer = this.producers.get(producerId);
        const layers = producer?.layers ?? [];
        const currentRid = consumer.activeLayers.get(producerId) ?? null;
        const result = selectSimulcastLayer(layers, perStreamBudget, currentRid, this.options);
        const changed = result.rid !== currentRid;
        consumer.activeLayers.set(producerId, result.rid);
        decisions.push({
          consumerId: consumer.consumerId,
          producerId,
          rid: result.rid,
          reason: result.reason,
          changed,
        });
      }
    }
    return decisions;
  }
}
