import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Participant, RecordingTransferSignalOptions, RecordingTransferSignalPayload, SignalMessage } from '@studio/shared';
import { DEFAULT_ICE_CONFIG, fetchIceConfig } from '../utils/iceConfig.ts';
import {
  createTransferReceiver,
  createTransferSender,
  HostTransferRegistry,
  type ParticipantTransferSummary,
  type ReceivedTrackEntry,
  type ReceivedTrackSink,
  type TransferChannel,
  type TransferReceiver,
  type TransferSender,
  type TransferSenderProgress,
  type TransferSourceTrack,
} from '../utils/recordingTransferSession.ts';
import { RECORDING_TRANSFER_CHANNEL_LABEL } from '../utils/recordingTransferProtocol.ts';
import { listTransferableRecordings, markRecoveredRecordingDelivered } from '../utils/recordingRecovery.ts';
import { getTrackFileName } from '../utils/recordingTrackStore.ts';
import type { TakeFolder } from '../utils/recordingTakeFolder.ts';

/**
 * Peer-to-peer delivery of guests' local recordings into the host's
 * recording folder (Riverside-style, without any server storage).
 *
 * - The host invites each participant; the participant opens a dedicated
 *   RTCPeerConnection (using the app's STUN/TURN servers) with one ordered
 *   data channel and streams its committed recording bytes while recording.
 * - Signaling uses the 'recording-transfer-signal' relay, which the server
 *   only forwards between a participant and the room's operators.
 * - Offers and answers carry every ICE candidate (non-trickle), so a
 *   connection costs two signaling messages.
 */

export interface RecordingTransferInvite {
  hostId: string;
  transferId: string;
  sessionId?: string;
  options: RecordingTransferSignalOptions;
}

export interface GuestTransferStatus {
  state: 'idle' | 'connecting' | 'sending' | 'delivered' | 'waiting';
  pendingTracks: number;
  percent: number;
}

interface UseRecordingTransferOptions {
  send: (message: SignalMessage) => void;
  addHandler: (handler: (message: SignalMessage) => void) => () => void;
  roomId: string | null | undefined;
  me: Participant | null | undefined;
  isOperator: boolean;
  participants: Map<string, Participant>;
  /** Host: a recording folder is connected, so guests should send to us. */
  hostReceiving: boolean;
  hostOptions: RecordingTransferSignalOptions;
  /** Host: the take folder a received track belongs to. */
  getTakeFolder: (sessionId: string) => Promise<TakeFolder>;
  onTrackReceived?: (entry: ReceivedTrackEntry) => void;
  /** Guest: live tracks of this page's recorder. */
  getLocalTracks: () => TransferSourceTrack[];
  localTracksVersion: number;
  onLocalTrackDelivered: (trackId: string) => void;
  onInvite?: (invite: RecordingTransferInvite) => void;
  onInviteCleared?: () => void;
}

const ICE_GATHER_TIMEOUT_MS = 4_000;
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

