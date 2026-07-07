import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MESH_SFU_PEER_THRESHOLD,
  clampUplinkKbps,
  planMeshCapacity,
  selectMeshQualityTier,
} from '../src/utils/meshCapacityPlanner.ts';

describe('clampUplinkKbps', () => {
  it('defaults and clamps out-of-range values', () => {
    assert.equal(clampUplinkKbps(undefined), 6_000);
    assert.equal(clampUplinkKbps(null), 6_000);
    assert.equal(clampUplinkKbps(0), 6_000);
    assert.equal(clampUplinkKbps(500), 1_000);
    assert.equal(clampUplinkKbps(999_999), 100_000);
    assert.equal(clampUplinkKbps(8_000), 8_000);
  });
});

describe('selectMeshQualityTier', () => {
  it('maps per-sender bitrate to a quality tier', () => {
    assert.equal(selectMeshQualityTier(3_000).tier, '1080p');
    assert.equal(selectMeshQualityTier(1_500).tier, '720p');
    assert.equal(selectMeshQualityTier(700).tier, '540p');
    assert.equal(selectMeshQualityTier(400).tier, '360p');
    assert.equal(selectMeshQualityTier(200).tier, '270p');
  });
});

describe('planMeshCapacity', () => {
  it('treats a solo stage as unconstrained', () => {
    const plan = planMeshCapacity({ participantCount: 1, uplinkKbps: 6_000 });
    assert.equal(plan.outgoingPeerCount, 0);
    assert.equal(plan.aggregateUploadKbps, 0);
    assert.equal(plan.status, 'comfortable');
    assert.equal(plan.sfuRecommended, false);
    assert.equal(plan.recommendedTier, '1080p');
  });

  it('keeps a small stage comfortable at high quality', () => {
    const plan = planMeshCapacity({ participantCount: 3, uplinkKbps: 10_000 });
    assert.equal(plan.outgoingPeerCount, 2);
    // 10000 * 0.85 / 2 = 4250 -> clamped to 3200 max
    assert.equal(plan.perSenderKbps, 3_200);
    assert.equal(plan.recommendedTier, '1080p');
    assert.equal(plan.status, 'comfortable');
    assert.equal(plan.sfuRecommended, false);
  });

  it('lowers the recommended tier as the stage grows', () => {
    const plan = planMeshCapacity({ participantCount: 5, uplinkKbps: 6_000 });
    assert.equal(plan.outgoingPeerCount, 4);
    // 6000 * 0.85 / 4 = 1275 -> 720p tier
    assert.equal(plan.perSenderKbps, 1_275);
    assert.equal(plan.recommendedTier, '720p');
    assert.ok(plan.aggregateUploadKbps <= 6_000 * 0.85);
  });

  it('recommends an SFU at or beyond the mesh peer threshold', () => {
    const plan = planMeshCapacity({ participantCount: MESH_SFU_PEER_THRESHOLD + 1, uplinkKbps: 20_000 });
    assert.equal(plan.outgoingPeerCount, MESH_SFU_PEER_THRESHOLD);
    assert.equal(plan.sfuRecommended, true);
    assert.match(plan.note, /SFU/);
  });

  it('flags over-budget when the uplink cannot sustain the fan-out', () => {
    const plan = planMeshCapacity({ participantCount: 9, uplinkKbps: 1_000 });
    assert.equal(plan.outgoingPeerCount, 8);
    // 1000 * 0.85 / 8 = 106 -> below the 200 floor, so over budget
    assert.equal(plan.perSenderKbps, 200);
    assert.equal(plan.status, 'over');
    assert.equal(plan.sfuRecommended, true);
    assert.match(plan.note, /exceeds your 1000 kbps uplink/);
  });

  it('uses the default uplink budget when none is provided', () => {
    const plan = planMeshCapacity({ participantCount: 4 });
    assert.equal(plan.uplinkBudgetKbps, 6_000);
    assert.equal(plan.outgoingPeerCount, 3);
  });

  it('never lets the aggregate estimate drop below a single peer of headroom', () => {
    const plan = planMeshCapacity({ participantCount: 2, uplinkKbps: 6_000 });
    assert.equal(plan.outgoingPeerCount, 1);
    assert.equal(plan.aggregateUploadKbps, plan.perSenderKbps);
  });
});
