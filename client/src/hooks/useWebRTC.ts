import { PeerNegotiation } from '../utils/peerNegotiation.ts';
import { useRef, useCallback, useState, useEffect } from 'react';
import type { SignalMessage, PeerConnectionRef } from '@studio/shared';
import { DEFAULT_ICE_CONFIG, hasTurnServers } from '../utils/iceConfig.ts';
import { getSharedIceConfigLoader } from '../utils/iceConfigLoader.ts';
import {
  applyBandwidthModeToVideoSender,
  buildPeerBandwidthHealth,
  createInitialBandwidthAdaptationState,
  getMeshScreenSendCap,
  getMeshVideoSendCap,
  readOutboundVideoStatsSnapshot,
  updateBandwidthAdaptationState,
  type BandwidthAdaptationMode,
  type BandwidthAdaptationState,
  type PeerBandwidthHealth,
  type ScreenShareOptimization,
} from '../utils/webrtcBandwidthAdaptation.ts';
import {
  assessInboundHealth,
  readInboundStatsSnapshot,
  type InboundHealthSample,
  type InboundStatsSnapshot,
} from '../utils/webrtcInboundHealth.ts';
import {
  addTrackWithOptionalSimulcast,
  refreshSenderVideoEncodingParameters,
} from '../utils/webrtcSimulcast.ts';
import { sendScreenOnConnection, stopScreenOnConnection } from '../utils/screenTransceiver.ts';
import { replacePeerMediaTrack } from '../utils/peerMediaSender.ts';
import {
  decideIncomingAnswer,
  decideIncomingCandidate,
  decideIncomingOffer,
  type LocalConnectionView,
} from '../utils/peerConnectionIdentity.ts';

function viewOf(peer: PeerState): LocalConnectionView {
  return {
    pcId: peer.pcId,
    remotePcId: peer.remotePcId,
    hasLocalDescription: Boolean(peer.connection.localDescription),
    hasRemoteDescription: Boolean(peer.connection.remoteDescription),
  };
}

interface PeerState {
  participantId: string;
  connection: RTCPeerConnection;
  stream: MediaStream | null;
  senders: Map<'audio' | 'video', RTCRtpSender>;
  negotiation: PeerNegotiation;
  /** The peer's screen (video, and its tab/system audio when shared), sent beside its camera. */
  screenStream: MediaStream | null;
  /** The transceiver that sends our screen to this peer (inactive between shares). */
  screenTransceiver: RTCRtpTransceiver | null;
  /** The transceiver that sends our screen's audio (tab or system sound) to this peer. */
  screenAudioTransceiver: RTCRtpTransceiver | null;
  /** Our RTCPeerConnection's id, sent with every offer, answer and candidate. */
  pcId: string;
  /** The other side's connection id, once known. */
  remotePcId: string | null;
  everConnected: boolean;
}

interface PendingCandidate {
  candidate: RTCIceCandidateInit;
  pcId?: string;
}

interface UseWebRTCProps {
  localStream: MediaStream | null;
  myParticipantId: string | null;
  send: (message: SignalMessage) => void;
}

/** Same as the signaling server's PC_ID_PATTERN. */
function createPeerConnectionId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `pc-${random.slice(0, 24)}`;
}

/**
 * One transport for audio, video and screen (max-bundle): a single set of ICE
 * candidates per peer instead of one per media section, so joining a full
 * studio sends a fraction of the signaling messages.
 */
function buildRtcConfiguration(base: RTCConfiguration): RTCConfiguration {
  return { ...base, bundlePolicy: 'max-bundle' };
}

function liveAudioTracks(stream: MediaStream | null): MediaStreamTrack[] {
  return stream ? stream.getAudioTracks().filter((track) => track.readyState === 'live') : [];
}

