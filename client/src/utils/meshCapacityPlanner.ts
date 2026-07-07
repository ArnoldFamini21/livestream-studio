export type MeshCapacityStatus = 'comfortable' | 'tight' | 'over';
export type MeshQualityTier = '1080p' | '720p' | '540p' | '360p' | '270p';

export interface MeshCapacityPlan {
  // Number of on-stage participants (including the local host).
  participantCount: number;
  // Remote peers the local sender must upload a copy of its stream to (mesh fan-out).
  outgoingPeerCount: number;
  // Uplink budget (kbps) used for the plan after clamping.
  uplinkBudgetKbps: number;
  // Recommended per-sender max bitrate so aggregate upload stays within budget.
  perSenderKbps: number;
  // Recommended capture/publish tier for the recommended per-sender bitrate.
  recommendedTier: MeshQualityTier;
  // Longest edge (px) for the recommended tier — pass to the simulcast top layer.
  recommendedMaxLongEdge: number;
  // Estimated total simultaneous upload at the recommended per-sender bitrate.
  aggregateUploadKbps: number;
  status: MeshCapacityStatus;
  // True when mesh can no longer sustain acceptable quality and an SFU is warranted.
  sfuRecommended: boolean;
  note: string;
}

export interface MeshCapacityInput {
  participantCount: number;
  uplinkKbps?: number | null;
}

// Mesh fan-out beyond this many senders overwhelms typical residential uplinks
// regardless of per-sender quality, so an SFU is recommended past it.
export const MESH_SFU_PEER_THRESHOLD = 6;

const DEFAULT_UPLINK_KBPS = 6_000;
const MIN_UPLINK_KBPS = 1_000;
const MAX_UPLINK_KBPS = 100_000;
const UPLINK_HEADROOM = 0.85;
const MIN_PER_SENDER_KBPS = 200;
const MAX_PER_SENDER_KBPS = 3_200;

interface TierSpec {
  tier: MeshQualityTier;
  minKbps: number;
  maxLongEdge: number;
}

// Ordered high → low; the first tier whose minKbps fits the per-sender budget wins.
const TIER_LADDER: TierSpec[] = [
  { tier: '1080p', minKbps: 2_200, maxLongEdge: 1920 },
  { tier: '720p', minKbps: 1_100, maxLongEdge: 1280 },
  { tier: '540p', minKbps: 600, maxLongEdge: 960 },
  { tier: '360p', minKbps: 320, maxLongEdge: 640 },
  { tier: '270p', minKbps: 0, maxLongEdge: 480 },
];

export function clampUplinkKbps(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_UPLINK_KBPS;
  return Math.min(MAX_UPLINK_KBPS, Math.max(MIN_UPLINK_KBPS, Math.round(numeric)));
}

export function selectMeshQualityTier(perSenderKbps: number): TierSpec {
  return TIER_LADDER.find((spec) => perSenderKbps >= spec.minKbps) || TIER_LADDER[TIER_LADDER.length - 1];
}

export function planMeshCapacity(input: MeshCapacityInput): MeshCapacityPlan {
  const participantCount = Number.isFinite(input.participantCount)
    ? Math.max(0, Math.floor(input.participantCount))
    : 0;
  const outgoingPeerCount = Math.max(0, participantCount - 1);
  const uplinkBudgetKbps = clampUplinkKbps(input.uplinkKbps);

  if (outgoingPeerCount === 0) {
    return {
      participantCount,
      outgoingPeerCount: 0,
      uplinkBudgetKbps,
      perSenderKbps: MAX_PER_SENDER_KBPS,
      recommendedTier: '1080p',
      recommendedMaxLongEdge: 1920,
      aggregateUploadKbps: 0,
      status: 'comfortable',
      sfuRecommended: false,
      note: 'Solo stage — full quality, no mesh upload fan-out.',
    };
  }

  const usableKbps = uplinkBudgetKbps * UPLINK_HEADROOM;
  const rawPerSender = Math.floor(usableKbps / outgoingPeerCount);
  const perSenderKbps = Math.min(MAX_PER_SENDER_KBPS, Math.max(MIN_PER_SENDER_KBPS, rawPerSender));
  const tier = selectMeshQualityTier(perSenderKbps);
  const aggregateUploadKbps = perSenderKbps * outgoingPeerCount;

  // If we had to floor the per-sender bitrate, aggregate upload exceeds the usable budget.
  const overBudget = rawPerSender < MIN_PER_SENDER_KBPS;
  const sfuRecommended = overBudget || outgoingPeerCount >= MESH_SFU_PEER_THRESHOLD;

  let status: MeshCapacityStatus;
  if (overBudget) {
    status = 'over';
  } else if (perSenderKbps <= 600 || outgoingPeerCount >= MESH_SFU_PEER_THRESHOLD - 1) {
    status = 'tight';
  } else {
    status = 'comfortable';
  }

  let note: string;
  if (overBudget) {
    note = `Mesh upload for ${outgoingPeerCount} peers exceeds your ${uplinkBudgetKbps} kbps uplink. Reduce the on-stage count or switch to an SFU.`;
  } else if (sfuRecommended) {
    note = `Sustainable at ${tier}, but ${outgoingPeerCount} mesh uploads is near the practical limit — an SFU is recommended for larger stages.`;
  } else if (status === 'tight') {
    note = `Capping senders to ${tier} keeps ${outgoingPeerCount} mesh uploads within your uplink.`;
  } else {
    note = `${outgoingPeerCount} mesh upload${outgoingPeerCount === 1 ? '' : 's'} fit comfortably at ${tier}.`;
  }

  return {
    participantCount,
    outgoingPeerCount,
    uplinkBudgetKbps,
    perSenderKbps,
    recommendedTier: tier.tier,
    recommendedMaxLongEdge: tier.maxLongEdge,
    aggregateUploadKbps,
    status,
    sfuRecommended,
    note,
  };
}
