import { findSelectedCandidatePair, type PeerBandwidthQuality } from './webrtcBandwidthAdaptation.ts';

/**
 * How a remote peer's media reaches us. This is what the program, the
 * recording and the host's ears get, so it is what a guest's quality badge
 * should mostly reflect, and it works for audio-only guests (no video at all).
 */

type StatsRecord = Record<string, unknown>;

export interface InboundStatsSnapshot {
  timestampMs: number;
  audio: {
    packetsReceived: number;
    packetsLost: number;
    jitterMs: number | null;
    concealedSamples: number | null;
    totalSamplesReceived: number | null;
  } | null;
  video: {
    packetsReceived: number;
    packetsLost: number;
    framesDecoded: number | null;
    freezeCount: number | null;
    frameHeight: number | null;
  } | null;
  roundTripTimeMs: number | null;
  /** True when either end of the selected candidate pair is a TURN relay. */
  relayed: boolean | null;
}

export interface InboundHealthSample {
  quality: PeerBandwidthQuality;
  packetLossPercent: number | null;
  jitterMs: number | null;
  audioOnly: boolean;
  relayed: boolean | null;
  roundTripTimeMs: number | null;
  /** The connection answered (an RTT was measured) even if no media flowed. */
  connected: boolean;
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function collect(report: unknown): StatsRecord[] {
  const records: StatsRecord[] = [];
  const maybe = report as { forEach?: (callback: (value: unknown) => void) => void };
  if (typeof maybe?.forEach === 'function') {
    maybe.forEach((value) => { if (value && typeof value === 'object') records.push(value as StatsRecord); });
  }
  return records;
}

export function readInboundStatsSnapshot(report: unknown, fallbackTimestampMs = Date.now()): InboundStatsSnapshot {
  const records = collect(report);
  let timestampMs = fallbackTimestampMs;
  let audio = null as InboundStatsSnapshot['audio'];
  let video = null as InboundStatsSnapshot['video'];
  const byId = new Map<string, StatsRecord>();
  for (const stat of records) if (typeof stat.id === 'string') byId.set(stat.id, stat);

  for (const stat of records) {
    if (stat.type !== 'inbound-rtp') continue;
    const kind = stat.kind ?? stat.mediaType;
    const statTimestamp = asNumber(stat.timestamp);
    if (statTimestamp !== null) timestampMs = Math.max(timestampMs, statTimestamp);
    const packetsReceived = Math.max(0, asNumber(stat.packetsReceived) ?? 0);
    const packetsLost = Math.max(0, asNumber(stat.packetsLost) ?? 0);
    if (kind === 'audio') {
      const jitterSeconds = asNumber(stat.jitter);
      audio = {
        packetsReceived: (audio?.packetsReceived ?? 0) + packetsReceived,
        packetsLost: (audio?.packetsLost ?? 0) + packetsLost,
        jitterMs: jitterSeconds !== null ? Math.max(audio?.jitterMs ?? 0, Math.round(jitterSeconds * 1000)) : audio?.jitterMs ?? null,
        concealedSamples: sumNullable(audio?.concealedSamples, asNumber(stat.concealedSamples)),
        totalSamplesReceived: sumNullable(audio?.totalSamplesReceived, asNumber(stat.totalSamplesReceived)),
      };
    } else if (kind === 'video') {
      video = {
        packetsReceived: (video?.packetsReceived ?? 0) + packetsReceived,
        packetsLost: (video?.packetsLost ?? 0) + packetsLost,
        framesDecoded: sumNullable(video?.framesDecoded, asNumber(stat.framesDecoded)),
        freezeCount: sumNullable(video?.freezeCount, asNumber(stat.freezeCount)),
        frameHeight: Math.max(video?.frameHeight ?? 0, asNumber(stat.frameHeight) ?? 0) || null,
      };
    }
  }

  const pair = findSelectedCandidatePair(records);
  const rttSeconds = asNumber(pair?.currentRoundTripTime);
  let relayed: boolean | null = null;
  if (pair) {
    const local = typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined;
    const remote = typeof pair.remoteCandidateId === 'string' ? byId.get(pair.remoteCandidateId) : undefined;
    if (local || remote) relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  }

  return {
    timestampMs,
    audio,
    video,
    roundTripTimeMs: rttSeconds !== null ? Math.round(rttSeconds * 1000) : null,
    relayed,
  };
}

function sumNullable(previous: number | null | undefined, next: number | null): number | null {
  if (next === null) return previous ?? null;
  return (previous ?? 0) + next;
}

function lossRatio(lostDelta: number, receivedDelta: number): number | null {
  const total = Math.max(0, lostDelta) + Math.max(0, receivedDelta);
  return total > 0 ? Math.max(0, lostDelta) / total : null;
}

/** Compare two snapshots a few seconds apart and grade what arrived in between. */
export function assessInboundHealth(previous: InboundStatsSnapshot | null, current: InboundStatsSnapshot): InboundHealthSample {
  const audioOnly = Boolean(current.audio) && (!current.video || (previous?.video ? current.video.packetsReceived <= previous.video.packetsReceived : current.video.packetsReceived === 0));
  const base = {
    audioOnly,
    relayed: current.relayed,
    roundTripTimeMs: current.roundTripTimeMs,
    connected: current.roundTripTimeMs !== null,
    jitterMs: current.audio?.jitterMs ?? null,
  };
  if (!previous) return { ...base, quality: 'unknown', packetLossPercent: null };

  const audioReceived = (current.audio?.packetsReceived ?? 0) - (previous.audio?.packetsReceived ?? 0);
  const audioLost = (current.audio?.packetsLost ?? 0) - (previous.audio?.packetsLost ?? 0);
  const videoReceived = (current.video?.packetsReceived ?? 0) - (previous.video?.packetsReceived ?? 0);
  const videoLost = (current.video?.packetsLost ?? 0) - (previous.video?.packetsLost ?? 0);
  const concealed = current.audio?.concealedSamples !== null && current.audio?.concealedSamples !== undefined && previous.audio?.concealedSamples !== null && previous.audio?.concealedSamples !== undefined
    ? current.audio.concealedSamples - previous.audio.concealedSamples
    : null;
  const samples = current.audio?.totalSamplesReceived !== null && current.audio?.totalSamplesReceived !== undefined && previous.audio?.totalSamplesReceived !== null && previous.audio?.totalSamplesReceived !== undefined
    ? current.audio.totalSamplesReceived - previous.audio.totalSamplesReceived
    : null;
  const freezes = current.video?.freezeCount !== null && current.video?.freezeCount !== undefined && previous.video?.freezeCount !== null && previous.video?.freezeCount !== undefined
    ? current.video.freezeCount - previous.video.freezeCount
    : 0;

  const audioLoss = lossRatio(audioLost, audioReceived);
  const videoLoss = lossRatio(videoLost, videoReceived);
  const concealment = concealed !== null && samples !== null && samples > 0 ? Math.max(0, concealed) / samples : null;
  const worstLoss = Math.max(audioLoss ?? 0, videoLoss ?? 0);
  const packetLossPercent = audioLoss === null && videoLoss === null ? null : Math.round(worstLoss * 1000) / 10;
  const jitterMs = base.jitterMs;

  if (audioReceived <= 0 && videoReceived <= 0) {
    return { ...base, quality: 'unknown', packetLossPercent };
  }

  let quality: PeerBandwidthQuality = 'good';
  if (
    (audioLoss !== null && audioLoss >= 0.08) ||
    (videoLoss !== null && videoLoss >= 0.1) ||
    (concealment !== null && concealment >= 0.1) ||
    freezes >= 2 ||
    (jitterMs !== null && jitterMs >= 150)
  ) {
    quality = 'poor';
  } else if (
    (audioLoss !== null && audioLoss >= 0.03) ||
    (videoLoss !== null && videoLoss >= 0.04) ||
    (concealment !== null && concealment >= 0.03) ||
    freezes >= 1 ||
    (jitterMs !== null && jitterMs >= 60)
  ) {
    quality = 'fair';
  }
  return { ...base, quality, packetLossPercent };
}
