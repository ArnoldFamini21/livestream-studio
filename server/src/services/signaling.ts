import { WebSocketServer, WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import type {
  SignalMessage,
  Room,
  Participant,
  JoinRoomPayload,
  MediaStatePayload,
  ChatMessage,
  StageActionPayload,
} from '@studio/shared';

// In-memory store (replace with Redis/PostgreSQL later)
interface RoomState {
  room: Room;
  participants: Map<string, { participant: Participant; ws: WebSocket }>;
}

// Extend WebSocket to track heartbeat state
interface AliveWebSocket extends WebSocket {
  isAlive: boolean;
}

// Known message types for validation (fix #10)
const KNOWN_MESSAGE_TYPES = new Set([
  'join-room',
  'offer',
  'answer',
  'ice-candidate',
  'media-state-changed',
  'chat-message',
  'stage-action',
]);

const rooms = new Map<string, RoomState>();
const wsToParticipant = new Map<WebSocket, { roomId: string; participantId: string }>();

export function getRooms() {
  return rooms;
}

export function createRoom(name: string, hostName: string): Room {
  const room: Room = {
    id: nanoid(10),
    name,
    hostId: '',
    coHostIds: [],
    createdAt: new Date().toISOString(),
    status: 'waiting',
    settings: {
      maxParticipants: 12,
      resolution: '1080p',
      frameRate: 30,
      enableRecording: true,
      enableStreaming: false,
      greenRoomEnabled: true,
    },
  };

  rooms.set(room.id, {
    room,
    participants: new Map(),
  });

  return room;
}

// Fix #10: Validate incoming messages before processing
function validateMessage(data: unknown): data is SignalMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;
  if (!KNOWN_MESSAGE_TYPES.has(msg.type)) return false;
  if (msg.payload !== undefined && (typeof msg.payload !== 'object' || msg.payload === null)) return false;
  return true;
}

export function setupSignalingServer(wss: WebSocketServer) {
  // Fix #3: Heartbeat ping/pong interval to detect dead connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const aliveWs = ws as AliveWebSocket;
      if (aliveWs.isAlive === false) {
        // Client did not respond to last ping within the interval — terminate
        aliveWs.terminate();
        return;
      }
      aliveWs.isAlive = false;
      aliveWs.ping();
    });
  }, 30_000);

  // Clean up interval on server close
  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('New WebSocket connection');

    // Fix #3: Mark connection as alive on connect and on pong
    const aliveWs = ws as AliveWebSocket;
    aliveWs.isAlive = true;

    ws.on('pong', () => {
      (ws as AliveWebSocket).isAlive = true;
    });

    // Fix #1: Add error handler so unhandled socket errors don't crash the server
    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });

    ws.on('message', (data: Buffer) => {
      // Fix #2: Wrap entire message handling in try/catch
      try {
        const parsed = JSON.parse(data.toString());

        // Fix #10: Validate message structure before handling
        if (!validateMessage(parsed)) {
          sendError(ws, 'Invalid or unknown message type', 'INVALID_MESSAGE');
          return;
        }

        handleMessage(ws, parsed);
      } catch (err) {
        sendError(ws, 'Invalid message format', 'PARSE_ERROR');
      }
    });

    ws.on('close', () => {
      handleDisconnect(ws);
    });
  });
}

function handleMessage(ws: WebSocket, message: SignalMessage) {
  switch (message.type) {
    case 'join-room':
      handleJoinRoom(ws, message.payload);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      relayToParticipant(ws, message);
      break;
    case 'media-state-changed':
      handleMediaStateChange(ws, message.payload);
      break;
    case 'chat-message':
      handleChatMessage(ws, message.payload);
      break;
    case 'stage-action':
      handleStageAction(ws, message.payload);
      break;
    default:
      sendError(ws, 'Unknown message type', 'UNKNOWN_TYPE');
  }
}

