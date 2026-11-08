/**
 * Downlink budget for the SFU's layer choice (sfu-downlink).
 *
 * The SFU splits this budget across the streams a subscriber receives and
 * picks the simulcast layer that fits, so it must be an estimate of what the
 * link can carry, not of what is arriving: reporting the arriving rate would
 * lock a subscriber on the low layer forever. Chrome rarely fills
 * availableIncomingBitrate, so without it the estimate follows packet loss on
 * the inbound streams: heavy loss means the link is full and the budget drops
 * just below what is arriving now; a clean link lets it climb back slowly.
 */

export const SFU_DOWNLINK_CEILING_KBPS = 6_000;
export const SFU_DOWNLINK_FLOOR_KBPS = 300;
const HEAVY_LOSS = 0.05;
const LIGHT_LOSS = 0.02;
const BACKOFF = 0.85;
const GROWTH = 1.08;

export interface InboundTotals {
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  timestampMs: number;
  /** From the selected candidate pair, when the browser reports it (bits/s). */
  availableIncomingBitrate?: number;
}

/** Sum the inbound RTP streams of a stats report (audio and video). */
export function readInboundTotals(report: RTCStatsReport, nowMs: number): InboundTotals {
  const totals: InboundTotals = { bytesReceived: 0, packetsReceived: 0, packetsLost: 0, timestampMs: nowMs };
  let selectedPairId: string | null = null;
  const pairs = new Map<string, Record<string, unknown>>();
  report.forEach((raw) => {
    const stat = raw as Record<string, unknown>;
    if (stat.type === 'inbound-rtp') {
      totals.bytesReceived += Number(stat.bytesReceived) || 0;
      totals.packetsReceived += Number(stat.packetsReceived) || 0;
      totals.packetsLost += Math.max(0, Number(stat.packetsLost) || 0);
    } else if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
      selectedPairId = stat.selectedCandidatePairId;
    } else if (stat.type === 'candidate-pair') {
      pairs.set(String(stat.id), stat);
    }
  });
  const selected = (selectedPairId ? pairs.get(selectedPairId) : undefined)
    ?? [...pairs.values()].find((pair) => pair.nominated === true && pair.state === 'succeeded');
  const available = Number(selected?.availableIncomingBitrate);
  if (Number.isFinite(available) && available > 0) totals.availableIncomingBitrate = available;
  return totals;
}

export class SfuDownlinkEstimator {
  private previous: InboundTotals | null = null;
  private estimateKbps: number;

  constructor(initialKbps = SFU_DOWNLINK_CEILING_KBPS) {
    this.estimateKbps = clamp(initialKbps);
  }

  get currentKbps(): number {
    return this.estimateKbps;
  }

  /** Feed one sample; returns the new budget in kbps. */
  update(sample: InboundTotals): number {
    const previous = this.previous;
    this.previous = sample;
    if (sample.availableIncomingBitrate) {
      this.estimateKbps = clamp(sample.availableIncomingBitrate / 1000);
      return this.estimateKbps;
    }
    if (!previous) return this.estimateKbps;
    const elapsedMs = sample.timestampMs - previous.timestampMs;
    const received = sample.packetsReceived - previous.packetsReceived;
    const lost = sample.packetsLost - previous.packetsLost;
    const bytes = sample.bytesReceived - previous.bytesReceived;
    // A restarted stream resets its counters; skip that sample.
    if (elapsedMs <= 0 || received < 0 || lost < 0 || bytes < 0) return this.estimateKbps;
    if (received + lost < 20) return this.estimateKbps;
    const loss = lost / (received + lost);
    const arrivingKbps = (bytes * 8) / elapsedMs;
    if (loss >= HEAVY_LOSS) {
      this.estimateKbps = clamp(Math.min(this.estimateKbps, arrivingKbps) * BACKOFF);
    } else if (loss < LIGHT_LOSS) {
      this.estimateKbps = clamp(this.estimateKbps * GROWTH);
    }
    return this.estimateKbps;
  }
}

function clamp(kbps: number): number {
  if (!Number.isFinite(kbps)) return SFU_DOWNLINK_CEILING_KBPS;
  return Math.round(Math.min(SFU_DOWNLINK_CEILING_KBPS, Math.max(SFU_DOWNLINK_FLOOR_KBPS, kbps)));
}
