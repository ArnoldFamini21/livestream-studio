import { buildVideoSimulcastEncodingsForTrack } from './webrtcSimulcast.ts';

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
}

export interface OutboundVideoStatsDelta {
  bitrateKbps: number | null;
  packetLossRatio: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
}

export interface BandwidthAdaptationState {
  mode: BandwidthAdaptationMode;
  stableSamples: number;
  pressureSamples: number;
  lastSnapshot: OutboundVideoStatsSnapshot | null;
  lastDelta: OutboundVideoStatsDelta | null;
}

export interface PeerBandwidthHealth {
  mode: BandwidthAdaptationMode;
  quality: PeerBandwidthQuality;
  bitrateKbps: number | null;
  packetLossPercent: number | null;
  roundTripTimeMs: number | null;
  availableOutgoingBitrateKbps: number | null;
  updatedAtMs: number;
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
  let hasOutboundVideo = false;

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
      const statPacketsLost = asNumber(stat.packetsLost);
      if (statPacketsLost !== null) {
        packetsLost = Math.max(packetsLost ?? 0, statPacketsLost);
      }
      const rttSeconds = asNumber(stat.roundTripTime);
      if (rttSeconds !== null) {
        roundTripTimeMs = Math.max(roundTripTimeMs ?? 0, Math.round(rttSeconds * 1000));
      }
    } else if (type === 'candidate-pair' && (asBoolean(stat.selected) || asBoolean(stat.nominated) || stat.state === 'succeeded')) {
      const rttSeconds = asNumber(stat.currentRoundTripTime);
      if (rttSeconds !== null) {
        roundTripTimeMs = Math.max(roundTripTimeMs ?? 0, Math.round(rttSeconds * 1000));
      }
      const outgoingBitrate = asNumber(stat.availableOutgoingBitrate);
      if (outgoingBitrate !== null) {
        availableOutgoingBitrateKbps = Math.round(outgoingBitrate / 1000);
      }
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
  };
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
  };
}

export function classifyBandwidthPressure(delta: OutboundVideoStatsDelta): BandwidthPressureSignal {
  const hasSignal =
    delta.packetLossRatio !== null ||
    delta.roundTripTimeMs !== null ||
    delta.availableOutgoingBitrateKbps !== null;

  if (!hasSignal) return 'unknown';

  if (
    (delta.packetLossRatio !== null && delta.packetLossRatio >= 0.08) ||
    (delta.roundTripTimeMs !== null && delta.roundTripTimeMs >= 750) ||
    (delta.availableOutgoingBitrateKbps !== null && delta.availableOutgoingBitrateKbps <= 750)
  ) {
    return 'constrained';
  }

  if (
    (delta.packetLossRatio !== null && delta.packetLossRatio >= 0.03) ||
    (delta.roundTripTimeMs !== null && delta.roundTripTimeMs >= 400) ||
    (delta.availableOutgoingBitrateKbps !== null && delta.availableOutgoingBitrateKbps <= 1600)
  ) {
    return 'balanced';
  }

  return 'stable';
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
  if (!state.lastSnapshot) {
    return {
      ...state,
      lastSnapshot: snapshot,
      lastDelta: null,
    };
  }

  const delta = calculateOutboundVideoStatsDelta(state.lastSnapshot, snapshot);
  const signal = classifyBandwidthPressure(delta);

  if (signal === 'constrained') {
    return {
      mode: 'constrained',
      stableSamples: 0,
      pressureSamples: state.pressureSamples + 1,
      lastSnapshot: snapshot,
      lastDelta: delta,
    };
  }

  if (signal === 'balanced') {
    return {
      mode: state.mode === 'constrained' ? 'constrained' : 'balanced',
      stableSamples: 0,
      pressureSamples: state.pressureSamples + 1,
      lastSnapshot: snapshot,
      lastDelta: delta,
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
    };
  }

  return {
    ...state,
    lastSnapshot: snapshot,
    lastDelta: delta,
  };
}

export function getPeerBandwidthQuality(state: BandwidthAdaptationState): PeerBandwidthQuality {
  if (!state.lastDelta) return 'unknown';

  const pressure = classifyBandwidthPressure(state.lastDelta);
  if (pressure === 'constrained' || state.mode === 'constrained') return 'poor';
  if (pressure === 'balanced' || state.mode === 'balanced') return 'fair';
  if (pressure === 'stable') return 'good';
  return 'unknown';
}

export function buildPeerBandwidthHealth(
  state: BandwidthAdaptationState,
  updatedAtMs = Date.now()
): PeerBandwidthHealth {
  const delta = state.lastDelta;
  return {
    mode: state.mode,
    quality: getPeerBandwidthQuality(state),
    bitrateKbps: delta?.bitrateKbps ?? null,
    packetLossPercent: delta?.packetLossRatio !== null && delta?.packetLossRatio !== undefined
      ? Math.round(delta.packetLossRatio * 1000) / 10
      : null,
    roundTripTimeMs: delta?.roundTripTimeMs ?? null,
    availableOutgoingBitrateKbps: delta?.availableOutgoingBitrateKbps ?? null,
    updatedAtMs,
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

export async function applyBandwidthModeToVideoSender(
  sender: RTCRtpSender,
  mode: BandwidthAdaptationMode
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

  parameters.encodings = parameters.encodings.map((encoding, index) => {
    const baseline = baselineEncodings[Math.min(index, baselineEncodings.length - 1)] || fallbackBaseline;
    const baselineMaxBitrate = asNumber(baseline.maxBitrate) ?? asNumber(encoding.maxBitrate) ?? 2_000_000;
    const baselineMaxFramerate = asNumber(baseline.maxFramerate) ?? asNumber(encoding.maxFramerate) ?? 30;
    const maxBitrate = Math.max(MIN_VIDEO_BITRATE, Math.round(baselineMaxBitrate * modeConfig.bitrate));
    const maxFramerate = modeConfig.maxFramerate === null
      ? baselineMaxFramerate
      : Math.min(baselineMaxFramerate, modeConfig.maxFramerate);

    return {
      ...encoding,
      active: shouldKeepEncodingActive(mode, index, parameters.encodings || [], baselineEncodings),
      scaleResolutionDownBy: encoding.scaleResolutionDownBy ?? baseline.scaleResolutionDownBy,
      maxBitrate,
      maxFramerate,
    };
  });

  await sender.setParameters(parameters);
  return true;
}
