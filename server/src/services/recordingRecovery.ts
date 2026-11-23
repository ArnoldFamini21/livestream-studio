import { createHmac } from 'node:crypto';
import {
  RECORDING_RECOVERY_IDENTIFIER, RECORDING_RECOVERY_TTL_MS, recordingRecoveryHostScope,
  type RecordingRecoveryCreateClaims, type RecordingRecoveryGrant, type RecordingRecoveryParticipant,
  type RecordingRecoveryUploadClaims,
} from '@studio/shared';

export interface PendingRecordingRecovery {
  roomId: string;
  takeId: string;
  storageId: string;
  participants: RecordingRecoveryParticipant[];
  expiresAtMs: number;
}

function sign(claims: RecordingRecoveryCreateClaims | RecordingRecoveryUploadClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export async function registerPrivateTake(options: {
  roomId: string;
  takeId: string;
  hostToken: string;
  participants: RecordingRecoveryParticipant[];
  mediaUrl: string;
  secret: string;
  fetcher?: typeof fetch;
  now?: number;
}): Promise<PendingRecordingRecovery> {
  const { roomId, takeId, hostToken, participants, mediaUrl, secret, fetcher = fetch, now = Date.now() } = options;
  if (!RECORDING_RECOVERY_IDENTIFIER.test(roomId) || !RECORDING_RECOVERY_IDENTIFIER.test(takeId)) {
    throw new Error('Invalid take for recording recovery');
  }
  const storageId = createHmac('sha256', secret).update(recordingRecoveryHostScope(roomId, takeId, hostToken)).digest('hex');
  const exp = now + 45_000;
  const expiresAtMs = now + RECORDING_RECOVERY_TTL_MS;
  const token = sign({ v: 1, purpose: 'recording-recovery-create', roomId, takeId, storageId, exp }, secret);
  const response = await fetcher(`${mediaUrl.replace(/\/+$/, '')}/recording-recovery/takes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ participants, createdAtMs: now, expiresAtMs }),
    redirect: 'error',
    signal: AbortSignal.timeout(45_000),
  });
  // The existing manifest's original expiry is returned if a setup response was lost.
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Private recording storage could not register this take');
  }
  const durable = await response.json() as { expiresAt?: string; participants?: RecordingRecoveryParticipant[] };
  const durableExpiry = Date.parse(durable.expiresAt ?? '');
  if (!Number.isSafeInteger(durableExpiry) || durableExpiry <= now || durableExpiry > expiresAtMs ||
      !Array.isArray(durable.participants)) {
    throw new Error('Private recording storage returned an invalid take manifest');
  }
  return { roomId, takeId, storageId, participants: durable.participants, expiresAtMs: durableExpiry };
}

export function issuePrivateTakeUploadGrant(
  take: PendingRecordingRecovery, participantId: string, secret: string, now = Date.now(),
): RecordingRecoveryGrant | undefined {
  if (take.expiresAtMs <= now || !take.participants.some(participant => participant.participantId === participantId)) return;
  const { roomId, takeId, storageId } = take;
  const token = sign({
    v: 1, purpose: 'recording-recovery-upload', roomId, takeId, storageId, participantId, exp: take.expiresAtMs,
  }, secret);
  return { roomId, takeId, participantId, token, expiresAt: new Date(take.expiresAtMs).toISOString() };
}
