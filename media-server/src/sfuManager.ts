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

const MAX_SFU_ROOMS = 512;

interface RoomEntry {
  hub: SfuSignalingHub;
  participants: Set<string>;
  transport: (SfuTransportLike & { closeAll?: () => Promise<void> }) | null;
}

export class SfuManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly sends = new Map<string, SfuParticipantSend>();
  private readonly participantRoom = new Map<string, string>();

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

  private ensureRoom(roomId: string): RoomEntry {
    let entry = this.rooms.get(roomId);
    if (!entry) {
      if (this.rooms.size >= MAX_SFU_ROOMS) {
        throw new Error(`SFU is at capacity (max ${MAX_SFU_ROOMS} rooms)`);
      }
      const roomSend = (participantId: string, message: SfuServerMessage) => {
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
  connect(roomId: string, participantId: string, send: SfuParticipantSend): void {
    if (!roomId || !participantId) throw new Error('roomId and participantId are required');
    // A reconnect under the same id in a different room should leave the old room first.
    const priorRoom = this.participantRoom.get(participantId);
    if (priorRoom && priorRoom !== roomId) {
      this.disconnect(participantId);
    }
    const entry = this.ensureRoom(roomId);
    this.sends.set(participantId, send);
    this.participantRoom.set(participantId, roomId);
    entry.participants.add(participantId);
  }

  handleMessage(participantId: string, raw: unknown): boolean {
    const roomId = this.participantRoom.get(participantId);
    if (!roomId) return false;
    const entry = this.rooms.get(roomId);
    if (!entry) return false;
    return entry.hub.handleMessage(participantId, raw);
  }

  disconnect(participantId: string): void {
    const roomId = this.participantRoom.get(participantId);
    this.participantRoom.delete(participantId);
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
