import { buildVideoSimulcastEncodingsForTrack } from './webrtcSimulcast.ts';

export interface PeerMediaSenders {
  connection: Pick<RTCPeerConnection, 'addTransceiver'>;
  senders: Map<'audio' | 'video', RTCRtpSender>;
}

/** Publish a device kind even when permission or hardware arrived after the peer connected. */
export async function replacePeerMediaTrack(
  peer: PeerMediaSenders,
  track: MediaStreamTrack,
  stream: MediaStream,
  forwardingEnabled: boolean,
): Promise<RTCRtpSender> {
  if (track.kind !== 'audio' && track.kind !== 'video') throw new Error('Unsupported peer media kind.');
  const existing = peer.senders.get(track.kind);
  if (existing) {
    if (forwardingEnabled) await existing.replaceTrack(track);
    return existing;
  }

  // A fresh transceiver triggers negotiationneeded and cannot steal an idle
  // screen-share sender or an incoming simulcast camera's transceiver.
  // When SFU forwarding is active, allocate the mesh sender without attaching
  // a track so the fallback path stays silent until explicitly resumed.
  const trackOrKind = forwardingEnabled ? track : track.kind;
  const init: RTCRtpTransceiverInit = { direction: 'sendrecv', streams: [stream] };
  const encodings = buildVideoSimulcastEncodingsForTrack(track);
  let sender: RTCRtpSender;
  if (encodings.length > 0) {
    try {
      sender = peer.connection.addTransceiver(trackOrKind, { ...init, sendEncodings: encodings }).sender;
    } catch {
      sender = peer.connection.addTransceiver(trackOrKind, init).sender;
    }
  } else {
    sender = peer.connection.addTransceiver(trackOrKind, init).sender;
  }
  peer.senders.set(track.kind, sender);
  return sender;
}
