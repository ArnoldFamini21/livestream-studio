import { buildVideoSimulcastEncodingsForTrack } from './webrtcSimulcast.ts';
import type { InboundHealthSample } from './webrtcInboundHealth.ts';

export type BandwidthAdaptationMode = 'full' | 'balanced' | 'constrained';
export type BandwidthPressureSignal = 'stable' | 'balanced' | 'constrained' | 'unknown';
export type PeerBandwidthQuality = 'good' | 'fair' | 'poor' | 'unknown';

export interface OutboundVideoStatsSnapshot {
  timestampMs: number;
  bytesSent: number;
  packetsSent: number | null;
  packetsLost: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  /** Jitter the peer reports for what we send (remote-inbound-rtp), in ms. */
  jitterMs?: number | null;
}

export interface OutboundVideoStatsDelta {
  bitrateKbps: number | null;
  packetLossRatio: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  jitterMs?: number | null;
}

export interface BandwidthAdaptationState {
  mode: BandwidthAdaptationMode;
  stableSamples: number;
  pressureSamples: number;
  lastSnapshot: OutboundVideoStatsSnapshot | null;
  lastDelta: OutboundVideoStatsDelta | null;
  /**
   * Lowest round-trip time seen on this link, creeping up slowly. A guest in
   * the US talking to a host in the Philippines has 250-350 ms of RTT purely
   * from distance; only RTT well above this baseline means congestion.
   */
  baselineRttMs?: number | null;
}

export interface PeerBandwidthHealth {
  mode: BandwidthAdaptationMode;
  /** The worse of what we send this peer and what we receive from them. */
  quality: PeerBandwidthQuality;
  bitrateKbps: number | null;
  packetLossPercent: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  updatedAtMs: number;
  /** How our video reaches this peer (unknown when we send no video, e.g. camera off or SFU active). */
  outboundQuality?: PeerBandwidthQuality;
  /** How this peer's audio and video reach us: what the program and recording get. */
  inboundQuality?: PeerBandwidthQuality;
  inboundPacketLossPercent?: number | null;
  inboundJitterMs?: number | null;
  /** The peer sends us audio only (camera off or audio-only guest). */
  audioOnly?: boolean;
  /** The connection runs through a TURN relay rather than directly. */
  relayed?: boolean | null;
}

type StatsRecord = Record<string, unknown>;

const FULL_RESTORE_STABLE_SAMPLES = 3;
const MIN_VIDEO_BITRATE = 150_000;

const MODE_MULTIPLIERS: Record<BandwidthAdaptationMode, { bitrate: number; maxFramerate: number | null }> = {
  full: { bitrate: 1, maxFramerate: null },
  balanced: { bitrate: 0.65, maxFramerate: 24 },
  constrained: { bitrate: 0.38, maxFramerate: 18 },
};

export function createInitialBandwidthAdaptationState(): BandwidthAdaptationState {
  return {
    mode: 'full',
    stableSamples: 0,
    pressureSamples: 0,
    lastSnapshot: null,
    lastDelta: null,
  };
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true';
}

function isVideoStatsRecord(stat: StatsRecord): boolean {
  return stat.kind === 'video' || stat.mediaType === 'video';
}

