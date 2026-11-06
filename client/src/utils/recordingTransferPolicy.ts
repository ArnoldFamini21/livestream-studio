import type { Participant, RoomJoinedPayload } from '@studio/shared';

/**
 * Who takes part in peer-to-peer recording transfers, and how much one
 * participant may write into the host's recording folder.
 *
 * Only admitted participants (never the private green room) are invited, and
 * the host answers offers only from participants it invited. A guest whose
 * seat was resumed (reload, dropped socket) asks the operators for a fresh
 * invite, since the host only invites each participant id once and an invite
 * sent while the seat was held never arrived.
 */

type InviteCandidate = Pick<Participant, 'role' | 'status'>;

const isOperatorRole = (role: Participant['role']) => role === 'host' || role === 'co-host';

/** Participants the host collects recordings from: admitted, non-operator seats. */
export function isTransferParticipant(participant: InviteCandidate | null | undefined): boolean {
  if (!participant) return false;
  return !isOperatorRole(participant.role) && participant.status !== 'green-room';
}

/** Participant ids that should get an invite now (not invited yet, admitted). */
export function participantsToInvite(
  participants: Iterable<Participant>,
  invited: { has(id: string): boolean },
): string[] {
  const ids: string[] = [];
  for (const participant of participants) {
    if (isTransferParticipant(participant) && !invited.has(participant.id)) ids.push(participant.id);
  }
  return ids;
}

/** Invited ids whose seat is gone or went back to the green room. */
export function invitesToRevoke(
  participants: { get(id: string): Participant | undefined },
  invited: Iterable<string>,
): string[] {
  const ids: string[] = [];
  for (const id of invited) {
    if (!isTransferParticipant(participants.get(id))) ids.push(id);
  }
  return ids;
}

/**
 * Guest: operators to ask for a fresh invite after this room-joined. Only a
 * resumed seat needs it; a new seat gets a new id that the host invites
 * when it sees the participant join.
 */
export function readyRequestTargets(payload: Pick<RoomJoinedPayload, 'participant' | 'participants' | 'resumed'>): string[] {
  if (!payload.resumed || !isTransferParticipant(payload.participant)) return [];
  return payload.participants
    .filter((participant) => participant.id !== payload.participant.id && isOperatorRole(participant.role) && participant.status !== 'green-room')
    .map((participant) => participant.id);
}

export interface TransferLimits {
  /** Distinct tracks one participant may announce. */
  maxTracks: number;
  /** Distinct recording sessions (take folders) one participant may write into. */
  maxSessions: number;
  /** Bytes one participant may write into the host's folder. */
  maxBytes: number;
}

/**
 * Generous for real shows (a camera track at 8.5 Mbps for four hours is about
 * 15 GB; segments after device changes add tracks), small enough that one
 * participant cannot fill the host's drive with arbitrary files.
 */
export const DEFAULT_TRANSFER_LIMITS: TransferLimits = {
  maxTracks: 64,
  maxSessions: 8,
  maxBytes: 64 * 1024 ** 3,
};

interface AdmissionEntry {
  id: string;
  participantId: string;
  announcement: { sessionId: string };
}

/** Why a new track from this participant is refused, or null to accept it. */
export function trackAdmissionError(
  entries: Iterable<AdmissionEntry>,
  participantId: string,
  track: { id: string; sessionId: string },
  limits: TransferLimits = DEFAULT_TRANSFER_LIMITS,
): string | null {
  let tracks = 0;
  const sessions = new Set<string>();
  for (const entry of entries) {
    if (entry.id === track.id) return null;
    if (entry.participantId !== participantId) continue;
    tracks += 1;
    sessions.add(entry.announcement.sessionId);
  }
  if (tracks >= limits.maxTracks) return 'The host is not accepting more tracks from this participant.';
  if (!sessions.has(track.sessionId) && sessions.size >= limits.maxSessions) {
    return 'The host is not accepting tracks from more recordings for this participant.';
  }
  return null;
}