// TURN credentials are short-lived: refetch for connections made later in a long show.
const ICE_CONFIG_TTL_MS = 10 * 60_000;
let iceConfigCache: { promise: Promise<RTCConfiguration>; at: number } | null = null;
function getIceConfiguration(): Promise<RTCConfiguration> {
  if (!iceConfigCache || Date.now() - iceConfigCache.at > ICE_CONFIG_TTL_MS) {
    iceConfigCache = { promise: fetchIceConfig().catch(() => DEFAULT_ICE_CONFIG), at: Date.now() };
  }
  return iceConfigCache.promise;
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

const newTransferId = () => `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function useRecordingTransfer(options: UseRecordingTransferOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { send, addHandler, isOperator, hostReceiving, participants, roomId, me } = options;

  // ---------------- Host ----------------
  const [summaries, setSummaries] = useState<ParticipantTransferSummary[]>([]);
  const hostPeersRef = useRef(new Map<string, { pc: RTCPeerConnection; transferId: string; receiver?: TransferReceiver }>());
  const invitedRef = useRef(new Map<string, string>());
  const registry = useMemo(() => new HostTransferRegistry(async ({ participantName, track }): Promise<ReceivedTrackSink> => {
    const take = await optionsRef.current.getTakeFolder(track.sessionId);
    const writer = await take.createTrackWriter(participantName, getTrackFileName(track.label, track.mimeType));
    return {
      write: (bytes) => writer.append(new Blob([bytes as Uint8Array<ArrayBuffer>])),
      accepted: () => writer.acceptedBytes(),
      async finish({ header, totalBytes }) {
        const file = await writer.finish({
          mimeType: track.mimeType,
          ...(header ? { header: new Blob([header as Uint8Array<ArrayBuffer>]) } : {}),
        });
        if (file.size < totalBytes) throw new Error(`Only ${file.size} of ${totalBytes} bytes were saved.`);
        return { bytes: file.size, path: writer.path, file };
      },
    };
  }, (entry) => optionsRef.current.onTrackReceived?.(entry)), []);

  useEffect(() => registry.subscribe(() => setSummaries(registry.summaries())), [registry]);

  const closeHostPeer = useCallback((participantId: string) => {
    const peer = hostPeersRef.current.get(participantId);
    if (!peer) return;
    hostPeersRef.current.delete(participantId);
    peer.receiver?.close();
    try { peer.pc.close(); } catch { /* Already closed. */ }
  }, []);

  const sendInvite = useCallback((participantId: string, sessionId?: string) => {
    const transferId = newTransferId();
    invitedRef.current.set(participantId, sessionId || '');
    send({
      type: 'recording-transfer-signal',
      payload: {
        targetParticipantId: participantId,
        transferId,
        kind: 'invite',
        ...(sessionId ? { sessionId } : {}),
        options: optionsRef.current.hostOptions,
      },
    });
  }, [send]);

  /** Invite every participant (call before announcing a new take). */
  const inviteAll = useCallback((sessionId?: string) => {
    if (!optionsRef.current.isOperator || !optionsRef.current.hostReceiving) return;
    for (const participant of optionsRef.current.participants.values()) {
      if (participant.role === 'host' || participant.role === 'co-host') continue;
      sendInvite(participant.id, sessionId);
    }
  }, [sendInvite]);

  // Invite participants who join while the folder is connected (and on connect).
  useEffect(() => {
    if (!isOperator || !hostReceiving) return;
    for (const participant of participants.values()) {
      if (participant.role === 'host' || participant.role === 'co-host') continue;
      if (!invitedRef.current.has(participant.id)) sendInvite(participant.id);
    }
    for (const id of [...invitedRef.current.keys()]) {
      if (!participants.has(id)) { invitedRef.current.delete(id); closeHostPeer(id); }
    }
  }, [closeHostPeer, hostReceiving, isOperator, participants, sendInvite]);

  // Disconnecting the folder tells guests to stop sending.
  useEffect(() => {
    if (!isOperator || hostReceiving) return;
    for (const id of invitedRef.current.keys()) {
      send({ type: 'recording-transfer-signal', payload: { targetParticipantId: id, transferId: newTransferId(), kind: 'hangup' } });
      closeHostPeer(id);
    }
    invitedRef.current.clear();
  }, [closeHostPeer, hostReceiving, isOperator, send]);

  const acceptOffer = useCallback(async (payload: RecordingTransferSignalPayload) => {
    const participantId = payload.fromParticipantId;
    if (!participantId || !payload.sdp) return;
    if (!optionsRef.current.hostReceiving) {
      send({ type: 'recording-transfer-signal', payload: { targetParticipantId: participantId, transferId: payload.transferId, kind: 'hangup' } });
      return;
    }
    closeHostPeer(participantId);
    const pc = new RTCPeerConnection(await getIceConfiguration());
    const peer: { pc: RTCPeerConnection; transferId: string; receiver?: TransferReceiver } = { pc, transferId: payload.transferId };
    hostPeersRef.current.set(participantId, peer);
    pc.addEventListener('datachannel', (event) => {
      if (event.channel.label !== RECORDING_TRANSFER_CHANNEL_LABEL) return;
      peer.receiver?.close();
      peer.receiver = createTransferReceiver({ channel: event.channel as unknown as TransferChannel, participantId, registry });
      event.channel.addEventListener('close', () => {
        peer.receiver?.close();
        peer.receiver = undefined;
      });
    });
    pc.addEventListener('connectionstatechange', () => {
      if ((pc.connectionState === 'failed' || pc.connectionState === 'closed') && hostPeersRef.current.get(participantId) === peer) {
        closeHostPeer(participantId);
      }
    });
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await waitForIceGathering(pc);
      if (hostPeersRef.current.get(participantId) !== peer || !pc.localDescription) return;
      send({
        type: 'recording-transfer-signal',
        payload: { targetParticipantId: participantId, transferId: payload.transferId, kind: 'answer', sdp: pc.localDescription.sdp },
      });
    } catch (error) {
      console.warn('Recording transfer could not connect:', error);
      closeHostPeer(participantId);
    }
  }, [closeHostPeer, registry, send]);

  // ---------------- Guest ----------------
  const [guestStatus, setGuestStatus] = useState<GuestTransferStatus>({ state: 'idle', pendingTracks: 0, percent: 0 });
  const inviteRef = useRef<RecordingTransferInvite | null>(null);
  const guestPeerRef = useRef<{ pc: RTCPeerConnection; channel: RTCDataChannel; sender: TransferSender; transferId: string } | null>(null);
  const recoveredRef = useRef<TransferSourceTrack[]>([]);
  const deliveredRef = useRef(new Set<string>());
  const reconnectRef = useRef<{ attempt: number; timer: ReturnType<typeof setTimeout> | null }>({ attempt: 0, timer: null });
  const progressRef = useRef<TransferSenderProgress | null>(null);
  const deliveryWaitersRef = useRef(new Set<() => void>());

  const pendingGuestTracks = useCallback(() => [
    ...optionsRef.current.getLocalTracks(),
    ...recoveredRef.current,
  ].filter((track) => !deliveredRef.current.has(track.id)), []);

  const updateGuestStatus = useCallback(() => {
    const pending = pendingGuestTracks();
    const progress = progressRef.current;
    const connected = guestPeerRef.current?.channel.readyState === 'open';
    const totals = (progress?.tracks || []).filter((track) => !track.delivered);
    const available = totals.reduce((sum, track) => sum + track.available, 0);
    const sent = totals.reduce((sum, track) => sum + Math.min(track.acked, track.available), 0);
    const percent = available > 0 ? Math.floor((sent / available) * 100) : pending.length ? 0 : 100;
    setGuestStatus({
      state: !inviteRef.current ? 'idle' : pending.length === 0 ? 'delivered' : connected ? 'sending' : guestPeerRef.current ? 'connecting' : 'waiting',
      pendingTracks: pending.length,
      percent,
    });
    if (pending.length === 0) {
      for (const resolve of deliveryWaitersRef.current) resolve();
      deliveryWaitersRef.current.clear();
    }
  }, [pendingGuestTracks]);

  const closeGuestPeer = useCallback(() => {
    const peer = guestPeerRef.current;
    guestPeerRef.current = null;
    if (!peer) return;
    peer.sender.close();
    try { peer.channel.close(); } catch { /* Already closed. */ }
    try { peer.pc.close(); } catch { /* Already closed. */ }
  }, []);

  const connectToHost = useCallback(async () => {
    const invite = inviteRef.current;
    const self = optionsRef.current.me;
    if (!invite || !self || guestPeerRef.current || optionsRef.current.isOperator) return;
    if (pendingGuestTracks().length === 0) { updateGuestStatus(); return; }
    const transferId = newTransferId();
    const pc = new RTCPeerConnection(await getIceConfiguration());
    if (inviteRef.current !== invite || guestPeerRef.current) { pc.close(); return; }
    const channel = pc.createDataChannel(RECORDING_TRANSFER_CHANNEL_LABEL, { ordered: true });
    const sender = createTransferSender({
      channel: channel as unknown as TransferChannel,
      participantName: self.name,
      getTracks: pendingGuestTracks,
      onDelivered: (trackId) => {
        deliveredRef.current.add(trackId);
        const recovered = recoveredRef.current.find((track) => track.id === trackId);
        if (recovered) {
          recoveredRef.current = recoveredRef.current.filter((track) => track.id !== trackId);
          void markRecoveredRecordingDelivered(trackId).catch(() => {});
        } else {
          optionsRef.current.onLocalTrackDelivered(trackId);
        }
        updateGuestStatus();
      },
      onProgress: (progress) => { progressRef.current = progress; updateGuestStatus(); },
    });
    const peer = { pc, channel, sender, transferId };
    guestPeerRef.current = peer;
    updateGuestStatus();
    const scheduleReconnect = () => {
      if (guestPeerRef.current !== peer) return;
      closeGuestPeer();
      updateGuestStatus();
      if (!inviteRef.current || pendingGuestTracks().length === 0) return;
      const state = reconnectRef.current;
      const delay = RECONNECT_DELAYS_MS[Math.min(state.attempt, RECONNECT_DELAYS_MS.length - 1)];
      state.attempt += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => { state.timer = null; void connectToHost(); }, delay);
    };
    channel.addEventListener('open', () => { reconnectRef.current.attempt = 0; updateGuestStatus(); });
    channel.addEventListener('close', scheduleReconnect);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') scheduleReconnect();
    });
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIceGathering(pc);
      if (guestPeerRef.current !== peer || !pc.localDescription) return;
      send({
        type: 'recording-transfer-signal',
        payload: { targetParticipantId: invite.hostId, transferId, kind: 'offer', sdp: pc.localDescription.sdp },
      });
      // No answer (host gone or folder disconnected): try again later.
      setTimeout(() => { if (guestPeerRef.current === peer && pc.signalingState !== 'stable') scheduleReconnect(); }, 20_000);
    } catch (error) {
      console.warn('Recording transfer offer failed:', error);
      scheduleReconnect();
    }
  }, [closeGuestPeer, pendingGuestTracks, send, updateGuestStatus]);

  const handleInvite = useCallback(async (payload: RecordingTransferSignalPayload) => {
    if (!payload.fromParticipantId) return;
    const invite: RecordingTransferInvite = {
      hostId: payload.fromParticipantId,
      transferId: payload.transferId,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      options: payload.options || {},
    };
    const previous = inviteRef.current;
    inviteRef.current = invite;
    try { optionsRef.current.onInvite?.(invite); } catch { /* Keep connecting. */ }
    // Tracks left over from a crashed or reloaded tab in this room.
    const currentRoom = optionsRef.current.roomId;
    if (currentRoom) {
      const live = new Set(optionsRef.current.getLocalTracks().map((track) => track.id));
      const recovered = await listTransferableRecordings({ roomId: currentRoom, excludeIds: live }).catch(() => []);
      recoveredRef.current = recovered.filter((entry) => !deliveredRef.current.has(entry.id)).map((entry) => ({
        id: entry.id,
        sessionId: entry.metadata.transfer?.sessionId || 'recovered',
        label: entry.metadata.label,
        kind: entry.metadata.kind,
        mimeType: entry.metadata.mimeType,
        read: async () => entry.blob,
        // A crashed recorder never finished: what is on disk is the whole file.
        finished: { totalBytes: entry.blob.size, ...(entry.metadata.transfer?.capture ? { capture: entry.metadata.transfer.capture } : {}) },
      }));
    }
    if (previous && previous.hostId !== invite.hostId) closeGuestPeer();
    if (guestPeerRef.current) guestPeerRef.current.sender.refresh();
    else void connectToHost();
  }, [closeGuestPeer, connectToHost]);

  useEffect(() => addHandler((message) => {
    if (message.type !== 'recording-transfer-signal') return;
    const payload = message.payload;
    const self = optionsRef.current.me;
    if (!self || payload.targetParticipantId !== self.id) return;
    switch (payload.kind) {
      case 'invite':
        if (!optionsRef.current.isOperator) void handleInvite(payload);
        return;
      case 'offer':
        if (optionsRef.current.isOperator) void acceptOffer(payload);
        return;
      case 'answer': {
        const peer = guestPeerRef.current;
        if (!peer || peer.transferId !== payload.transferId || !payload.sdp) return;
        void peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp }).catch((error) => {
          console.warn('Recording transfer answer rejected:', error);
        });
        return;
      }
      case 'hangup':
        if (optionsRef.current.isOperator) {
          if (payload.fromParticipantId) closeHostPeer(payload.fromParticipantId);
          return;
        }
        if (inviteRef.current && inviteRef.current.hostId === payload.fromParticipantId) {
          inviteRef.current = null;
          closeGuestPeer();
          try { optionsRef.current.onInviteCleared?.(); } catch { /* Ignore. */ }
          updateGuestStatus();
        }
        return;
    }
  }), [acceptOffer, addHandler, closeGuestPeer, closeHostPeer, handleInvite, updateGuestStatus]);

  // New tracks or a finished take: send them (connecting first if needed).
  useEffect(() => {
    if (isOperator || !inviteRef.current) return;
    if (guestPeerRef.current) guestPeerRef.current.sender.refresh();
    else if (!reconnectRef.current.timer) void connectToHost();
    updateGuestStatus();
  }, [connectToHost, isOperator, options.localTracksVersion, updateGuestStatus]);

  // Leaving the room ends every transfer connection.
  useEffect(() => () => {
    closeGuestPeer();
    for (const id of [...hostPeersRef.current.keys()]) closeHostPeer(id);
    if (reconnectRef.current.timer) clearTimeout(reconnectRef.current.timer);
    for (const resolve of deliveryWaitersRef.current) resolve();
  }, [closeGuestPeer, closeHostPeer]);

  /** Guest: resolves true once every track reached the host, false on timeout. */
  const waitForDelivery = useCallback((timeoutMs: number): Promise<boolean> => {
    if (pendingGuestTracks().length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); deliveryWaitersRef.current.delete(done); resolve(pendingGuestTracks().length === 0); };
      const timer = setTimeout(done, timeoutMs);
      deliveryWaitersRef.current.add(done);
    });
  }, [pendingGuestTracks]);

  /** Host: resolves once every announced track is saved or failed. */
  const waitForHostSettled = useCallback((timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    if (registry.isSettled()) { resolve(true); return; }
    const timer = setTimeout(() => { unsubscribe(); resolve(registry.isSettled()); }, timeoutMs);
    const unsubscribe = registry.subscribe(() => {
      if (!registry.isSettled()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  }), [registry]);

  return {
    /** Host: per-participant progress of incoming tracks. */
    summaries,
    registry,
    inviteAll,
    waitForHostSettled,
    /** Guest: whether the host asked for tracks, and how sending is going. */
    guestStatus,
    getInvite: () => inviteRef.current,
    waitForDelivery,
  };
}
