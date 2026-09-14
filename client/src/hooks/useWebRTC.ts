import { PeerNegotiation } from '../utils/peerNegotiation.ts';
import { useRef, useCallback, useState, useEffect } from 'react';
import type { SignalMessage, Participant } from '@studio/shared';
import { DEFAULT_ICE_CONFIG, fetchIceConfig } from '../utils/iceConfig.ts';
import {
  applyBandwidthModeToVideoSender,
  buildPeerBandwidthHealth,
  createInitialBandwidthAdaptationState,
  readOutboundVideoStatsSnapshot,
  updateBandwidthAdaptationState,
  type BandwidthAdaptationMode,
  type BandwidthAdaptationState,
  type PeerBandwidthHealth,
} from '../utils/webrtcBandwidthAdaptation.ts';
import {
  addTrackWithOptionalSimulcast,
  refreshSenderVideoEncodingParameters,
} from '../utils/webrtcSimulcast.ts';

interface PeerState {
  participantId: string;
  connection: RTCPeerConnection;
  stream: MediaStream | null;
  senders: Map<'audio' | 'video', RTCRtpSender>;
  negotiation: PeerNegotiation;
}

interface UseWebRTCProps {
  localStream: MediaStream | null;
  myParticipantId: string | null;
  send: (message: SignalMessage) => void;
}

