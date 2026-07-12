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
}

interface UseWebRTCProps {
  localStream: MediaStream | null;
  myParticipantId: string | null;
  send: (message: SignalMessage) => void;
}

export function useWebRTC({ localStream, myParticipantId, send }: UseWebRTCProps) {
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const iceConfigRef = useRef<RTCConfiguration>(DEFAULT_ICE_CONFIG);
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
    fetchIceConfig()
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

  // Bug fix #5: Track disconnected timers for ICE restart
  const disconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
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

  // Bug fix #1: Drain buffered ICE candidates for a given peer
  const drainPendingCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const pending = pendingCandidatesRef.current.get(peerId);
    if (pending && pending.length > 0) {
      const candidates = [...pending];
      pendingCandidatesRef.current.delete(peerId);
      for (const candidate of candidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error(`Failed to add buffered ICE candidate for ${peerId}:`, err);
        }
      }
    }
  }, []);

  const createPeerConnection = useCallback(
    (remoteParticipantId: string): RTCPeerConnection => {
      const existing = peersRef.current.get(remoteParticipantId);
      if (existing) {
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
        if (remoteStream) {
          peerState.stream = remoteStream;
          updateRemoteStreams();
        }
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

        // Bug fix #5: ICE restart on disconnected state with 5-second timeout
        if (pc.connectionState === 'disconnected') {
          const timer = setTimeout(async () => {
            disconnectTimersRef.current.delete(remoteParticipantId);
            if (pc.connectionState === 'disconnected') {
              console.log(`Peer ${remoteParticipantId} still disconnected, restarting ICE`);
              try {
                pc.restartIce();
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                const currentMyId = myParticipantIdRef.current;
                if (currentMyId) {
                  sendRef.current({
                    type: 'offer',
                    payload: {
                      from: currentMyId,
                      to: remoteParticipantId,
                      sdp: pc.localDescription!,
                    },
                  });
                }
              } catch (err) {
                console.error(`ICE restart failed for ${remoteParticipantId}:`, err);
                pc.ontrack = null;
                pc.onicecandidate = null;
                pc.onconnectionstatechange = null;
                pc.close();
                peersRef.current.delete(remoteParticipantId);
                pendingCandidatesRef.current.delete(remoteParticipantId);
                removePeerBandwidthState(remoteParticipantId);
                updateRemoteStreams();
              }
            }
          }, 5000);
          disconnectTimersRef.current.set(remoteParticipantId, timer);
        } else {
          // Clear any pending disconnect timer if state changed away from disconnected
          const existingTimer = disconnectTimersRef.current.get(remoteParticipantId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            disconnectTimersRef.current.delete(remoteParticipantId);
          }
        }

        if (pc.connectionState === 'failed') {
          // Bug fix #2: Close peer connection on failed state - close BEFORE deleting,
          // and null out event handlers first
          pc.ontrack = null;
          pc.onicecandidate = null;
          pc.onconnectionstatechange = null;
          pc.close();
          peersRef.current.delete(remoteParticipantId);
          pendingCandidatesRef.current.delete(remoteParticipantId);
          removePeerBandwidthState(remoteParticipantId);
          updateRemoteStreams();
        } else if (pc.connectionState === 'closed') {
          peersRef.current.delete(remoteParticipantId);
          pendingCandidatesRef.current.delete(remoteParticipantId);
          removePeerBandwidthState(remoteParticipantId);
          updateRemoteStreams();
        }
      };

      peersRef.current.set(remoteParticipantId, peerState);
      return pc;
    },
    [removePeerBandwidthState, updateRemoteStreams]
  );

  // Initiate a connection to a remote participant (caller side)
  // Uses refs to avoid stale closure issues when called from setTimeout
  const connectToPeer = useCallback(
    async (remoteParticipantId: string) => {
      const currentMyId = myParticipantIdRef.current;
      if (!currentMyId) return;

      // If we already have a peer, only reconnect if the connection is in a bad state
      const existing = peersRef.current.get(remoteParticipantId);
      if (existing) {
        const state = existing.connection.connectionState;
        if (state === 'failed' || state === 'closed') {
          // Clean up the broken connection before reconnecting
          existing.connection.ontrack = null;
          existing.connection.onicecandidate = null;
          existing.connection.onconnectionstatechange = null;
          existing.connection.close();
          peersRef.current.delete(remoteParticipantId);
          pendingCandidatesRef.current.delete(remoteParticipantId);
          removePeerBandwidthState(remoteParticipantId);
        } else {
          // Connection exists and is healthy or still negotiating; skip
          return;
        }
      }

      const pc = createPeerConnection(remoteParticipantId);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        sendRef.current({
          type: 'offer',
          payload: {
            from: currentMyId,
            to: remoteParticipantId,
            sdp: offer,
          },
        });
      } catch (err) {
        console.error(`Failed to create offer for ${remoteParticipantId}:`, err);
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
        peersRef.current.delete(remoteParticipantId);
        pendingCandidatesRef.current.delete(remoteParticipantId);
        removePeerBandwidthState(remoteParticipantId);
      }
    },
    [createPeerConnection, removePeerBandwidthState]
  );

  // Handle incoming offer (callee side)
  // Includes glare resolution: when we have a pending outgoing offer to the same peer,
  // the peer with the lexicographically smaller ID is "polite" and yields.
  const handleOffer = useCallback(
    async (from: string, sdp: RTCSessionDescriptionInit) => {
      const currentMyId = myParticipantIdRef.current;
      if (!currentMyId) return;

      // Glare resolution: we already sent an offer to this peer (have-local-offer state)
      const existingPeer = peersRef.current.get(from);
      if (existingPeer) {
        const signalingState = existingPeer.connection.signalingState;
        if (signalingState === 'have-local-offer') {
          // Both sides sent offers simultaneously. The peer with the smaller ID is polite
          // (yields and accepts the incoming offer). The impolite peer ignores it.
          const isPolite = currentMyId < from;
          if (!isPolite) {
            // We are impolite; ignore the incoming offer and keep our own
            console.log(`Glare with ${from}: we are impolite, ignoring incoming offer`);
            return;
          }
          // We are polite: discard our pending offer and accept theirs
          console.log(`Glare with ${from}: we are polite, accepting incoming offer`);
        }
      }

      const pc = createPeerConnection(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));

        // Bug fix #1: Drain any buffered ICE candidates after setting remote description
        await drainPendingCandidates(from, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendRef.current({
          type: 'answer',
          payload: {
            from: currentMyId,
            to: from,
            sdp: answer,
          },
        });
      } catch (err) {
        console.error(`Failed to handle offer from ${from}:`, err);
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
        peersRef.current.delete(from);
        pendingCandidatesRef.current.delete(from);
        removePeerBandwidthState(from);
      }
    },
    [createPeerConnection, drainPendingCandidates, removePeerBandwidthState]
  );

  // Handle incoming answer
  const handleAnswer = useCallback(
    async (from: string, sdp: RTCSessionDescriptionInit) => {
      const peer = peersRef.current.get(from);
      if (!peer) return;
      try {
        await peer.connection.setRemoteDescription(new RTCSessionDescription(sdp));
        await drainPendingCandidates(from, peer.connection);
      } catch (err) {
        // setRemoteDescription can reject if the peer was closed mid-flight or the
        // SDP was malformed. Clean up rather than letting the rejection bubble.
        console.error(`Failed to apply answer from ${from}:`, err);
        try {
          peer.connection.ontrack = null;
          peer.connection.onicecandidate = null;
          peer.connection.onconnectionstatechange = null;
          peer.connection.close();
        } catch {
          // Already closed
        }
        peersRef.current.delete(from);
        pendingCandidatesRef.current.delete(from);
        removePeerBandwidthState(from);
        updateRemoteStreams();
      }
    },
    [drainPendingCandidates, removePeerBandwidthState, updateRemoteStreams]
  );

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

      // Buffer candidates if remote description is not yet set
      if (!peer.connection.remoteDescription) {
        bufferCandidate(from, candidate);
        return;
      }

      try {
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(`Failed to add ICE candidate from ${from}:`, err);
      }
    },
    [bufferCandidate]
  );

  // Remove a peer connection
  const removePeer = useCallback(
    (participantId: string) => {
      const peer = peersRef.current.get(participantId);
      if (peer) {
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
          await sender.replaceTrack(newTrack);
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
    // Bug fix #5: Clear all disconnect timers
    for (const [, timer] of disconnectTimersRef.current) {
      clearTimeout(timer);
    }
    disconnectTimersRef.current.clear();
    if (bandwidthAdaptationTimerRef.current) {
      clearInterval(bandwidthAdaptationTimerRef.current);
      bandwidthAdaptationTimerRef.current = null;
    }

    for (const [, peer] of peersRef.current) {
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

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

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