function handleJoinRoom(ws: WebSocket, payload: JoinRoomPayload) {
  const { roomId, name, role } = payload;
  const roomState = rooms.get(roomId);

  if (!roomState) {
    sendError(ws, 'Room not found', 'ROOM_NOT_FOUND');
    return;
  }

  if (roomState.participants.size >= roomState.room.settings.maxParticipants) {
    sendError(ws, 'Room is full (max 12 participants)', 'ROOM_FULL');
    return;
  }

  // Fix #6: Determine the effective role — prevent host takeover
  let effectiveRole = role;
  if (role === 'host') {
    const existingHostId = roomState.room.hostId;
    const hostStillConnected =
      existingHostId !== '' && roomState.participants.has(existingHostId);
    if (hostStillConnected) {
      // Room already has an active host — force this joiner to guest
      effectiveRole = 'guest';
    }
  }

  const participant: Participant = {
    id: nanoid(8),
    name,
    role: effectiveRole,
    audioEnabled: true,
    videoEnabled: true,
    screenSharing: false,
    joinedAt: new Date().toISOString(),
    status: 'green-room',
  };

  // Host and co-hosts go directly on-stage
  if (effectiveRole === 'host') {
    roomState.room.hostId = participant.id;
    participant.status = 'on-stage';
  } else if (effectiveRole === 'co-host') {
    roomState.room.coHostIds.push(participant.id);
    participant.status = 'on-stage';
  } else {
    // Guests: if green room is enabled, they wait; otherwise auto-admit
    if (roomState.room.settings.greenRoomEnabled) {
      participant.status = 'green-room';
    } else {
      participant.status = 'on-stage';
    }
  }

  // Store participant
  roomState.participants.set(participant.id, { participant, ws });
  wsToParticipant.set(ws, { roomId, participantId: participant.id });

  // Send room-joined to the new participant (include ALL participants for awareness)
  const allParticipants = Array.from(roomState.participants.values())
    .map((p) => p.participant)
    .filter((p) => p.id !== participant.id);

  send(ws, {
    type: 'room-joined',
    payload: {
      room: roomState.room,
      participant,
      participants: allParticipants,
    },
  });

  // Notify existing participants about the new one
  broadcastToRoom(roomId, {
    type: 'participant-joined',
    payload: participant,
  }, participant.id);

  console.log(`${name} (${effectiveRole}) joined room ${roomId} as ${participant.status} [${roomState.participants.size}/12 participants]`);
}

function handleStageAction(ws: WebSocket, payload: StageActionPayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  // Only host and co-hosts can perform stage actions
  const performer = roomState.participants.get(mapping.participantId);
  if (!performer) return;
  if (performer.participant.role !== 'host' && performer.participant.role !== 'co-host') {
    sendError(ws, 'Only hosts and co-hosts can manage the stage', 'UNAUTHORIZED');
    return;
  }

  const target = roomState.participants.get(payload.targetParticipantId);
  if (!target) return;

  // Fix #7: Prevent demoting or removing the host
  if (target.participant.id === roomState.room.hostId) {
    if (
      payload.action === 'demote-to-guest' ||
      payload.action === 'remove' ||
      payload.action === 'move-to-backstage' ||
      payload.action === 'move-to-green-room'
    ) {
      sendError(ws, 'Cannot demote or remove the host', 'HOST_PROTECTED');
      return;
    }
  }

  switch (payload.action) {
    case 'move-to-stage':
      target.participant.status = 'on-stage';
      break;
    case 'move-to-backstage':
      target.participant.status = 'backstage';
      break;
    case 'move-to-green-room':
      target.participant.status = 'green-room';
      break;
    case 'promote-co-host':
      target.participant.role = 'co-host';
      if (!roomState.room.coHostIds.includes(target.participant.id)) {
        roomState.room.coHostIds.push(target.participant.id);
      }
      break;
    case 'demote-to-guest':
      target.participant.role = 'guest';
      roomState.room.coHostIds = roomState.room.coHostIds.filter(
        (id) => id !== target.participant.id
      );
      break;
    case 'mute':
      target.participant.audioEnabled = false;
      break;
    case 'remove':
      // Close the target's WebSocket to trigger disconnect
      target.ws.close();
      return;
  }

  // Broadcast the updated participant to everyone
  broadcastToRoom(mapping.roomId, {
    type: 'participant-updated',
    payload: target.participant,
  });

  // Also broadcast the stage action for UI feedback
  broadcastToRoom(mapping.roomId, {
    type: 'stage-action',
    payload,
  });

  console.log(`Stage action: ${payload.action} on ${target.participant.name} by ${performer.participant.name}`);
}

