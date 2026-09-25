/** Keep renegotiation on the existing connection so a network change does not
 * discard the guest's stream, senders, or bandwidth settings. */
export class PeerNegotiation {
  private operations: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private restartAttempts = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private firstOfferTimer: ReturnType<typeof setTimeout> | undefined;
  private firstOfferPending = false;
  private candidates: RTCIceCandidateInit[] = [];

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly polite: boolean,
    private readonly send: (description: RTCSessionDescriptionInit) => void,
    private readonly isCurrent: () => boolean,
    private readonly recoveryDelayMs = 5_000,
    private readonly connectTimeoutMs = 10_000,
    private readonly firstOfferDelayMs = 1_500,
  ) {
    this.armConnectWatchdog();
    // The answering side's camera sits on its own transceiver (simulcast uses
    // addTransceiver, which an incoming offer cannot adopt), so it only starts
    // sending after a follow-up offer. Without this, whoever answered was never
    // seen: the host could not see a guest, or a guest could not see the host
    // or their screen share. Collisions are resolved by the polite/impolite roles.
    pc.addEventListener?.('negotiationneeded', () => {
      if (this.polite && !this.pc.remoteDescription) {
        this.deferFirstOffer();
        return;
      }
      void this.offer().catch(() => {});
    });
  }

  /**
   * Both sides make their first offer at the same moment (a guest is brought
   * on stage). The polite side then takes its offer back, and if a TURN
   * allocation is in flight Chrome never gathers a candidate for that
   * connection again: an ICE restart does not revive it, and the call stays
   * blank (about 1 in 5 relayed calls). So the polite side lets the other
   * side offer first and sends its own offer right after answering. If
   * nothing arrives (a peer with nothing to send never offers), it offers
   * anyway.
   */
  private deferFirstOffer() {
    this.firstOfferPending = true;
    if (this.firstOfferTimer) return;
    this.firstOfferTimer = setTimeout(() => {
      this.firstOfferTimer = undefined;
      this.sendDeferredOffer();
    }, this.firstOfferDelayMs);
  }

  private sendDeferredOffer() {
    if (!this.firstOfferPending) return;
    this.firstOfferPending = false;
    if (this.firstOfferTimer) clearTimeout(this.firstOfferTimer);
    this.firstOfferTimer = undefined;
    if (this.active()) void this.offer().catch(() => {});
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
      // Our own offer waited for this one; it goes out next.
      this.sendDeferredOffer();
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

  /**
   * A connection that never leaves "new" is not reported as failed, so the
   * recovery below never runs. Seen when the polite side takes back its offer
   * while a TURN allocation is in flight: Chrome never finishes gathering for
   * that ICE session and the call stays blank. An ICE restart gathers afresh.
   * The impolite side restarts first; the polite side waits twice as long so
   * the two restarts do not collide (a collision is what caused the stall).
   */
  private armConnectWatchdog() {
    if (this.restartAttempts >= 2) return;
    const delay = this.polite ? this.connectTimeoutMs * 2 : this.connectTimeoutMs;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      if (!this.active() || this.pc.connectionState !== 'new') return;
      this.restartAttempts++;
      void this.offer(true).catch(() => {});
      this.armConnectWatchdog();
    }, delay);
    // Node (tests) should not wait on this timer; browsers return a number.
    (this.connectTimer as { unref?: () => void }).unref?.();
  }

  connectionStateChanged() {
    if (!this.active()) return;
    if (this.pc.connectionState === 'connected') {
      this.restartAttempts = 0;
      this.clearRecoveryTimer();
      this.clearConnectTimer();
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

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  dispose() {
    this.disposed = true;
    this.clearRecoveryTimer();
    this.clearConnectTimer();
    if (this.firstOfferTimer) clearTimeout(this.firstOfferTimer);
    this.firstOfferTimer = undefined;
    this.candidates = [];
  }
}