function collectStatsRecords(report: unknown): StatsRecord[] {
  const records: StatsRecord[] = [];
  const maybeForEach = report as { forEach?: (callback: (value: unknown) => void) => void };

  if (typeof maybeForEach?.forEach === 'function') {
    maybeForEach.forEach((value) => {
      if (value && typeof value === 'object') records.push(value as StatsRecord);
    });
    return records;
  }

  if (report && typeof (report as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    for (const value of report as Iterable<unknown>) {
      if (value && typeof value === 'object') records.push(value as StatsRecord);
    }
  }

  return records;
}

export function readOutboundVideoStatsSnapshot(
  report: unknown,
  fallbackTimestampMs = Date.now()
): OutboundVideoStatsSnapshot | null {
  const records = collectStatsRecords(report);
  let timestampMs = fallbackTimestampMs;
  let bytesSent = 0;
  let packetsSent = 0;
  let packetsSentSeen = false;
  let packetsLost: number | null = null;
  let roundTripTimeMs: number | null = null;
  let availableOutgoingBitrateKbps: number | null = null;
  let jitterMs: number | null = null;
  let hasOutboundVideo = false;
  const outboundVideoIds = new Set<string>();
  for (const stat of records) {
    if (stat.type === 'outbound-rtp' && isVideoStatsRecord(stat) && !asBoolean(stat.isRemote) && typeof stat.id === 'string') {
      outboundVideoIds.add(stat.id);
    }
  }

  // Only the candidate pair in use says anything about the media path; Chrome
  // keeps several "succeeded" backup pairs (TURN over TCP/TLS) that are slower.
  const selectedPair = findSelectedCandidatePair(records);
  if (selectedPair) {
    const rttSeconds = asNumber(selectedPair.currentRoundTripTime);
    if (rttSeconds !== null) roundTripTimeMs = Math.round(rttSeconds * 1000);
    const outgoingBitrate = asNumber(selectedPair.availableOutgoingBitrate);
    if (outgoingBitrate !== null) availableOutgoingBitrateKbps = Math.round(outgoingBitrate / 1000);
  }

  for (const stat of records) {
    const type = typeof stat.type === 'string' ? stat.type : '';

    if (type === 'outbound-rtp' && isVideoStatsRecord(stat) && !asBoolean(stat.isRemote)) {
      hasOutboundVideo = true;
      bytesSent += Math.max(0, asNumber(stat.bytesSent) ?? 0);
      const statPacketsSent = asNumber(stat.packetsSent);
      if (statPacketsSent !== null) {
        packetsSent += Math.max(0, statPacketsSent);
        packetsSentSeen = true;
      }
      const statTimestamp = asNumber(stat.timestamp);
      if (statTimestamp !== null) timestampMs = Math.max(timestampMs, statTimestamp);
    } else if (type === 'remote-inbound-rtp' && isVideoStatsRecord(stat)) {
      // Each report answers one of our outbound streams (localId); losses add up
      // across streams (camera and screen), matching packetsSent summed above.
      if (typeof stat.localId === 'string' && outboundVideoIds.size > 0 && !outboundVideoIds.has(stat.localId)) continue;
      const statPacketsLost = asNumber(stat.packetsLost);
      if (statPacketsLost !== null) {
        packetsLost = (packetsLost ?? 0) + Math.max(0, statPacketsLost);
      }
      const rttSeconds = asNumber(stat.roundTripTime);
      if (rttSeconds !== null) {
        roundTripTimeMs = Math.max(roundTripTimeMs ?? 0, Math.round(rttSeconds * 1000));
      }
      const jitterSeconds = asNumber(stat.jitter);
      if (jitterSeconds !== null) jitterMs = Math.max(jitterMs ?? 0, Math.round(jitterSeconds * 1000));
    }
  }

  if (!hasOutboundVideo) return null;

  return {
    timestampMs,
    bytesSent,
    packetsSent: packetsSentSeen ? packetsSent : null,
    packetsLost,
    roundTripTimeMs,
    availableOutgoingBitrateKbps,
    ...(jitterMs !== null ? { jitterMs } : {}),
  };
}

/**
 * The candidate pair carrying media: the transport's selectedCandidatePairId,
 * else a pair flagged selected (Firefox), else the nominated, succeeded pair
 * that has moved the most bytes.
 */
export function findSelectedCandidatePair(report: unknown): StatsRecord | null {
  const records = Array.isArray(report) ? report as StatsRecord[] : collectStatsRecords(report);
  const byId = new Map<string, StatsRecord>();
  for (const stat of records) if (typeof stat.id === 'string') byId.set(stat.id, stat);
  for (const stat of records) {
    if (stat.type !== 'transport' || typeof stat.selectedCandidatePairId !== 'string') continue;
    const pair = byId.get(stat.selectedCandidatePairId);
    if (pair) return pair;
  }
  const flagged = records.find((stat) => stat.type === 'candidate-pair' && asBoolean(stat.selected));
  if (flagged) return flagged;
  let best: StatsRecord | null = null;
  for (const stat of records) {
    if (stat.type !== 'candidate-pair' || !asBoolean(stat.nominated) || stat.state !== 'succeeded') continue;
    const bytes = (asNumber(stat.bytesSent) ?? 0) + (asNumber(stat.bytesReceived) ?? 0);
    const bestBytes = best ? (asNumber(best.bytesSent) ?? 0) + (asNumber(best.bytesReceived) ?? 0) : -1;
    if (bytes > bestBytes) best = stat;
  }
  return best;
}

export function calculateOutboundVideoStatsDelta(
  previous: OutboundVideoStatsSnapshot,
  current: OutboundVideoStatsSnapshot
): OutboundVideoStatsDelta {
  const elapsedSeconds = Math.max(0, (current.timestampMs - previous.timestampMs) / 1000);
  const byteDelta = current.bytesSent - previous.bytesSent;
  const packetsSentDelta =
    current.packetsSent !== null && previous.packetsSent !== null
      ? current.packetsSent - previous.packetsSent
      : null;
  const packetsLostDelta =
    current.packetsLost !== null && previous.packetsLost !== null
      ? current.packetsLost - previous.packetsLost
      : null;
  const packetTotal =
    packetsSentDelta !== null && packetsLostDelta !== null
      ? Math.max(0, packetsSentDelta) + Math.max(0, packetsLostDelta)
      : 0;

  return {
    bitrateKbps: elapsedSeconds > 0 && byteDelta >= 0 ? Math.round((byteDelta * 8) / elapsedSeconds / 1000) : null,
    packetLossRatio: packetTotal > 0 && packetsLostDelta !== null ? Math.max(0, packetsLostDelta) / packetTotal : null,
    roundTripTimeMs: current.roundTripTimeMs,
    availableOutgoingBitrateKbps: current.availableOutgoingBitrateKbps,
    ...(current.jitterMs !== undefined ? { jitterMs: current.jitterMs } : {}),
  };
}

/** How far above the link's own baseline RTT counts as queueing (congestion), not distance. */
const RTT_QUEUEING_BALANCED_MS = 150;
const RTT_QUEUEING_CONSTRAINED_MS = 400;

/**
 * Whether the link to a peer is congested. Packet loss, jitter and the
 * bandwidth estimate drive it. Round-trip time counts only relative to the
 * link's own baseline when one is known: 300 ms of steady RTT between Manila
 * and the US is distance, and cutting the bitrate for it only made the guest
 * look worse. Without a baseline the old absolute limits apply.
 */
export function classifyBandwidthPressure(delta: OutboundVideoStatsDelta, baselineRttMs?: number | null): BandwidthPressureSignal {
  const jitterMs = delta.jitterMs ?? null;
  const hasSignal =
    delta.packetLossRatio !== null ||
    delta.roundTripTimeMs !== null ||
    delta.availableOutgoingBitrateKbps !== null ||
    jitterMs !== null;

  if (!hasSignal) return 'unknown';

  const hasBaseline = typeof baselineRttMs === 'number' && Number.isFinite(baselineRttMs);
  const queueingMs = delta.roundTripTimeMs !== null && hasBaseline ? delta.roundTripTimeMs - (baselineRttMs as number) : null;
  const rttConstrained = delta.roundTripTimeMs !== null && (hasBaseline
    ? (queueingMs as number) >= RTT_QUEUEING_CONSTRAINED_MS
    : delta.roundTripTimeMs >= 750);
  const rttBalanced = delta.roundTripTimeMs !== null && (hasBaseline
    ? (queueingMs as number) >= RTT_QUEUEING_BALANCED_MS
    : delta.roundTripTimeMs >= 400);

  if (
    (delta.packetLossRatio !== null && delta.packetLossRatio >= 0.08) ||
    rttConstrained ||
    (jitterMs !== null && jitterMs >= 150) ||
    (delta.availableOutgoingBitrateKbps !== null && delta.availableOutgoingBitrateKbps <= 750)
  ) {
    return 'constrained';
  }

  if (
    (delta.packetLossRatio !== null && delta.packetLossRatio >= 0.03) ||
    rttBalanced ||
    (jitterMs !== null && jitterMs >= 60) ||
    (delta.availableOutgoingBitrateKbps !== null && delta.availableOutgoingBitrateKbps <= 1600)
  ) {
    return 'balanced';
  }

  return 'stable';
}

/** Lowest RTT seen, allowed to rise 5 ms per sample so a lasting route change (a relay) becomes the new normal. */
export function updateBaselineRtt(baselineRttMs: number | null | undefined, roundTripTimeMs: number | null): number | null {
  if (roundTripTimeMs === null || !Number.isFinite(roundTripTimeMs)) return baselineRttMs ?? null;
  if (baselineRttMs === null || baselineRttMs === undefined) return roundTripTimeMs;
  return Math.min(roundTripTimeMs, baselineRttMs + 5);
}

function upgradeMode(mode: BandwidthAdaptationMode): BandwidthAdaptationMode {
  if (mode === 'constrained') return 'balanced';
  if (mode === 'balanced') return 'full';
  return 'full';
}

export function updateBandwidthAdaptationState(
  state: BandwidthAdaptationState,
  snapshot: OutboundVideoStatsSnapshot
): BandwidthAdaptationState {
  // The baseline is judged before this sample joins it, so a sudden queue shows.
  const previousBaseline = state.baselineRttMs ?? null;
  const baselineRttMs = updateBaselineRtt(previousBaseline, snapshot.roundTripTimeMs);
  if (!state.lastSnapshot) {
    return {
      ...state,
      lastSnapshot: snapshot,
      lastDelta: null,
      baselineRttMs,
    };
  }

  const delta = calculateOutboundVideoStatsDelta(state.lastSnapshot, snapshot);
  const signal = classifyBandwidthPressure(delta, previousBaseline);

  if (signal === 'constrained') {
    return {
      mode: 'constrained',
      stableSamples: 0,
      pressureSamples: state.pressureSamples + 1,
      lastSnapshot: snapshot,
      lastDelta: delta,
      baselineRttMs,
    };
  }

  if (signal === 'balanced') {
    return {
      mode: state.mode === 'constrained' ? 'constrained' : 'balanced',
      stableSamples: 0,
      pressureSamples: state.pressureSamples + 1,
      lastSnapshot: snapshot,
      lastDelta: delta,
      baselineRttMs,
    };
  }

  if (signal === 'stable') {
    const stableSamples = state.stableSamples + 1;
    const shouldUpgrade = stableSamples >= FULL_RESTORE_STABLE_SAMPLES;

    return {
      mode: shouldUpgrade ? upgradeMode(state.mode) : state.mode,
      stableSamples: shouldUpgrade ? 0 : stableSamples,
      pressureSamples: 0,
      lastSnapshot: snapshot,
      lastDelta: delta,
      baselineRttMs,
    };
  }

  return {
    ...state,
    lastSnapshot: snapshot,
    lastDelta: delta,
    baselineRttMs,
  };
}

export function getPeerBandwidthQuality(state: BandwidthAdaptationState): PeerBandwidthQuality {
  if (!state.lastDelta) return 'unknown';

  const pressure = classifyBandwidthPressure(state.lastDelta, state.baselineRttMs);
  if (pressure === 'constrained' || state.mode === 'constrained') return 'poor';
  if (pressure === 'balanced' || state.mode === 'balanced') return 'fair';
  if (pressure === 'stable') return 'good';
  return 'unknown';
}

const QUALITY_RANK: Record<PeerBandwidthQuality, number> = { unknown: -1, good: 0, fair: 1, poor: 2 };

/** The worse of two measurements; unknown only when neither is known. */
export function worsePeerQuality(a: PeerBandwidthQuality, b: PeerBandwidthQuality): PeerBandwidthQuality {
  return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

export function buildPeerBandwidthHealth(
  state: BandwidthAdaptationState,
  updatedAtMs = Date.now(),
  inbound?: InboundHealthSample | null
): PeerBandwidthHealth {
  const delta = state.lastDelta;
  const outboundQuality = getPeerBandwidthQuality(state);
  const base: PeerBandwidthHealth = {
    mode: state.mode,
    quality: outboundQuality,
    bitrateKbps: delta?.bitrateKbps ?? null,
    packetLossPercent: delta?.packetLossRatio !== null && delta?.packetLossRatio !== undefined
      ? Math.round(delta.packetLossRatio * 1000) / 10
      : null,
    roundTripTimeMs: delta?.roundTripTimeMs ?? null,
    availableOutgoingBitrateKbps: delta?.availableOutgoingBitrateKbps ?? null,
    updatedAtMs,
  };
  if (!inbound) return base;
  let quality = worsePeerQuality(outboundQuality, inbound.quality);
  // Connected, with nothing flowing either way (the SFU carries this peer's
  // media, or both cameras and mics are off): the link itself is fine.
  if (quality === 'unknown' && inbound.connected) quality = 'good';
  return {
    ...base,
    quality,
    roundTripTimeMs: base.roundTripTimeMs ?? inbound.roundTripTimeMs,
    outboundQuality,
    inboundQuality: inbound.quality,
    inboundPacketLossPercent: inbound.packetLossPercent,
    inboundJitterMs: inbound.jitterMs,
    audioOnly: inbound.audioOnly,
    relayed: inbound.relayed,
  };
}

function getEncodingScale(encoding: RTCRtpEncodingParameters, fallback: RTCRtpEncodingParameters): number {
  const value = asNumber(encoding.scaleResolutionDownBy) ?? asNumber(fallback.scaleResolutionDownBy);
  return value && value > 0 ? value : 1;
}

function shouldKeepEncodingActive(
  mode: BandwidthAdaptationMode,
  index: number,
  encodings: RTCRtpEncodingParameters[],
  baselineEncodings: RTCRtpEncodingParameters[]
): boolean {
  if (mode === 'full' || encodings.length <= 1) return true;

  const scales = encodings.map((encoding, encodingIndex) => (
    getEncodingScale(encoding, baselineEncodings[Math.min(encodingIndex, baselineEncodings.length - 1)] || {})
  ));
  const maxScale = Math.max(...scales);

  if (mode === 'constrained') {
    return scales[index] === maxScale;
  }

  return encodings.length >= 3 ? scales[index] > Math.min(...scales) : true;
}

/**
 * Per-peer ceiling for what we send over the mesh. Every guest gets their own
 * copy of our camera, so with two or three guests the full 1080p/2.8 Mbps
 * layer (or 4K/6 Mbps) per peer saturates a home uplink; each peer connection's
 * congestion control only sees its own share.
 */
export interface MeshVideoSendCap {
  maxLongEdge: number;
  maxBitrate: number;
  maxFramerate: number;
}

export function getMeshVideoSendCap(peerCount: number): MeshVideoSendCap {
  if (peerCount <= 1) return { maxLongEdge: 1920, maxBitrate: 2_500_000, maxFramerate: 30 };
  if (peerCount === 2) return { maxLongEdge: 1280, maxBitrate: 2_000_000, maxFramerate: 30 };
  if (peerCount === 3) return { maxLongEdge: 1280, maxBitrate: 1_500_000, maxFramerate: 30 };
  if (peerCount === 4) return { maxLongEdge: 960, maxBitrate: 1_000_000, maxFramerate: 30 };
  return { maxLongEdge: 640, maxBitrate: 600_000, maxFramerate: 24 };
}

export type ScreenShareOptimization = 'text' | 'motion';

/** Screen shares: text stays sharp at a low frame rate; motion (a video) gets the frames. */
export function getMeshScreenSendCap(peerCount: number, optimizeFor: ScreenShareOptimization): { maxBitrate: number; maxFramerate: number } {
  const many = peerCount >= 4;
  const few = peerCount <= 1;
  if (optimizeFor === 'motion') {
    return { maxBitrate: few ? 3_000_000 : many ? 1_200_000 : 2_000_000, maxFramerate: 30 };
  }
  return { maxBitrate: few ? 2_500_000 : many ? 1_000_000 : 1_500_000, maxFramerate: 15 };
}

function readTrackLongEdge(track: MediaStreamTrack | null): number | null {
  try {
    const settings = typeof track?.getSettings === 'function' ? track.getSettings() : {};
    const longEdge = Math.max(Number(settings.width) || 0, Number(settings.height) || 0);
    return longEdge > 0 ? longEdge : null;
  } catch {
    return null;
  }
}

export async function applyBandwidthModeToVideoSender(
  sender: RTCRtpSender,
  mode: BandwidthAdaptationMode,
  cap?: MeshVideoSendCap | null
): Promise<boolean> {
  if (
    sender.track?.kind !== 'video' ||
    typeof sender.getParameters !== 'function' ||
    typeof sender.setParameters !== 'function'
  ) {
    return false;
  }

  const parameters = sender.getParameters();
  if (!parameters.encodings || parameters.encodings.length === 0) return false;

  const modeConfig = MODE_MULTIPLIERS[mode];
  const baselineEncodings = buildVideoSimulcastEncodingsForTrack(sender.track);
  const fallbackBaseline = baselineEncodings[0] || {
    maxBitrate: 2_000_000,
    maxFramerate: 30,
    scaleResolutionDownBy: 1,
  };

  // Peer-to-peer, only the first encoding is ever sent (the answer carries no
  // simulcast), at full resolution: scale it to the mesh ceiling.
  const singleEncoding = parameters.encodings.length === 1;
  const longEdge = cap && singleEncoding ? readTrackLongEdge(sender.track) : null;
  parameters.encodings = parameters.encodings.map((encoding, index) => {
    const baseline = baselineEncodings[Math.min(index, baselineEncodings.length - 1)] || fallbackBaseline;
    const baselineMaxBitrate = Math.min(
      asNumber(baseline.maxBitrate) ?? asNumber(encoding.maxBitrate) ?? 2_000_000,
      cap ? cap.maxBitrate : Number.POSITIVE_INFINITY
    );
    const baselineMaxFramerate = Math.min(
      asNumber(baseline.maxFramerate) ?? asNumber(encoding.maxFramerate) ?? 30,
      cap ? cap.maxFramerate : Number.POSITIVE_INFINITY
    );
    const maxBitrate = Math.max(MIN_VIDEO_BITRATE, Math.round(baselineMaxBitrate * modeConfig.bitrate));
    const maxFramerate = modeConfig.maxFramerate === null
      ? baselineMaxFramerate
      : Math.min(baselineMaxFramerate, modeConfig.maxFramerate);
    const baseScale = asNumber(encoding.scaleResolutionDownBy) ?? asNumber(baseline.scaleResolutionDownBy) ?? 1;
    const scaleResolutionDownBy = cap && singleEncoding && longEdge
      ? Math.max(asNumber(baseline.scaleResolutionDownBy) ?? 1, Math.round((longEdge / cap.maxLongEdge) * 100) / 100, 1)
      : encoding.scaleResolutionDownBy ?? baseline.scaleResolutionDownBy ?? baseScale;

    return {
      ...encoding,
      active: shouldKeepEncodingActive(mode, index, parameters.encodings || [], baselineEncodings),
      scaleResolutionDownBy,
      maxBitrate,
      maxFramerate,
    };
  });

  await sender.setParameters(parameters);
  return true;
}
