import { SfuSignalingHub, type SfuServerMessage, type SfuTransportLike } from './sfuSignaling.js';
import type { LayerSelectionOptions } from './sfuRouter.js';

/**
 * Multiplexes SFU signaling across rooms and connections.
 *
 * A WebSocket server calls {@link connect} for each socket (with its room and
 * participant id and a send closure), routes inbound frames through
 * {@link handleMessage}, and calls {@link disconnect} on close. The manager owns
 * one {@link SfuSignalingHub} per room and gives each hub a room-level send that
 * resolves the current socket for any participant, so hub broadcasts reach the
 * right sockets. Empty rooms are torn down automatically.
 */

export type SfuParticipantSend = (message: SfuServerMessage) => void;

/**
 * Creates a per-room media transport. The factory receives a send function that
 * resolves the current socket for any participant in that room, so transport
 * events (e.g. ICE candidates) can be pushed to the right connection.
 */
export type SfuTransportFactory = (
  roomSend: (participantId: string, message: SfuServerMessage) => void
) => SfuTransportLike & { closeAll?: () => Promise<void> };

export interface SfuConnectOptions {
  expiresAtMs?: number;
  issuedAtMs?: number;
  nowMs?: number;
  onRevoke?: (reason: string) => void;
}

const MAX_SFU_ROOMS = 512;
const MAX_TIMEOUT_MS = 2_147_483_647;

interface RoomEntry {
  hub: SfuSignalingHub;
  participants: Set<string>;
  transport: (SfuTransportLike & { closeAll?: () => Promise<void> }) | null;
}

function participantRoomKey(roomId: string, participantId: string): string {
  return `${roomId}:${participantId}`;
}

