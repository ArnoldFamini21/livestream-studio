export const RECORDING_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECORDING_RECOVERY_CHUNK_BYTES = 16 * 1024 * 1024;
export const RECORDING_RECOVERY_IDENTIFIER = /^[A-Za-z0-9_-]{1,120}$/;
export const RECORDING_RECOVERY_SHA256 = /^[a-f0-9]{64}$/;

export interface RecordingRecoveryParticipant {
  participantId: string;
  participantName: string;
}

export interface RecordingRecoveryTrackInput {
  trackId: string;
  label: string;
  kind: string;
  mimeType: string;
}

export interface RecordingRecoveryTrack extends RecordingRecoveryTrackInput, RecordingRecoveryParticipant {
  receivedBytes: number;
  nextSequence: number;
  status: 'uploading' | 'verified';
  totalBytes?: number;
  capture?: Record<string, unknown>;
}

export interface RecordingRecoveryTake {
  roomId: string;
  takeId: string;
  expiresAt: string;
  participants: RecordingRecoveryParticipant[];
  tracks: RecordingRecoveryTrack[];
}

export interface RecordingRecoveryUploadStatus {
  expiresAt: string;
  tracks: RecordingRecoveryTrack[];
}

export interface RecordingRecoveryGrant {
  roomId: string;
  takeId: string;
  participantId: string;
  token: string;
  expiresAt: string;
}

export type RecordingRecoveryState = {
  takeId: string;
} & ({ status: 'ready'; expiresAt: string } | { status: 'unavailable' });

interface RecoveryTokenScope {
  v: 1;
  roomId: string;
  takeId: string;
  storageId: string;
  exp: number;
}

export interface RecordingRecoveryCreateClaims extends RecoveryTokenScope {
  purpose: 'recording-recovery-create';
}

export interface RecordingRecoveryUploadClaims extends RecoveryTokenScope {
  purpose: 'recording-recovery-upload';
  participantId: string;
}

/** Both services derive the opaque key from the same original host credential. */
export function recordingRecoveryHostScope(roomId: string, takeId: string, hostToken: string): string {
  return JSON.stringify(['recording-recovery', roomId, takeId, hostToken]);
}
