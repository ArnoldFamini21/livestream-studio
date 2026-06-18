import type { RawData } from 'ws';
import type {
  RtmpRelayClientMessage,
  RtmpRelayPingPayload,
  RtmpRelayStartPayload,
} from '@studio/shared';

function isStartPayload(payload: unknown): payload is RtmpRelayStartPayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.token === 'string' &&
    Array.isArray(candidate.destinations) &&
    typeof candidate.video === 'object' &&
    candidate.video !== null &&
    typeof candidate.audio === 'object' &&
    candidate.audio !== null
  );
}

function isPingPayload(payload: unknown): payload is RtmpRelayPingPayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Record<string, unknown>;
  return (
    typeof candidate.sentAt === 'number' &&
    Number.isFinite(candidate.sentAt) &&
    candidate.sentAt >= 0 &&
    typeof candidate.sequence === 'number' &&
    Number.isSafeInteger(candidate.sequence) &&
    candidate.sequence >= 0
  );
}

export function parseControlMessage(data: RawData): RtmpRelayClientMessage | null {
  if (!Buffer.isBuffer(data)) return null;
  try {
    const parsed = JSON.parse(data.toString('utf8')) as RtmpRelayClientMessage;
    if (parsed?.type === 'stop') return { type: 'stop' };
    if (parsed?.type === 'start' && isStartPayload(parsed.payload)) return parsed;
    if (parsed?.type === 'ping' && isPingPayload(parsed.payload)) {
      return {
        type: 'ping',
        payload: {
          sentAt: parsed.payload.sentAt,
          sequence: parsed.payload.sequence,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}
