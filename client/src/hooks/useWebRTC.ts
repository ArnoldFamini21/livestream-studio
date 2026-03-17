import { useRef, useCallback, useState, useEffect } from 'react';
import type { SignalMessage, Participant } from '@studio/shared';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

interface PeerState {
  participantId: string;
  connection: RTCPeerConnection;
  stream: MediaStream | null;
}

interface UseWebRTCProps {
  localStream: MediaStream | null;
  myParticipantId: string | null;
  send: (message: SignalMessage) => void;
}

export function useWebRTC({ localStream, myParticipantId, send }: UseWebRTCProps) {
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

  // Bug fix #1: Buffer ICE candidates that arrive before remote description is set
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  // Bug fix #5: Track disconnected timers for ICE restart
  const disconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const updateRemoteStreams = useCallback(() => {
    const streams = new Map<string, MediaStream>();
    for (const [id, peer] of peersRef.current) {
      if (peer.stream) {
        streams.set(id, peer.stream);
      }
    }
    setRemoteStreams(new Map(streams));
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
      }

      const pc = new RTCPeerConnection(ICE_SERVERS);

      const peerState: PeerState = {
        participantId: remoteParticipantId,
        connection: pc,
        stream: null,
      };

      // Add local tracks to the connection
      if (localStream) {
        for (const track of localStream.getTracks()) {
          pc.addTrack(track, localStream);
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

      // Send ICE candidates to the remote peer
      pc.onicecandidate = (event) => {
        if (event.candidate && myParticipantId) {
          send({
            type: 'ice-candidate',
            payload: {
              from: myParticipantId,
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
          const timer = setTimeout(() => {
            disconnectTimersRef.current.delete(remoteParticipantId);
            if (pc.connectionState === 'disconnected') {
              console.log(`Peer ${remoteParticipantId} still disconnected, restarting ICE`);
              pc.restartIce();
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
          updateRemoteStreams();
        } else if (pc.connectionState === 'closed') {
          peersRef.current.delete(remoteParticipantId);
          pendingCandidatesRef.current.delete(remoteParticipantId);
          updateRemoteStreams();
        }
      };

      peersRef.current.set(remoteParticipantId, peerState);
      return pc;
    },
    [localStream, myParticipantId, send, updateRemoteStreams]
  );

  // Initiate a connection to a remote participant (caller side)
  const connectToPeer = useCallback(
    async (remoteParticipantId: string) => {
      if (!myParticipantId) return;

      // Bug fix #4: Guard against duplicate calls to prevent glare conditions
      if (peersRef.current.has(remoteParticipantId)) return;

      const pc = createPeerConnection(remoteParticipantId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      send({
        type: 'offer',
        payload: {
          from: myParticipantId,
          to: remoteParticipantId,
          sdp: offer,
        },
      });
    },
    [myParticipantId, createPeerConnection, send]
  );

  // Handle incoming offer (callee side)
  const handleOffer = useCallback(
    async (from: string, sdp: RTCSessionDescriptionInit) => {
      if (!myParticipantId) return;

      const pc = createPeerConnection(from);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));

      // Bug fix #1: Drain any buffered ICE candidates after setting remote description
      await drainPendingCandidates(from, pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      send({
        type: 'answer',
        payload: {
          from: myParticipantId,
          to: from,
          sdp: answer,
        },
      });
    },
    [myParticipantId, createPeerConnection, send, drainPendingCandidates]
  );

  // Handle incoming answer
  const handleAnswer = useCallback(
    async (from: string, sdp: RTCSessionDescriptionInit) => {
      const peer = peersRef.current.get(from);
      if (peer) {
        await peer.connection.setRemoteDescription(new RTCSessionDescription(sdp));

        // Bug fix #1: Drain any buffered ICE candidates after setting remote description
        await drainPendingCandidates(from, peer.connection);
      }
    },
    [drainPendingCandidates]
  );

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback(
    async (from: string, candidate: RTCIceCandidateInit) => {
      const peer = peersRef.current.get(from);
      if (peer) {
        // Bug fix #1: Buffer candidates if remote description is not yet set
        if (!peer.connection.remoteDescription) {
          const existing = pendingCandidatesRef.current.get(from) || [];
          existing.push(candidate);
          pendingCandidatesRef.current.set(from, existing);
          return;
        }
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    },
    []
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
        updateRemoteStreams();
      }
    },
    [updateRemoteStreams]
  );

  // Replace a track on all active peer connections (used when switching devices)
  const replaceTrack = useCallback(
    async (newTrack: MediaStreamTrack) => {
      for (const [, peer] of peersRef.current) {
        const senders = peer.connection.getSenders();
        const sender = senders.find((s) => s.track?.kind === newTrack.kind);
        if (sender) {
          await sender.replaceTrack(newTrack);
        }
      }
    },
    []
  );

  // Clean up all connections
  const cleanup = useCallback(() => {
    // Bug fix #5: Clear all disconnect timers
    for (const [, timer] of disconnectTimersRef.current) {
      clearTimeout(timer);
    }
    disconnectTimersRef.current.clear();

    for (const [, peer] of peersRef.current) {
      // Bug fix #3: Null out event handlers before closing
      peer.connection.ontrack = null;
      peer.connection.onicecandidate = null;
      peer.connection.onconnectionstatechange = null;
      peer.connection.close();
    }
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    setRemoteStreams(new Map());
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    remoteStreams,
    connectToPeer,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    removePeer,
    replaceTrack,
    cleanup,
  };
}