export function useWebRTC({ localStream, myParticipantId, send }: UseWebRTCProps) {
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const iceConfigRef = useRef<RTCConfiguration>(getSharedIceConfigLoader().latest.config || DEFAULT_ICE_CONFIG);
  const iceReadyRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const removedPeersRef = useRef(new Map<string, number>());
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Map<string, MediaStream>>(new Map());
  // The audio of each peer's screen share (a shared tab's or the system's sound), by participant.
  const [remoteScreenAudioTracks, setRemoteScreenAudioTracks] = useState<Map<string, MediaStreamTrack[]>>(new Map());
  // Screen stream ids announced by peers (media-state-changed), so an incoming
  // track can be told apart from the camera even before the camera arrives.
  const remoteScreenStreamIdsRef = useRef<Map<string, string>>(new Map());
  const publishedScreenRef = useRef<{ track: MediaStreamTrack; stream: MediaStream; audioTrack: MediaStreamTrack | null } | null>(null);
  const screenOptimizationRef = useRef<ScreenShareOptimization>('text');
  const rebuildCountsRef = useRef<Map<string, number>>(new Map());
  // Peers whose media link dropped after connecting and is recovering.
  const [reconnectingPeerIds, setReconnectingPeerIds] = useState<Set<string>>(new Set());
  const reconnectingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const setPeerReconnecting = useCallback((participantId: string, reconnecting: boolean) => {
    const timer = reconnectingTimersRef.current.get(participantId);
    if (timer) {
      clearTimeout(timer);
      reconnectingTimersRef.current.delete(participantId);
    }
    const update = (value: boolean) => setReconnectingPeerIds((current) => {
      if (current.has(participantId) === value) return current;
      const next = new Set(current);
      if (value) next.add(participantId); else next.delete(participantId);
      return next;
    });
    if (!reconnecting) {
      update(false);
      return;
    }
    // Brief "disconnected" blips recover on their own; show only a real drop.
    reconnectingTimersRef.current.set(participantId, setTimeout(() => {
      reconnectingTimersRef.current.delete(participantId);
      update(true);
    }, 1_000));
  }, []);
  const [peerBandwidthHealth, setPeerBandwidthHealth] = useState<Map<string, PeerBandwidthHealth>>(new Map());

  // Use refs to avoid stale closures in setTimeout callbacks
  const myParticipantIdRef = useRef<string | null>(myParticipantId);
  useEffect(() => { myParticipantIdRef.current = myParticipantId; }, [myParticipantId]);

  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; }, [send]);

  const localStreamRef = useRef(localStream);
  const publishedTracksRef = useRef<Map<'audio' | 'video', MediaStreamTrack>>(new Map());
  // Mesh forwarding: paused while the SFU carries our media to the stage,
  // except to peers the SFU does not reach (backstage), which stay on the mesh.
  const forwardingEnabledRef = useRef<Record<'audio' | 'video', boolean>>({ audio: true, video: true });
  const forwardingExemptRef = useRef<(participantId: string) => boolean>(() => false);
  const shouldForward = useCallback((kind: 'audio' | 'video', participantId: string) => (
    forwardingEnabledRef.current[kind] || forwardingExemptRef.current(participantId)
  ), []);
  useEffect(() => {
    localStreamRef.current = localStream;
    for (const track of localStream?.getTracks() || []) {
      if ((track.kind === 'audio' || track.kind === 'video') && !publishedTracksRef.current.has(track.kind)) {
        publishedTracksRef.current.set(track.kind, track);
      }
    }
  }, [localStream]);

  // Buffer ICE candidates that arrive before their peer connection is ready.
  // Capped per peer so a misbehaving / never-materializing peer cannot accumulate memory.
  const pendingCandidatesRef = useRef<Map<string, PendingCandidate[]>>(new Map());
  const MAX_PENDING_CANDIDATES_PER_PEER = 50;

  const bandwidthStatesRef = useRef<Map<string, BandwidthAdaptationState>>(new Map());
  const inboundStatesRef = useRef<Map<string, { snapshot: InboundStatsSnapshot; sample: InboundHealthSample }>>(new Map());
  const bandwidthAdaptationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const BANDWIDTH_ADAPTATION_INTERVAL_MS = 5_000;

  const updateRemoteStreams = useCallback(() => {
    const streams = new Map<string, MediaStream>();
    const screens = new Map<string, MediaStream>();
    const screenAudio = new Map<string, MediaStreamTrack[]>();
    for (const [id, peer] of peersRef.current) {
      if (peer.stream) {
        streams.set(id, peer.stream);
      }
      if (peer.screenStream) {
        screens.set(id, peer.screenStream);
        const audio = liveAudioTracks(peer.screenStream);
        if (audio.length > 0) screenAudio.set(id, audio);
      }
    }
    setRemoteStreams(new Map(streams));
    setRemoteScreenStreams(screens);
    setRemoteScreenAudioTracks(screenAudio);
  }, []);

  const publishPeerBandwidthHealth = useCallback(() => {
    const updatedAtMs = Date.now();
    const next = new Map<string, PeerBandwidthHealth>();
    const ids = new Set([...bandwidthStatesRef.current.keys(), ...inboundStatesRef.current.keys()]);
    for (const participantId of ids) {
      const state = bandwidthStatesRef.current.get(participantId) || createInitialBandwidthAdaptationState();
      next.set(participantId, buildPeerBandwidthHealth(state, updatedAtMs, inboundStatesRef.current.get(participantId)?.sample ?? null));
    }
    setPeerBandwidthHealth(next);
  }, []);

  const removePeerBandwidthState = useCallback((participantId: string) => {
    bandwidthStatesRef.current.delete(participantId);
    inboundStatesRef.current.delete(participantId);
    setPeerBandwidthHealth((current) => {
      if (!current.has(participantId)) return current;
      const next = new Map(current);
      next.delete(participantId);
      return next;
    });
  }, []);

  const clearPeerBandwidthStates = useCallback(() => {
    bandwidthStatesRef.current.clear();
    inboundStatesRef.current.clear();
    setPeerBandwidthHealth(new Map());
  }, []);

  /** The camera's per-peer ceiling for the current number of mesh peers. */
  const getVideoCap = useCallback(() => getMeshVideoSendCap(peersRef.current.size), []);

  const applyScreenSendLimits = useCallback(async (peer: PeerState) => {
    const sender = peer.screenTransceiver?.sender;
    if (!sender?.track || typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') return;
    const parameters = sender.getParameters();
    if (!parameters.encodings || parameters.encodings.length === 0) return;
    const cap = getMeshScreenSendCap(peersRef.current.size, screenOptimizationRef.current);
    parameters.encodings = parameters.encodings.map((encoding) => ({ ...encoding, maxBitrate: cap.maxBitrate, maxFramerate: cap.maxFramerate }));
    // Text keeps its resolution and drops frames; motion keeps the frames.
    parameters.degradationPreference = screenOptimizationRef.current === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    try {
      await sender.setParameters(parameters);
    } catch (err) {
      console.warn(`Failed to cap screen sharing for peer ${peer.participantId}:`, err);
    }
  }, []);

  const applyPeerBandwidthMode = useCallback(async (peer: PeerState, mode: BandwidthAdaptationMode) => {
    const screenSender = peer.screenTransceiver?.sender;
    const cap = getVideoCap();
    const videoSenders = peer.connection.getSenders().filter((sender) => sender.track?.kind === 'video' && sender !== screenSender);
    await Promise.all(videoSenders.map(async (sender) => {
      try {
        await applyBandwidthModeToVideoSender(sender, mode, cap);
      } catch (err) {
        console.warn(`Failed to apply ${mode} video bandwidth mode for peer ${peer.participantId}:`, err);
      }
    }));
  }, [getVideoCap]);

  /** Re-apply every peer's send ceilings, e.g. after a guest joins or leaves the mesh. */
  const applyMeshSendLimits = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      const mode = bandwidthStatesRef.current.get(peer.participantId)?.mode || 'full';
      void applyPeerBandwidthMode(peer, mode);
      void applyScreenSendLimits(peer);
    }
  }, [applyPeerBandwidthMode, applyScreenSendLimits]);

  const drainPendingCandidates = useCallback((peer: PeerState) => {
    const pending = pendingCandidatesRef.current.get(peer.participantId) || [];
    if (pending.length === 0) return;
    const keep: PendingCandidate[] = [];
    for (const item of pending) {
      if (!item.pcId || !peer.remotePcId || item.pcId === peer.remotePcId) {
        void peer.negotiation.receiveCandidate(item.candidate).catch(() => {});
      } else {
        keep.push(item);
      }
    }
    if (keep.length > 0) pendingCandidatesRef.current.set(peer.participantId, keep);
    else pendingCandidatesRef.current.delete(peer.participantId);
  }, []);

  // Push an ICE candidate into the per-peer pending buffer, with a cap.
  const bufferCandidate = useCallback((peerId: string, candidate: RTCIceCandidateInit, pcId?: string) => {
    const existing = pendingCandidatesRef.current.get(peerId) || [];
    if (existing.length >= MAX_PENDING_CANDIDATES_PER_PEER) {
      // Drop the oldest to bound memory; a flood of candidates from a single peer
      // should not be allowed to grow unbounded.
      existing.shift();
    }
    existing.push({ candidate, pcId });
    pendingCandidatesRef.current.set(peerId, existing);
  }, []);

  const rebuildPeerRef = useRef<(participantId: string, stale: PeerState) => void>(() => {});

  const createPeerConnection = useCallback(
    (remoteParticipantId: string, options: { remotePcId?: string | null; wasConnected?: boolean } = {}): PeerState => {
      const existing = peersRef.current.get(remoteParticipantId);
      if (existing) {
        existing.negotiation.dispose();
        // Bug fix #3: Null out event handlers before closing existing connection
        existing.connection.ontrack = null;
        existing.connection.onicecandidate = null;
        existing.connection.onconnectionstatechange = null;
        existing.connection.close();
        removePeerBandwidthState(remoteParticipantId);
      }

      getSharedIceConfigLoader().refreshIfStale();
      const pc = new RTCPeerConnection(buildRtcConfiguration(iceConfigRef.current));
      const pcId = createPeerConnectionId();
      const connectionRef = (): PeerConnectionRef => {
        const current = peersRef.current.get(remoteParticipantId);
        const remotePcId = current?.connection === pc ? current.remotePcId : null;
        return { pcId, ...(remotePcId ? { toPcId: remotePcId } : {}) };
      };

      const peerState: PeerState = {
        participantId: remoteParticipantId,
        connection: pc,
        stream: null,
        senders: new Map(),
        screenStream: null,
        screenTransceiver: null,
        screenAudioTransceiver: null,
        pcId,
        remotePcId: options.remotePcId ?? null,
        everConnected: Boolean(options.wasConnected),
        negotiation: new PeerNegotiation(
          pc,
          (myParticipantIdRef.current || '') < remoteParticipantId,
          (sdp) => {
            const from = myParticipantIdRef.current;
            if (!from) return;
            sendRef.current({ type: sdp.type === 'offer' ? 'offer' : 'answer', payload: { from, to: remoteParticipantId, sdp, ...connectionRef() } });
          },
          () => peersRef.current.get(remoteParticipantId)?.connection === pc,
          5_000,
          10_000,
          1_500,
          {
            // ICE restarts did not bring it back: start over with a new connection.
            onRecoveryExhausted: () => rebuildPeerRef.current(remoteParticipantId, peerState),
          },
        ),
      };

      // Add local tracks to the connection (use ref for latest stream)
      const currentStream = localStreamRef.current;
      if (currentStream) {
        for (const track of currentStream.getTracks()) {
          const publishedTrack = (track.kind === 'audio' || track.kind === 'video')
            ? publishedTracksRef.current.get(track.kind) || track
            : track;
          const sender = addTrackWithOptionalSimulcast(pc, publishedTrack, currentStream);
          if (track.kind === 'audio' || track.kind === 'video') {
            peerState.senders.set(track.kind, sender);
            if (!publishedTracksRef.current.has(track.kind)) publishedTracksRef.current.set(track.kind, track);
            if (!shouldForward(track.kind, remoteParticipantId)) {
              void sender.replaceTrack(null).catch((err) => {
                console.warn(`Failed to pause mesh ${track.kind} for peer ${remoteParticipantId}:`, err);
              });
            }
          }
        }
      }

      // A screen we are already sharing goes to this new peer as well, with its sound.
      const publishedScreen = publishedScreenRef.current;
      if (publishedScreen) {
        peerState.screenTransceiver = pc.addTransceiver(publishedScreen.track, { direction: 'sendonly', streams: [publishedScreen.stream] });
        if (publishedScreen.audioTrack) {
          peerState.screenAudioTransceiver = pc.addTransceiver(publishedScreen.audioTrack, { direction: 'sendonly', streams: [publishedScreen.stream] });
        }
      }

      // Handle incoming remote tracks
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (peersRef.current.get(remoteParticipantId) !== peerState) return;
        // The screen (and its audio) arrives in its own MediaStream: the id the
        // peer announced, or a second stream beside the camera one.
        const announcedScreenId = remoteScreenStreamIdsRef.current.get(remoteParticipantId);
        const camera = peerState.stream;
        const isScreen = Boolean(remoteStream) && (
          remoteStream.id === announcedScreenId ||
          (peerState.screenStream !== null && peerState.screenStream.id === remoteStream.id) ||
          (camera !== null && camera.id !== remoteStream.id && (
            event.track.kind === 'video' ? camera.getVideoTracks().length > 0 : camera.getAudioTracks().length > 0
          ))
        );
        if (isScreen) {
          peerState.screenStream = remoteStream;
          if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
          event.track.addEventListener('ended', () => {
            if (peerState.screenStream !== remoteStream) return;
            if (event.track.kind === 'video') peerState.screenStream = null;
            updateRemoteStreams();
          });
          updateRemoteStreams();
          return;
        }
        peerState.stream = remoteStream || peerState.stream || new MediaStream();
        if (!peerState.stream.getTracks().includes(event.track)) peerState.stream.addTrack(event.track);
        updateRemoteStreams();
      };

      // Send ICE candidates to the remote peer (use refs to avoid stale closures)
      pc.onicecandidate = (event) => {
        const currentMyId = myParticipantIdRef.current;
        if (event.candidate && currentMyId) {
          sendRef.current({
            type: 'ice-candidate',
            payload: {
              from: currentMyId,
              to: remoteParticipantId,
              candidate: event.candidate.toJSON(),
              ...connectionRef(),
            },
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (peersRef.current.get(remoteParticipantId) !== peerState) return;
        peerState.negotiation.connectionStateChanged();
        if (pc.connectionState === 'connected') {
          peerState.everConnected = true;
          rebuildCountsRef.current.delete(remoteParticipantId);
          setPeerReconnecting(remoteParticipantId, false);
          // Encodings exist once negotiated: apply the mesh ceilings now.
          const mode = bandwidthStatesRef.current.get(remoteParticipantId)?.mode || 'full';
          void applyPeerBandwidthMode(peerState, mode);
          void applyScreenSendLimits(peerState);
        } else if (peerState.everConnected && (pc.connectionState === 'disconnected' || pc.connectionState === 'failed')) {
          setPeerReconnecting(remoteParticipantId, true);
        } else if (pc.connectionState === 'closed') {
          setPeerReconnecting(remoteParticipantId, false);
        }
        if (pc.connectionState === 'closed') {
          peerState.negotiation.dispose();
          peersRef.current.delete(remoteParticipantId);
          pendingCandidatesRef.current.delete(remoteParticipantId);
          removePeerBandwidthState(remoteParticipantId);
          updateRemoteStreams();
        }
      };

      peersRef.current.set(remoteParticipantId, peerState);
      drainPendingCandidates(peerState);
      if (peerState.everConnected) setPeerReconnecting(remoteParticipantId, true);
      // One more (or one fewer) copy of our camera on the uplink.
      applyMeshSendLimits();
      return peerState;
    },
    [applyMeshSendLimits, applyPeerBandwidthMode, applyScreenSendLimits, drainPendingCandidates, removePeerBandwidthState, setPeerReconnecting, shouldForward, updateRemoteStreams]
  );

  /** Replace a peer connection that ICE restarts could not revive; the other side follows (new pcId). */
  rebuildPeerRef.current = (participantId: string, stale: PeerState) => {
    if (peersRef.current.get(participantId) !== stale) return;
    const rebuilds = (rebuildCountsRef.current.get(participantId) || 0) + 1;
    rebuildCountsRef.current.set(participantId, rebuilds);
    console.info(`Rebuilding the connection to ${participantId} (attempt ${rebuilds})`);
    const fresh = createPeerConnection(participantId, { wasConnected: stale.everConnected });
    void fresh.negotiation.start().catch(() => {});
  };

  // Wait for configured TURN before negotiating, including when an offer arrives
  // immediately after joining. Ignore work belonging to a departed session.
  const preparePeer = useCallback(async (id: string) => {
    const generation = generationRef.current;
    const removal = removedPeersRef.current.get(id);
    const myId = myParticipantIdRef.current;
    await iceReadyRef.current;
    if (!myId || myParticipantIdRef.current !== myId || generation !== generationRef.current || removal !== removedPeersRef.current.get(id)) return;
    const existing = peersRef.current.get(id);
    if (!existing || existing.connection.signalingState === 'closed') createPeerConnection(id);
    return peersRef.current.get(id);
  }, [createPeerConnection]);

  const connectToPeer = useCallback(async (id: string) => {
    if (peersRef.current.has(id)) return;
    const peer = await preparePeer(id);
    if (peer) await peer.negotiation.start();
  }, [preparePeer]);

  const handleOffer = useCallback(async (from: string, sdp: RTCSessionDescriptionInit, ref: PeerConnectionRef = {}) => {
    let peer = await preparePeer(from);
    if (!peer) return;
    const decision = decideIncomingOffer(ref, viewOf(peer));
    if (decision.action === 'ignore') {
      // Meant for a connection of ours that was replaced (a reload, a rebuild).
      // Our current connection makes its own offer, which tells the other side
      // to rebuild; make sure it does.
      if (decision.kickStart) void peer.negotiation.start().catch(() => {});
      return;
    }
    if (decision.action === 'rebuild') {
      // The other side rebuilt its connection (it reloaded and kept its seat,
      // or gave up on ICE restarts). Start over on ours too.
      peer = createPeerConnection(from, { remotePcId: decision.remotePcId, wasConnected: peer.everConnected });
    } else {
      peer.remotePcId = decision.remotePcId;
    }
    await peer.negotiation.receiveOffer(sdp);
    drainPendingCandidates(peer);
  }, [createPeerConnection, drainPendingCandidates, preparePeer]);

  const handleAnswer = useCallback(async (from: string, sdp: RTCSessionDescriptionInit, ref: PeerConnectionRef = {}) => {
    const peer = peersRef.current.get(from);
    if (!peer) return;
    const decision = decideIncomingAnswer(ref, viewOf(peer));
    // An answer from (or to) a connection that is no longer the current one.
    if (decision.action === 'ignore') return;
    peer.remotePcId = decision.remotePcId;
    await peer.negotiation.receiveAnswer(sdp);
    drainPendingCandidates(peer);
  }, [drainPendingCandidates]);

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback(
    async (from: string, candidate: RTCIceCandidateInit, ref: PeerConnectionRef = {}) => {
      const peer = peersRef.current.get(from);
      if (!peer) {
        bufferCandidate(from, candidate, ref.pcId);
        return;
      }
      const decision = decideIncomingCandidate(ref, peer);
      if (decision === 'ignore') return;
      if (decision === 'buffer') {
        // From a connection whose offer or answer we have not applied yet
        // (it is still being processed); keep it for that connection.
        bufferCandidate(from, candidate, ref.pcId);
        return;
      }

      try {
        await peer.negotiation.receiveCandidate(candidate);
      } catch (err) {
        console.warn(`Could not apply ICE candidate from ${from}:`, err);
      }
    },
    [bufferCandidate]
  );

  // Remove a peer connection
  const removePeer = useCallback(
    (participantId: string) => {
      removedPeersRef.current.set(participantId, (removedPeersRef.current.get(participantId) || 0) + 1);
      pendingCandidatesRef.current.delete(participantId);
      rebuildCountsRef.current.delete(participantId);
      setPeerReconnecting(participantId, false);
      const peer = peersRef.current.get(participantId);
      if (peer) {
        peer.negotiation.dispose();
        // Null out handlers before closing
        peer.connection.ontrack = null;
        peer.connection.onicecandidate = null;
        peer.connection.onconnectionstatechange = null;
        peer.connection.close();
        peersRef.current.delete(participantId);
        pendingCandidatesRef.current.delete(participantId);
        removePeerBandwidthState(participantId);
        updateRemoteStreams();
        applyMeshSendLimits();
      }
      remoteScreenStreamIdsRef.current.delete(participantId);
    },
    [applyMeshSendLimits, removePeerBandwidthState, setPeerReconnecting, updateRemoteStreams]
  );

  const samplePeerBandwidth = useCallback(async () => {
    let updatedHealth = false;
    for (const [participantId, peer] of peersRef.current) {
      if (peer.connection.connectionState !== 'connected') continue;

      try {
        const report = await peer.connection.getStats();
        // What reaches us from this peer (their audio and video): sampled even
        // when we send nothing ourselves, e.g. audio-only or camera off.
        const inboundSnapshot = readInboundStatsSnapshot(report);
        const previousInbound = inboundStatesRef.current.get(participantId)?.snapshot ?? null;
        inboundStatesRef.current.set(participantId, {
          snapshot: inboundSnapshot,
          sample: assessInboundHealth(previousInbound, inboundSnapshot),
        });
        updatedHealth = true;

        const snapshot = readOutboundVideoStatsSnapshot(report);
        if (!snapshot) continue;

        const previousState = bandwidthStatesRef.current.get(participantId) || createInitialBandwidthAdaptationState();
        const nextState = updateBandwidthAdaptationState(previousState, snapshot);
        bandwidthStatesRef.current.set(participantId, nextState);

        if (nextState.mode !== previousState.mode) {
          await applyPeerBandwidthMode(peer, nextState.mode);
        }
      } catch (err) {
        console.warn(`Failed to sample connection quality for peer ${participantId}:`, err);
      }
    }
    if (updatedHealth) publishPeerBandwidthHealth();
  }, [applyPeerBandwidthMode, publishPeerBandwidthHealth]);

  /**
   * Send (or stop sending) our screen as a second video track on every peer,
   * so our camera stays on stage while we share, and the screen's audio (a
   * shared tab's or the system's sound) as its own track in the same stream.
   * Each call renegotiates through PeerNegotiation's negotiationneeded handling.
   */
  const publishScreenTrack = useCallback(async (
    track: MediaStreamTrack | null,
    stream?: MediaStream,
    audioTrack?: MediaStreamTrack | null,
  ) => {
    const screenAudio = track && stream && audioTrack && audioTrack.readyState === 'live' ? audioTrack : null;
    publishedScreenRef.current = track && stream ? { track, stream, audioTrack: screenAudio } : null;
    for (const [participantId, peer] of peersRef.current) {
      try {
        if (track && stream) {
          peer.screenTransceiver = await sendScreenOnConnection(peer.connection, peer.screenTransceiver, track, stream);
          if (screenAudio) {
            peer.screenAudioTransceiver = await sendScreenOnConnection(peer.connection, peer.screenAudioTransceiver, screenAudio, stream);
          } else if (peer.screenAudioTransceiver) {
            await stopScreenOnConnection(peer.screenAudioTransceiver);
          }
          void applyScreenSendLimits(peer);
        } else {
          if (peer.screenTransceiver) await stopScreenOnConnection(peer.screenTransceiver);
          if (peer.screenAudioTransceiver) await stopScreenOnConnection(peer.screenAudioTransceiver);
        }
      } catch (err) {
        console.warn(`Failed to ${track ? 'send' : 'stop'} screen track for peer ${participantId}:`, err);
      }
    }
  }, [applyScreenSendLimits]);

  /** "Optimize for text" (slides, documents) or "motion" (a video): changes what each peer's screen encoder favors. */
  const setScreenShareOptimization = useCallback((mode: ScreenShareOptimization) => {
    screenOptimizationRef.current = mode;
    for (const peer of peersRef.current.values()) void applyScreenSendLimits(peer);
  }, [applyScreenSendLimits]);

  /** Remember (or forget) which of a peer's streams is its screen. */
  const setRemoteScreenStreamId = useCallback((participantId: string, streamId: string | null) => {
    if (streamId) remoteScreenStreamIdsRef.current.set(participantId, streamId);
    else remoteScreenStreamIdsRef.current.delete(participantId);
    const peer = peersRef.current.get(participantId);
    if (!peer) return;
    if (!streamId && peer.screenStream) {
      peer.screenStream = null;
      updateRemoteStreams();
    } else if (streamId && !peer.screenStream && peer.stream?.id === streamId) {
      // The screen track arrived before the announcement and was taken for the camera.
      peer.screenStream = peer.stream;
      peer.stream = null;
      updateRemoteStreams();
    }
  }, [updateRemoteStreams]);

  // Replace a track on all active peer connections (used when switching devices)
  const replaceTrack = useCallback(
    async (newTrack: MediaStreamTrack) => {
      if (newTrack.kind !== 'audio' && newTrack.kind !== 'video') return;
      const kind = newTrack.kind;
      publishedTracksRef.current.set(kind, newTrack);
      for (const [participantId, peer] of peersRef.current) {
        const forwardingEnabled = shouldForward(kind, participantId);
        let sender: RTCRtpSender;
        try {
          sender = await replacePeerMediaTrack(
            peer, newTrack, localStreamRef.current || new MediaStream([newTrack]), forwardingEnabled,
          );
        } catch (err) {
          console.warn(`Failed to replace track for peer ${participantId}:`, err);
          continue;
        }
        if (!forwardingEnabled) continue;
        try {
          await refreshSenderVideoEncodingParameters(sender, newTrack);
          const currentMode = bandwidthStatesRef.current.get(participantId)?.mode || 'full';
          await applyBandwidthModeToVideoSender(sender, currentMode, getVideoCap());
        } catch (err) {
          console.warn('Failed to refresh video sender encoding parameters:', err);
        }
      }
    },
    [getVideoCap, shouldForward]
  );

  /** Attach or detach our camera/mic on each mesh peer to match the forwarding policy. */
  const applyForwarding = useCallback(async (kind: 'audio' | 'video') => {
    const track = publishedTracksRef.current.get(kind)
      || (kind === 'video' ? localStreamRef.current?.getVideoTracks()[0] : localStreamRef.current?.getAudioTracks()[0])
      || null;
    await Promise.all(Array.from(peersRef.current.values()).map(async (peer) => {
      const sender = peer.senders.get(kind);
      if (!sender) return;
      const forward = shouldForward(kind, peer.participantId);
      const desired = forward ? track : null;
      if (sender.track === desired) return;
      try {
        await sender.replaceTrack(desired);
        if (kind === 'video' && desired) {
          await refreshSenderVideoEncodingParameters(sender, desired);
          const currentMode = bandwidthStatesRef.current.get(peer.participantId)?.mode || 'full';
          await applyBandwidthModeToVideoSender(sender, currentMode, getVideoCap());
        }
      } catch (err) {
        console.warn(`Failed to ${forward ? 'resume' : 'pause'} mesh ${kind} for peer ${peer.participantId}:`, err);
      }
    }));
  }, [getVideoCap, shouldForward]);

  const setVideoForwardingEnabled = useCallback(async (enabled: boolean) => {
    if (forwardingEnabledRef.current.video === enabled) return;
    forwardingEnabledRef.current = { ...forwardingEnabledRef.current, video: enabled };
    await applyForwarding('video');
  }, [applyForwarding]);

  const setAudioForwardingEnabled = useCallback(async (enabled: boolean) => {
    if (forwardingEnabledRef.current.audio === enabled) return;
    forwardingEnabledRef.current = { ...forwardingEnabledRef.current, audio: enabled };
    await applyForwarding('audio');
  }, [applyForwarding]);

  /**
   * Peers that keep our mesh media even while the SFU carries it to the stage
   * (backstage participants, whom the SFU does not serve). Call
   * refreshMeshForwarding when who is backstage changes.
   */
  const setMeshForwardingExemption = useCallback((exempt: ((participantId: string) => boolean) | null) => {
    forwardingExemptRef.current = exempt || (() => false);
  }, []);

  const refreshMeshForwarding = useCallback(async () => {
    await Promise.all([applyForwarding('audio'), applyForwarding('video')]);
  }, [applyForwarding]);

  useEffect(() => {
    const timer = setInterval(() => {
      samplePeerBandwidth().catch((err) => {
        console.warn('Failed to run WebRTC bandwidth adaptation:', err);
      });
    }, BANDWIDTH_ADAPTATION_INTERVAL_MS);
    bandwidthAdaptationTimerRef.current = timer;

    return () => {
      clearInterval(timer);
      if (bandwidthAdaptationTimerRef.current === timer) {
        bandwidthAdaptationTimerRef.current = null;
      }
    };
  }, [samplePeerBandwidth]);

  // Relay servers can arrive late (the studio server was asleep): use them on
  // existing connections too, and retry any that are not up yet through them.
  useEffect(() => {
    const loader = getSharedIceConfigLoader();
    let cancelled = false;
    iceReadyRef.current = loader.ready().then((value) => {
      if (!cancelled) iceConfigRef.current = value.config;
    });
    const unsubscribe = loader.subscribe(({ config }) => {
      if (cancelled) return;
      const gainedTurn = !hasTurnServers(iceConfigRef.current) && hasTurnServers(config);
      iceConfigRef.current = config;
      for (const peer of peersRef.current.values()) {
        try {
          peer.connection.setConfiguration(buildRtcConfiguration(config));
        } catch (err) {
          console.warn(`Could not update relay servers for peer ${peer.participantId}:`, err);
          continue;
        }
        if (gainedTurn && peer.connection.connectionState !== 'connected') peer.negotiation.restartNow();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Back online after a network change: retry broken links now, not after the backoff.
  useEffect(() => {
    const onOnline = () => {
      for (const peer of peersRef.current.values()) {
        if (peer.connection.connectionState !== 'connected') peer.negotiation.restartNow();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // Clean up all connections
  const cleanup = useCallback(() => {
    generationRef.current++;
    removedPeersRef.current.clear();
    rebuildCountsRef.current.clear();
    for (const timer of reconnectingTimersRef.current.values()) clearTimeout(timer);
    reconnectingTimersRef.current.clear();
    setReconnectingPeerIds(new Set());
    // The sampling effect owns its timer; a room rejoin only resets peers.
    for (const [, peer] of peersRef.current) {
      peer.negotiation.dispose();
      // Bug fix #3: Null out event handlers before closing
      peer.connection.ontrack = null;
      peer.connection.onicecandidate = null;
      peer.connection.onconnectionstatechange = null;
      peer.connection.close();
    }
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    remoteScreenStreamIdsRef.current.clear();
    clearPeerBandwidthStates();
    setRemoteStreams(new Map());
    setRemoteScreenStreams(new Map());
    setRemoteScreenAudioTracks(new Map());
  }, [clearPeerBandwidthStates]);

  // A new participant ID (a fresh join, not a resumed seat) means the old
  // negotiations belong to another identity and must not be reused. A resumed
  // seat keeps its ID, so healthy peer connections survive a signaling drop.
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup, myParticipantId]);

  return {
    remoteStreams,
    remoteScreenStreams,
    /** Per participant: the audio tracks of their screen share (also in remoteScreenStreams' stream). */
    remoteScreenAudioTracks,
    publishScreenTrack,
    setScreenShareOptimization,
    setRemoteScreenStreamId,
    peerBandwidthHealth,
    reconnectingPeerIds,
    connectToPeer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    removePeer,
    replaceTrack,
    setAudioForwardingEnabled,
    setVideoForwardingEnabled,
    setMeshForwardingExemption,
    refreshMeshForwarding,
    cleanup,
  };
}
