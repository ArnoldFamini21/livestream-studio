/**
 * Our screen goes to a peer on its own send-only transceiver.
 *
 * addTrack() would reuse any idle video transceiver, including the one the
 * peer's offer created to send us its simulcast camera. A transceiver that
 * receives simulcast cannot send (its sender gets no encodings), so the screen
 * never arrived. Which transceiver was idle depended on who offered first,
 * so this failed only some of the time. addTransceiver() is never matched
 * to the peer's m-lines, the same reason the camera uses it.
 */

function isStopped(transceiver: RTCRtpTransceiver): boolean {
  return transceiver.currentDirection === 'stopped' || transceiver.direction === 'stopped';
}

export async function sendScreenOnConnection(
  pc: RTCPeerConnection,
  current: RTCRtpTransceiver | null,
  track: MediaStreamTrack,
  stream: MediaStream,
): Promise<RTCRtpTransceiver> {
  // Reuse the transceiver from an earlier share so the SDP does not grow with every share.
  if (current && !isStopped(current) && typeof current.sender.setStreams === 'function') {
    await current.sender.replaceTrack(track);
    // The peer tells the screen apart from the camera by its stream id.
    current.sender.setStreams(stream);
    current.direction = 'sendonly';
    return current;
  }
  return pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
}

/** Stop sending the screen; the peer's receiver ends after the renegotiation this triggers. */
export async function stopScreenOnConnection(transceiver: RTCRtpTransceiver): Promise<void> {
  if (isStopped(transceiver)) return;
  await transceiver.sender.replaceTrack(null);
  transceiver.direction = 'inactive';
}