export class SfuManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly sends = new Map<string, SfuParticipantSend>();
  private readonly participantRoom = new Map<string, string>();
  private readonly connections = new Map<string, symbol>();
  private readonly onRevokeCallbacks = new Map<string, (reason: string) => void>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly expiresAtByParticipant = new Map<string, number>();
  private readonly revokedParticipants = new Map<string, number>();
  private readonly revokedRooms = new Map<string, number>();

  constructor(
    private readonly options: LayerSelectionOptions = {},
    private readonly createTransport: SfuTransportFactory | null = null
  ) {}

  getRoomCount(): number {
    return this.rooms.size;
  }

  getParticipantCount(): number {
    return this.participantRoom.size;
  }

  getRoomParticipantCount(roomId: string): number {
    return this.rooms.get(roomId)?.participants.size ?? 0;
  }

  isParticipantRevoked(roomId: string, participantId: string, issuedAtMs?: number): boolean {
    const key = participantRoomKey(roomId, participantId);
    const participantRevokedAt = this.revokedParticipants.get(key);
    const roomRevokedAt = this.revokedRooms.get(roomId);
    const revokedAt = Math.max(participantRevokedAt ?? -Infinity, roomRevokedAt ?? -Infinity);
    if (!Number.isFinite(revokedAt)) return false;
    return issuedAtMs === undefined || issuedAtMs <= revokedAt;
  }

  private clearExpiryTimer(participantId: string): void {
    const timer = this.expiryTimers.get(participantId);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(participantId);
    }
    this.expiresAtByParticipant.delete(participantId);
  }

  private ensureRoom(roomId: string): RoomEntry {
    let entry = this.rooms.get(roomId);
    if (!entry) {
      if (this.rooms.size >= MAX_SFU_ROOMS) {
        throw new Error(`SFU is at capacity (max ${MAX_SFU_ROOMS} rooms)`);
      }
      const roomSend = (participantId: string, message: SfuServerMessage) => {
        if (this.rooms.get(roomId) !== entry || this.participantRoom.get(participantId) !== roomId) return;
        this.sends.get(participantId)?.(message);
      };
      const transport = this.createTransport ? this.createTransport(roomSend) : null;
      const hub = new SfuSignalingHub(roomSend, this.options, transport);
      entry = { hub, participants: new Set(), transport };
      this.rooms.set(roomId, entry);
    }
    return entry;
  }

  /** Register a socket for a participant in a room. Replaces any prior connection for that id. */
  connect(
    roomId: string,
    participantId: string,
    send: SfuParticipantSend,
    options: SfuConnectOptions = {}
  ): symbol {
    if (!roomId || !participantId) throw new Error('roomId and participantId are required');
    const nowMs = options.nowMs ?? Date.now();
    if (options.expiresAtMs !== undefined && options.expiresAtMs <= nowMs) {
      throw new Error('SFU token expired');
    }
    if (this.isParticipantRevoked(roomId, participantId, options.issuedAtMs)) {
      throw new Error('SFU membership has been revoked');
    }
    // A freshly minted token issued after a prior revocation clears that participant's revocation.
    if (options.issuedAtMs !== undefined) {
      const key = participantRoomKey(roomId, participantId);
      const participantRevokedAt = this.revokedParticipants.get(key);
      if (participantRevokedAt !== undefined && options.issuedAtMs > participantRevokedAt) {
        this.revokedParticipants.delete(key);
      }
    }

    // A new socket starts a fresh media lifecycle, including when it replaces
    // the same identity in the same room. Pending offers belong to the old PC.
    const priorRoom = this.participantRoom.get(participantId);
    if (priorRoom) {
      this.disconnect(participantId);
    }
    const entry = this.ensureRoom(roomId);
    const connection = Symbol(participantId);
    this.sends.set(participantId, send);
    this.connections.set(participantId, connection);
    this.participantRoom.set(participantId, roomId);
    if (options.onRevoke) {
      this.onRevokeCallbacks.set(participantId, options.onRevoke);
    }
    if (options.expiresAtMs !== undefined && Number.isFinite(options.expiresAtMs)) {
      this.expiresAtByParticipant.set(participantId, options.expiresAtMs);
      const delayMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(options.expiresAtMs - nowMs)));
      const timer = setTimeout(() => {
        if (this.connections.get(participantId) !== connection) return;
        const onRevoke = this.onRevokeCallbacks.get(participantId);
        this.disconnect(participantId, connection);
        onRevoke?.('SFU token expired');
      }, delayMs);
      timer.unref?.();
      this.expiryTimers.set(participantId, timer);
    }
    entry.participants.add(participantId);
    return connection;
  }

  handleMessage(participantId: string, raw: unknown, connection?: symbol, nowMs?: number): boolean {
    if (connection !== undefined && this.connections.get(participantId) !== connection) return false;
    const roomId = this.participantRoom.get(participantId);
    if (!roomId) return false;
    const expiresAtMs = this.expiresAtByParticipant.get(participantId);
    if (nowMs !== undefined && expiresAtMs !== undefined && expiresAtMs <= nowMs) {
      const activeConn = this.connections.get(participantId);
      const onRevoke = this.onRevokeCallbacks.get(participantId);
      this.disconnect(participantId, activeConn);
      onRevoke?.('SFU token expired');
      return false;
    }
    const entry = this.rooms.get(roomId);
    if (!entry) return false;
    return entry.hub.handleMessage(participantId, raw);
  }

  /**
   * Immediately revokes a participant's SFU membership in `roomId`, tearing down
   * any active SFU transport and preventing reuse of tokens minted at or before `revokedAtMs`.
   */
  revokeParticipant(
    roomId: string,
    participantId: string,
    reason = 'SFU membership revoked',
    revokedAtMs = Date.now()
  ): boolean {
    if (!roomId || !participantId) return false;
    this.revokedParticipants.set(participantRoomKey(roomId, participantId), revokedAtMs);
    if (this.participantRoom.get(participantId) !== roomId) return false;
    const activeConnection = this.connections.get(participantId);
    const onRevoke = this.onRevokeCallbacks.get(participantId);
    this.disconnect(participantId, activeConnection);
    onRevoke?.(reason);
    return true;
  }

  /** Clears a prior participant revocation when re-admitted to the live stage. */
  allowParticipant(roomId: string, participantId: string): void {
    if (!roomId || !participantId) return;
    this.revokedParticipants.delete(participantRoomKey(roomId, participantId));
  }

  /** Revokes and disconnects every SFU participant in `roomId`. */
  revokeRoom(roomId: string, reason = 'Room closed', revokedAtMs = Date.now()): number {
    if (!roomId) return 0;
    this.revokedRooms.set(roomId, revokedAtMs);
    const entry = this.rooms.get(roomId);
    if (!entry) return 0;
    const participantIds = [...entry.participants];
    let disconnected = 0;
    for (const participantId of participantIds) {
      if (this.revokeParticipant(roomId, participantId, reason, revokedAtMs)) {
        disconnected += 1;
      }
    }
    return disconnected;
  }

  disconnect(participantId: string, connection?: symbol): void {
    // A replaced socket may close after its successor authenticates. Its close
    // and late frames must not tear down or control the current participant.
    if (connection !== undefined && this.connections.get(participantId) !== connection) return;
    this.clearExpiryTimer(participantId);
    this.onRevokeCallbacks.delete(participantId);
    const roomId = this.participantRoom.get(participantId);
    this.participantRoom.delete(participantId);
    this.connections.delete(participantId);
    this.sends.delete(participantId);
    if (!roomId) return;
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.hub.handleDisconnect(participantId);
    entry.participants.delete(participantId);
    if (entry.participants.size === 0) {
      this.rooms.delete(roomId);
      void entry.transport?.closeAll?.().catch(() => undefined);
    }
  }
}
