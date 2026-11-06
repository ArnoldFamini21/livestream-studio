export interface PeerRecoveryOptions {
  /** Longest wait between ICE restarts. */
  maxRecoveryDelayMs?: number;
  /** ICE restarts without reconnecting before the connection is rebuilt from scratch. */
  rebuildAfterAttempts?: number;
  /** Called once when ICE restarts are not enough; the owner replaces the connection. */
  onRecoveryExhausted?: () => void;
  /** An unanswered restart offer younger than this is left alone rather than rolled back. */
  minRollbackAgeMs?: number;
}

/**
 * Delay before ICE restart number `attempt` (0-based): doubles from the base
 * delay up to the cap, and never stops. A long outage (an ISP blip, a laptop
 * lid) keeps being retried instead of leaving the tile "reconnecting" forever.
 */
export function getIceRestartDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponent = Math.max(0, Math.min(attempt, 16));
  return Math.min(maxDelayMs, Math.max(0, baseDelayMs) * 2 ** exponent);
}

/**
 * The polite side does not restart ICE itself while the impolite side is
 * doing it: two simultaneous restart offers collide, the polite side rolls
 * back, and Chrome can stop gathering for that session. It only steps in
 * (later, and only if no restart offer arrived) when the other side seems to
 * have stalled, e.g. it never noticed the failure.
 */
export function getPoliteRecoveryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return getIceRestartDelayMs(attempt, baseDelayMs, maxDelayMs) * 2 + baseDelayMs;
}

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
  private lastLocalOfferAt = 0;
  /** A restart offer from the other side arrived since the polite watch was armed. */
  private remoteOfferSinceWatch = false;
  private exhausted = false;
  private readonly maxRecoveryDelayMs: number;
  private readonly rebuildAfterAttempts: number;
  private readonly minRollbackAgeMs: number;
  private readonly onRecoveryExhausted?: () => void;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly polite: boolean,
    private readonly send: (description: RTCSessionDescriptionInit) => void,
    private readonly isCurrent: () => boolean,
    private readonly recoveryDelayMs = 5_000,
    private readonly connectTimeoutMs = 10_000,
    private readonly firstOfferDelayMs = 1_500,
    options: PeerRecoveryOptions = {},
  ) {
    this.maxRecoveryDelayMs = options.maxRecoveryDelayMs ?? 60_000;
    this.rebuildAfterAttempts = options.rebuildAfterAttempts ?? 3;
    this.minRollbackAgeMs = options.minRollbackAgeMs ?? 3_000;
    this.onRecoveryExhausted = options.onRecoveryExhausted;
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

  /**
   * Begin a new connection. The impolite side offers now; the polite side
   * waits for the other side's offer (see deferFirstOffer). Both sides open
   * the connection at the same moment, so offering from both made the polite
   * side take its offer back, which is what left Chrome gathering no candidates.
   */
  start() {
    if (this.polite && !this.pc.remoteDescription) {
      this.deferFirstOffer();
      return Promise.resolve();
    }
    return this.offer();
  }

  offer(iceRestart = false) {
    return this.enqueue(async () => {
      if (this.pc.signalingState === 'have-local-offer' && iceRestart) {
        // An answer to a restart offer takes a round trip over signaling, which
        // is slow between continents: leave a young offer alone rather than
        // cancel the restart that is about to work.
        if (Date.now() - this.lastLocalOfferAt < this.minRollbackAgeMs) return;
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
        this.lastLocalOfferAt = Date.now();
        if (this.active() && this.pc.localDescription) this.send(this.pc.localDescription);
      } finally {
        this.makingOffer = false;
      }
    });
  }

  receiveOffer(sdp: RTCSessionDescriptionInit) {
    this.remoteOfferSinceWatch = true;
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
    if (this.restartAttempts >= 2) {
      // Two fresh gatherings did not help: rebuild the connection. The polite
      // side waits longer, so normally the other side rebuilds first.
      this.connectTimer = setTimeout(() => {
        this.connectTimer = undefined;
        if (this.active() && this.pc.connectionState === 'new') this.exhaust();
      }, this.polite ? this.connectTimeoutMs * 3 : this.connectTimeoutMs);
      (this.connectTimer as { unref?: () => void }).unref?.();
      return;
    }
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

  /**
   * ICE restarts with exponential backoff, for as long as the connection is
   * down. Only the impolite side restarts (no glare); the polite side watches
   * and steps in only when no restart offer arrives. After a few attempts the
   * owner rebuilds the connection from scratch.
   */
  private scheduleRecovery() {
    if (this.recoveryTimer || this.exhausted) return;
    const attempt = this.restartAttempts;
    const delay = this.polite
      ? getPoliteRecoveryDelayMs(attempt, this.recoveryDelayMs, this.maxRecoveryDelayMs)
      : getIceRestartDelayMs(attempt, this.recoveryDelayMs, this.maxRecoveryDelayMs);
    this.remoteOfferSinceWatch = false;
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = undefined;
      if (!this.active() || this.pc.connectionState === 'connected') return;
      this.restartAttempts++;
      if (this.restartAttempts > this.rebuildAfterAttempts && this.onRecoveryExhausted) {
        this.exhaust();
        return;
      }
      if (this.polite && this.remoteOfferSinceWatch) {
        // The other side is restarting; keep watching rather than collide.
        this.scheduleRecovery();
        return;
      }
      try { await this.offer(true); } catch { /* Keep the stream while retrying. */ }
      if (this.active() && (this.pc.connectionState as RTCPeerConnectionState) !== 'connected') this.scheduleRecovery();
    }, delay);
    (this.recoveryTimer as { unref?: () => void }).unref?.();
  }

  private exhaust() {
    if (this.exhausted || !this.onRecoveryExhausted) return;
    this.exhausted = true;
    this.clearRecoveryTimer();
    this.clearConnectTimer();
    this.onRecoveryExhausted();
  }

  /**
   * The network came back (an 'online' event) or a relay server became
   * available: try now instead of waiting out the backoff.
   */
  restartNow() {
    if (!this.active() || this.pc.connectionState === 'connected' || this.exhausted) return;
    this.clearRecoveryTimer();
    if (this.polite) {
      this.scheduleRecovery();
      return;
    }
    void this.offer(true)
      .catch(() => {})
      .finally(() => {
        if (this.active() && this.pc.connectionState !== 'connected') this.scheduleRecovery();
      });
  }

  /** How many ICE restarts were made since the connection was last up. */
  get recoveryAttempts() {
    return this.restartAttempts;
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
