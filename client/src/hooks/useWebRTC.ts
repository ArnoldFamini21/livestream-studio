import { useRef, useCallback, useState, useEffect } from 'react';
import type { SignalMessage, Participant } from '@studio/shared';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turns:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceTransportPolicy: 'all',
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

  // Use refs to avoid stale closures in setTimeout callbacks
  const myParticipantIdRef = useRef<string | null>(myParticipantId);
  useEffect(() => { myParticipantIdRef.current = myParticipantId; }, [myParticipantId]);

  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; }, [send]);

  const localStreamRef = useRef(localStream);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

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

      // Add local tracks to the connection (use ref for latest stream)
      const currentStream = localStreamRef.current;
      if (currentStream) {
        for (const track of currentStream.getTracks()) {
          pc.addTrack(track, currentStream);
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
    [updateRemoteStreams]
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
      }
    },
    [createPeerConnection]
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
      }
    },
    [createPeerConnection, drainPendingCandidates]
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
      if (!peer) {
        // Peer doesn't exist yet -- buffer the candidate until the peer is created
        const existing = pendingCandidatesRef.current.get(from) || [];
        existing.push(candidate);
        pendingCandidatesRef.current.set(from, existing);
        return;
      }

      // Buffer candidates if remote description is not yet set
      if (!peer.connection.remoteDescription) {
        const existing = pendingCandidatesRef.current.get(from) || [];
        existing.push(candidate);
        pendingCandidatesRef.current.set(from, existing);
        return;
      }

      try {
        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error(`Failed to add ICE candidate from ${from}:`, err);
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
