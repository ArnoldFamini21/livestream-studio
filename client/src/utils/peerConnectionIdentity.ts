import type { PeerConnectionRef } from '@studio/shared';

/**
 * Which RTCPeerConnection a signaling message belongs to.
 *
 * A participant keeps their id across a page reload now (their seat is
 * resumed), so the other side cannot tell from the id alone that the
 * connection behind it is brand new. Every offer, answer and candidate
 * carries the sender's connection id (pcId) and the receiver's connection id
 * the sender is talking to (toPcId):
 *
 * - aimed at a connection we already replaced: ignore it (our new connection
 *   sends its own offer);
 * - an offer from a connection we have not seen, while ours is established:
 *   the other side rebuilt, so we rebuild too and answer from a fresh one;
 * - candidates from a connection whose offer/answer is still being applied:
 *   keep them until it is.
 * Messages without ids (an older client) are handled as before.
 */

export interface LocalConnectionView {
  pcId: string;
  remotePcId: string | null;
  hasLocalDescription: boolean;
  hasRemoteDescription: boolean;
}

export type OfferDecision =
  | { action: 'ignore'; kickStart: boolean }
  | { action: 'rebuild'; remotePcId: string }
  | { action: 'accept'; remotePcId: string | null };

export function decideIncomingOffer(ref: PeerConnectionRef, local: LocalConnectionView): OfferDecision {
  if (ref.toPcId && ref.toPcId !== local.pcId) {
    // A fresh connection that has not negotiated yet must make sure it offers.
    return { action: 'ignore', kickStart: !local.hasLocalDescription && !local.hasRemoteDescription };
  }
  if (ref.pcId && local.remotePcId && ref.pcId !== local.remotePcId) {
    return local.hasRemoteDescription
      ? { action: 'rebuild', remotePcId: ref.pcId }
      : { action: 'accept', remotePcId: ref.pcId };
  }
  return { action: 'accept', remotePcId: ref.pcId || local.remotePcId };
}

export type AnswerDecision = { action: 'ignore' } | { action: 'accept'; remotePcId: string | null };

export function decideIncomingAnswer(ref: PeerConnectionRef, local: LocalConnectionView): AnswerDecision {
  if (ref.toPcId && ref.toPcId !== local.pcId) return { action: 'ignore' };
  if (ref.pcId && local.remotePcId && ref.pcId !== local.remotePcId && local.hasRemoteDescription) {
    return { action: 'ignore' };
  }
  return { action: 'accept', remotePcId: ref.pcId || local.remotePcId };
}

export type CandidateDecision = 'apply' | 'buffer' | 'ignore';

export function decideIncomingCandidate(ref: PeerConnectionRef, local: Pick<LocalConnectionView, 'pcId' | 'remotePcId'>): CandidateDecision {
  if (ref.toPcId && ref.toPcId !== local.pcId) return 'ignore';
  if (ref.pcId && ref.pcId !== local.remotePcId) return 'buffer';
  return 'apply';
}
