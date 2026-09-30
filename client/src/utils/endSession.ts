import type { RecordingUploadProgressPayload } from '@studio/shared';

/**
 * Ending a session closes the studio for everyone, stops any broadcast, and
 * cuts off recordings still being saved. The host confirms first, a running
 * recording is stopped and saved, and guests' recordings get time to finish
 * uploading before the room closes.
 */

/** Longest the host waits for guests' recordings before the room closes anyway. */
export const END_SESSION_UPLOAD_WAIT_MS = 120_000;

export interface EndSessionState {
  isLive: boolean;
  isRecording: boolean;
  /** Everyone in the studio except you, including the green room. */
  otherParticipantCount: number;
}

export interface EndSessionPrompt {
  title: string;
  message: string;
  confirmLabel: string;
}

export function getEndSessionPrompt(state: EndSessionState): EndSessionPrompt {
  const others = state.otherParticipantCount;
  const people = others === 1 ? '1 other person' : `${others} other people`;
  const everyoneLeaves = others > 0 ? ` The ${people} in the studio will leave too.` : '';

  if (state.isLive && state.isRecording) {
    return {
      title: 'End the broadcast and the recording?',
      message: `Your destinations go offline and the recording is stopped and saved first.${everyoneLeaves}`,
      confirmLabel: 'End broadcast',
    };
  }
  if (state.isLive) {
    return {
      title: 'End the broadcast?',
      message: `Your destinations go offline.${everyoneLeaves}`,
      confirmLabel: 'End broadcast',
    };
  }
  if (state.isRecording) {
    return {
      title: 'Stop recording and end the session?',
      message: `The recording is stopped and saved first, and guests' recordings finish uploading before the studio closes.${everyoneLeaves}`,
      confirmLabel: 'Save and end',
    };
  }
  return {
    title: 'End the session?',
    message: others > 0 ? `The studio closes for everyone.${everyoneLeaves}` : 'The studio closes.',
    confirmLabel: 'End session',
  };
}

const PENDING_UPLOAD_STATUSES = new Set<RecordingUploadProgressPayload['status']>(['uploading', 'paused', 'finishing']);

/**
 * Guests still sending their recording of `sessionId`. Someone who has left
 * cannot finish from this room, so only people still here are waited for.
 */
export function getPendingGuestUploads(
  uploads: Record<string, RecordingUploadProgressPayload>,
  sessionId: string | null,
  presentParticipantIds: ReadonlySet<string>
): RecordingUploadProgressPayload[] {
  if (!sessionId) return [];
  return Object.entries(uploads)
    .filter(([participantId, report]) => (
      report.sessionId === sessionId
      && PENDING_UPLOAD_STATUSES.has(report.status)
      && presentParticipantIds.has(participantId)
    ))
    .map(([, report]) => report);
}

export function describePendingGuestUploads(pending: RecordingUploadProgressPayload[]): string {
  if (pending.length === 0) return 'Every guest recording is uploaded.';
  const names = pending.map((report) => report.participantName || 'A guest');
  const who = names.length === 1
    ? `${names[0]}'s recording is`
    : names.length === 2
      ? `${names[0]}'s and ${names[1]}'s recordings are`
      : `${names.length} guests' recordings are`;
  return `${who} still uploading. The studio closes as soon as they finish, so nothing is lost.`;
}