export function useWebRTC({ localStream, myParticipantId, send }: UseWebRTCProps) {
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const iceConfigRef = useRef<RTCConfiguration>(DEFAULT_ICE_CONFIG);
  const iceReadyRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const removedPeersRef = useRef(new Map<string, number>());
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [peerBandwidthHealth, setPeerBandwidthHealth] = useState<Map<string, PeerBandwidthHealth>>(new Map());

  // Use refs to avoid stale closures in setTimeout callbacks
  const myParticipantIdRef = useRef<string | null>(myParticipantId);
  useEffect(() => { myParticipantIdRef.current = myParticipantId; }, [myParticipantId]);

  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; }, [send]);

  const localStreamRef = useRef(localStream);
  const publishedTracksRef = useRef<Map<'audio' | 'video', MediaStreamTrack>>(new Map());
  const audioForwardingEnabledRef = useRef(true);
  const videoForwardingEnabledRef = useRef(true);
  useEffect(() => {
    localStreamRef.current = localStream;
    for (const track of localStream?.getTracks() || []) {
      if ((track.kind === 'audio' || track.kind === 'video') && !publishedTracksRef.current.has(track.kind)) {
        publishedTracksRef.current.set(track.kind, track);
      }
    }
  }, [localStream]);

  useEffect(() => {
    let cancelled = false;
    iceReadyRef.current = fetchIceConfig()
      .then((config) => {
        if (!cancelled) iceConfigRef.current = config;
      })
      .catch(() => {
        if (!cancelled) iceConfigRef.current = DEFAULT_ICE_CONFIG;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Buffer ICE candidates that arrive before remote description is set.
  // Capped per peer so a misbehaving / never-materializing peer cannot accumulate memory.
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const MAX_PENDING_CANDIDATES_PER_PEER = 50;

  const bandwidthStatesRef = useRef<Map<string, BandwidthAdaptationState>>(new Map());
  const bandwidthAdaptationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const BANDWIDTH_ADAPTATION_INTERVAL_MS = 5_000;

  const updateRemoteStreams = useCallback(() => {
    const streams = new Map<string, MediaStream>();
    for (const [id, peer] of peersRef.current) {
      if (peer.stream) {
        streams.set(id, peer.stream);
      }
    }
    setRemoteStreams(new Map(streams));
  }, []);

  const publishPeerBandwidthHealth = useCallback(() => {
    const updatedAtMs = Date.now();
    const next = new Map<string, PeerBandwidthHealth>();
    for (const [participantId, state] of bandwidthStatesRef.current) {
      next.set(participantId, buildPeerBandwidthHealth(state, updatedAtMs));
    }
    setPeerBandwidthHealth(next);
  }, []);

  const removePeerBandwidthState = useCallback((participantId: string) => {
    bandwidthStatesRef.current.delete(participantId);
    setPeerBandwidthHealth((current) => {
      if (!current.has(participantId)) return current;
      const next = new Map(current);
      next.delete(participantId);
      return next;
    });
  }, []);

  const clearPeerBandwidthStates = useCallback(() => {
    bandwidthStatesRef.current.clear();
    setPeerBandwidthHealth(new Map());
  }, []);

  const createPeerConnection = useCallback(
    (remoteParticipantId: string): RTCPeerConnection => {
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

      const pc = new RTCPeerConnection(iceConfigRef.current);

      const peerState: PeerState = {
        participantId: remoteParticipantId,
        connection: pc,
        stream: null,
        senders: new Map(),
        negotiation: new PeerNegotiation(
          pc,
          (myParticipantIdRef.current || '') < remoteParticipantId,
          (sdp) => {
            const from = myParticipantIdRef.current;
            if (!from) return;
            sendRef.current({ type: sdp.type === 'offer' ? 'offer' : 'answer', payload: { from, to: remoteParticipantId, sdp } });
          },
          () => peersRef.current.get(remoteParticipantId)?.connection === pc,
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
          }
          if (track.kind === 'video' && !videoForwardingEnabledRef.current) {
            void sender.replaceTrack(null).catch((err) => {
              console.warn(`Failed to pause mesh video for peer ${remoteParticipantId}:`, err);
            });
          } else if (track.kind === 'audio' && !audioForwardingEnabledRef.current) {
            void sender.replaceTrack(null).catch((err) => {
              console.warn(`Failed to pause mesh audio for peer ${remoteParticipantId}:`, err);
            });
          }
        }
      }

      // Handle incoming remote tracks
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (peersRef.current.get(remoteParticipantId) !== peerState) return;
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
            },
          });
        }
      };

      pc.onconnectionstatechange = () => {
        console.log(`Peer ${remoteParticipantId} connection: ${pc.connectionState}`);

        if (peersRef.current.get(remoteParticipantId) !== peerState) return;
        peerState.negotiation.connectionStateChanged();
        if (pc.connectionState === 'closed') {
          peerState.negotiation.dispose();
          peersRef.current.delete(remoteParticipantId);
          pendingCandidatesRef.current.delete(remoteParticipantId);
          removePeerBandwidthState(remoteParticipantId);
          updateRemoteStreams();
        }
      };

      peersRef.current.set(remoteParticipantId, peerState);
      const pending = pendingCandidatesRef.current.get(remoteParticipantId) || [];
      pendingCandidatesRef.current.delete(remoteParticipantId);
      for (const candidate of pending) {
        void peerState.negotiation.receiveCandidate(candidate).catch(() => {});
      }
      return pc;
    },
    [removePeerBandwidthState, updateRemoteStreams]
  );

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
    if (peer) await peer.negotiation.offer();
  }, [preparePeer]);

  const handleOffer = useCallback(async (from: string, sdp: RTCSessionDescriptionInit) => {
    const peer = await preparePeer(from);
    if (!peer) return;
    await peer.negotiation.receiveOffer(sdp);
    const pending = pendingCandidatesRef.current.get(from) || [];
    pendingCandidatesRef.current.delete(from);
    for (const candidate of pending) await peer.negotiation.receiveCandidate(candidate);
  }, [preparePeer]);

  const handleAnswer = useCallback(async (from: string, sdp: RTCSessionDescriptionInit) => {
    const peer = peersRef.current.get(from);
    if (peer) await peer.negotiation.receiveAnswer(sdp);
  }, []);

  // Push an ICE candidate into the per-peer pending buffer, with a cap.
  const bufferCandidate = useCallback((peerId: string, candidate: RTCIceCandidateInit) => {
    const existing = pendingCandidatesRef.current.get(peerId) || [];
    if (existing.length >= MAX_PENDING_CANDIDATES_PER_PEER) {
      // Drop the oldest to bound memory; a flood of candidates from a single peer
      // should not be allowed to grow unbounded.
      existing.shift();
    }
    existing.push(candidate);
    pendingCandidatesRef.current.set(peerId, existing);
  }, []);

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback(
    async (from: string, candidate: RTCIceCandidateInit) => {
      const peer = peersRef.current.get(from);
      if (!peer) {
        bufferCandidate(from, candidate);
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
      }
    },
    [removePeerBandwidthState, updateRemoteStreams]
  );

  const applyPeerBandwidthMode = useCallback(async (peer: PeerState, mode: BandwidthAdaptationMode) => {
    const videoSenders = peer.connection.getSenders().filter((sender) => sender.track?.kind === 'video');
    await Promise.all(videoSenders.map(async (sender) => {
      try {
        await applyBandwidthModeToVideoSender(sender, mode);
      } catch (err) {
        console.warn(`Failed to apply ${mode} video bandwidth mode for peer ${peer.participantId}:`, err);
      }
    }));
  }, []);

  const samplePeerBandwidth = useCallback(async () => {
    let updatedHealth = false;
    for (const [participantId, peer] of peersRef.current) {
      if (peer.connection.connectionState !== 'connected') continue;

      try {
        const report = await peer.connection.getStats();
        const snapshot = readOutboundVideoStatsSnapshot(report);
        if (!snapshot) continue;

        const previousState = bandwidthStatesRef.current.get(participantId) || createInitialBandwidthAdaptationState();
        const nextState = updateBandwidthAdaptationState(previousState, snapshot);
        bandwidthStatesRef.current.set(participantId, nextState);
        updatedHealth = true;

        if (nextState.mode !== previousState.mode) {
          await applyPeerBandwidthMode(peer, nextState.mode);
        }
      } catch (err) {
        console.warn(`Failed to sample outbound video bandwidth for peer ${participantId}:`, err);
      }
    }
    if (updatedHealth) publishPeerBandwidthHealth();
  }, [applyPeerBandwidthMode, publishPeerBandwidthHealth]);

  // Replace a track on all active peer connections (used when switching devices)
  const replaceTrack = useCallback(
    async (newTrack: MediaStreamTrack) => {
      if (newTrack.kind !== 'audio' && newTrack.kind !== 'video') return;
      publishedTracksRef.current.set(newTrack.kind, newTrack);
      for (const [participantId, peer] of peersRef.current) {
        const sender = peer.senders.get(newTrack.kind);
        if (sender) {
          if (newTrack.kind === 'video' && !videoForwardingEnabledRef.current) continue;
          if (newTrack.kind === 'audio' && !audioForwardingEnabledRef.current) continue;
          try {
            await sender.replaceTrack(newTrack);
          } catch (err) {
            console.warn(`Failed to replace track for peer ${participantId}:`, err);
            continue;
          }
          try {
            await refreshSenderVideoEncodingParameters(sender, newTrack);
            const currentMode = bandwidthStatesRef.current.get(participantId)?.mode || 'full';
            await applyBandwidthModeToVideoSender(sender, currentMode);
          } catch (err) {
            console.warn('Failed to refresh video sender encoding parameters:', err);
          }
        }
      }
    },
    []
  );

  const setVideoForwardingEnabled = useCallback(async (enabled: boolean) => {
    if (videoForwardingEnabledRef.current === enabled) return;
    videoForwardingEnabledRef.current = enabled;
    const videoTrack = publishedTracksRef.current.get('video') || localStreamRef.current?.getVideoTracks()[0] || null;

    await Promise.all(Array.from(peersRef.current.values()).map(async (peer) => {
      const sender = peer.senders.get('video');
      if (!sender) return;
      try {
        await sender.replaceTrack(enabled ? videoTrack : null);
        if (enabled && videoTrack) {
          await refreshSenderVideoEncodingParameters(sender, videoTrack);
          const currentMode = bandwidthStatesRef.current.get(peer.participantId)?.mode || 'full';
          await applyBandwidthModeToVideoSender(sender, currentMode);
        }
      } catch (err) {
        console.warn(`Failed to ${enabled ? 'resume' : 'pause'} mesh video for peer ${peer.participantId}:`, err);
      }
    }));
  }, []);

  const setAudioForwardingEnabled = useCallback(async (enabled: boolean) => {
    if (audioForwardingEnabledRef.current === enabled) return;
    audioForwardingEnabledRef.current = enabled;
    const audioTrack = publishedTracksRef.current.get('audio') || localStreamRef.current?.getAudioTracks()[0] || null;

    await Promise.all(Array.from(peersRef.current.values()).map(async (peer) => {
      const sender = peer.senders.get('audio');
      if (!sender) return;
      try {
        await sender.replaceTrack(enabled ? audioTrack : null);
      } catch (err) {
        console.warn(`Failed to ${enabled ? 'resume' : 'pause'} mesh audio for peer ${peer.participantId}:`, err);
      }
    }));
  }, []);

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

  // Clean up all connections
  const cleanup = useCallback(() => {
    generationRef.current++;
    removedPeersRef.current.clear();
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
    clearPeerBandwidthStates();
    setRemoteStreams(new Map());
  }, [clearPeerBandwidthStates]);

  // A signaling rejoin assigns a new participant ID. Negotiations and callbacks
  // from the old identity must not be reused with the new sender ID.
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup, myParticipantId]);

  return {
    remoteStreams,
    peerBandwidthHealth,
    connectToPeer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    removePeer,
    replaceTrack,
    setAudioForwardingEnabled,
    setVideoForwardingEnabled,
    cleanup,
  };
}