function relayToParticipant(ws: WebSocket, message: SignalMessage) {
  if (message.type !== 'offer' && message.type !== 'answer' && message.type !== 'ice-candidate') return;

  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const target = roomState.participants.get(message.payload.to);
  if (target && target.ws.readyState === WebSocket.OPEN) {
    send(target.ws, message);
  }
}

function handleMediaStateChange(ws: WebSocket, payload: MediaStatePayload) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  const entry = roomState.participants.get(mapping.participantId);
  if (entry) {
    entry.participant.audioEnabled = payload.audioEnabled;
    entry.participant.videoEnabled = payload.videoEnabled;
    entry.participant.screenSharing = payload.screenSharing;
  }

  broadcastToRoom(mapping.roomId, {
    type: 'media-state-changed',
    payload,
  }, mapping.participantId);
}

function handleChatMessage(ws: WebSocket, payload: ChatMessage) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const roomState = rooms.get(mapping.roomId);
  if (!roomState) return;

  // Fix #8: Override senderId and senderName with server-authoritative values
  const senderEntry = roomState.participants.get(mapping.participantId);
  if (!senderEntry) return;

  const sanitizedPayload: ChatMessage = {
    ...payload,
    senderId: mapping.participantId,
    senderName: senderEntry.participant.name,
  };

  // If backstage message, only send to host/co-hosts and the sender
  if (sanitizedPayload.isBackstage) {
    for (const [id, { participant, ws: targetWs }] of roomState.participants) {
      if (
        targetWs.readyState === WebSocket.OPEN &&
        (participant.role === 'host' || participant.role === 'co-host' || id === mapping.participantId)
      ) {
        send(targetWs, { type: 'chat-message', payload: sanitizedPayload });
      }
    }
  } else {
    broadcastToRoom(mapping.roomId, {
      type: 'chat-message',
      payload: sanitizedPayload,
    });
  }
}

function handleDisconnect(ws: WebSocket) {
  const mapping = wsToParticipant.get(ws);
  if (!mapping) return;

  const { roomId, participantId } = mapping;
  const roomState = rooms.get(roomId);

  if (roomState) {
    const entry = roomState.participants.get(participantId);
    const name = entry?.participant.name || 'Unknown';

    roomState.participants.delete(participantId);
    wsToParticipant.delete(ws);

    // Remove from co-host list if applicable
    roomState.room.coHostIds = roomState.room.coHostIds.filter((id) => id !== participantId);

    broadcastToRoom(roomId, {
      type: 'participant-left',
      payload: { participantId },
    });

    console.log(`${name} left room ${roomId} [${roomState.participants.size} participants]`);

    if (roomState.participants.size === 0) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} deleted (empty)`);
    }
  }
}

function broadcastToRoom(roomId: string, message: SignalMessage, excludeId?: string) {
  const roomState = rooms.get(roomId);
  if (!roomState) return;

  for (const [id, { ws }] of roomState.participants) {
    if (id !== excludeId && ws.readyState === WebSocket.OPEN) {
      // Fix #5: Wrap send in try/catch so one bad socket doesn't break the loop
      try {
        send(ws, message);
      } catch (err) {
        console.error(`Failed to send to participant ${id}:`, (err as Error).message);
      }
    }
  }
}

function send(ws: WebSocket, message: SignalMessage) {
  ws.send(JSON.stringify(message));
}

function sendError(ws: WebSocket, message: string, code: string) {
  // Wrap in try/catch to avoid crashing if the socket is already closed
  try {
    send(ws, { type: 'error', payload: { message, code } });
  } catch {
    // Socket is dead, nothing to do
  }
}
