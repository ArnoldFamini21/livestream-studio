/** Keep renegotiation on the existing connection so a network change does not
 * discard the guest's stream, senders, or bandwidth settings. */
export class PeerNegotiation {
  private operations: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private restartAttempts = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private candidates: RTCIceCandidateInit[] = [];

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly polite: boolean,
    private readonly send: (description: RTCSessionDescriptionInit) => void,
    private readonly isCurrent: () => boolean,
    private readonly recoveryDelayMs = 5_000,
  ) {
    // The answering side's camera sits on its own transceiver (simulcast uses
    // addTransceiver, which an incoming offer cannot adopt), so it only starts
    // sending after a follow-up offer. Without this, whoever answered was never
    // seen: the host could not see a guest, or a guest could not see the host
    // or their screen share. Collisions are resolved by the polite/impolite roles.
    pc.addEventListener?.('negotiationneeded', () => {
      void this.offer().catch(() => {});
    });
  }

  private active() {
    return !this.disposed && this.isCurrent() && this.pc.signalingState !== 'closed';
  }

  private enqueue(operation: () => Promise<void>) {
    const result = this.operations.then(async () => {
      if (this.active()) await operation();
    });
    // An invalid/stale signal must not prevent later recovery or close a newer peer.
    this.operations = result.catch(() => {});
    return result;
  }

  offer(iceRestart = false) {
    return this.enqueue(async () => {
      if (this.pc.signalingState === 'have-local-offer' && iceRestart) {
        // Recovery with our last offer still unanswered (lost, or dropped by the
        // peer): take it back and offer again rather than wait forever.
        await this.pc.setLocalDescription({ type: 'rollback' });
        if (!this.active()) return;
      }
      if (this.pc.signalingState !== 'stable') return;
      this.makingOffer = true;
      try {
        const offer = await this.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
        if (!this.active()) return;
        await this.pc.setLocalDescription(offer);
        if (this.active() && this.pc.localDescription) this.send(this.pc.localDescription);
      } finally {
        this.makingOffer = false;
      }
    });
  }

  receiveOffer(sdp: RTCSessionDescriptionInit) {
    return this.enqueue(async () => {
      // Decide here, not on arrival: operations run in order, so an offer we are
      // still creating has been set by now (a real collision), and an answer
      // queued ahead of this offer has been applied (not a collision). Checking
      // on arrival dropped an offer that came in while the previous answer was
      // being applied, and the peer then waited forever for our answer.
      const collision = this.makingOffer || this.pc.signalingState !== 'stable';
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      // Modern WebRTC rolls back a pending local offer when applying this offer.
      await this.pc.setRemoteDescription(sdp);
      if (!this.active()) return;
      await this.drainCandidates();
      const answer = await this.pc.createAnswer();
      if (!this.active()) return;
      await this.pc.setLocalDescription(answer);
      if (this.active() && this.pc.localDescription) this.send(this.pc.localDescription);
    });
  }

  receiveAnswer(sdp: RTCSessionDescriptionInit) {
    return this.enqueue(async () => {
      // A duplicate answer must not tear down a working guest connection.
      if (this.pc.signalingState !== 'have-local-offer') return;
      await this.pc.setRemoteDescription(sdp);
      if (!this.active()) return;
      this.ignoreOffer = false;
      await this.drainCandidates();
    });
  }

  receiveCandidate(candidate: RTCIceCandidateInit) {
    return this.enqueue(async () => {
      // A rolled-back offer may reuse ICE credentials in its answer. Keep the
      // candidates until the accepted description tells us which generation wins.
      if (this.ignoreOffer || !this.pc.remoteDescription) {
        if (this.candidates.length >= 50) this.candidates.shift();
        this.candidates.push(candidate);
        return;
      }
      await this.pc.addIceCandidate(candidate);
    });
  }

  private async drainCandidates() {
    const candidates = this.candidates.splice(0);
    for (const candidate of candidates) {
      if (!this.active()) return;
      // Candidates from an earlier ICE generation can arrive after a restart.
      try { await this.pc.addIceCandidate(candidate); } catch { /* Try the next candidate. */ }
    }
  }

  connectionStateChanged() {
    if (!this.active()) return;
    if (this.pc.connectionState === 'connected') {
      this.restartAttempts = 0;
      this.clearRecoveryTimer();
    } else if (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed') {
      this.scheduleRecovery();
    }
  }

  private scheduleRecovery() {
    if (this.recoveryTimer || this.restartAttempts >= 2) return;
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = undefined;
      if (!this.active() || this.pc.connectionState === 'connected') return;
      this.restartAttempts++;
      try { await this.offer(true); } catch { /* Keep the stream while retrying. */ }
      if (this.active()) this.connectionStateChanged();
    }, this.recoveryDelayMs);
  }

  private clearRecoveryTimer() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  dispose() {
    this.disposed = true;
    this.clearRecoveryTimer();
    this.candidates = [];
  }
}
