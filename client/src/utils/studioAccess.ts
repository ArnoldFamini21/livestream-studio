import type { Participant } from '@studio/shared';

type ParticipantAccess = Pick<Participant, 'role' | 'status'> | null | undefined;

export function isStudioOperator(participant: Pick<Participant, 'role'> | null | undefined): boolean {
  return participant?.role === 'host' || participant?.role === 'co-host';
}

export function canUseAdmittedOperatorControls(participant: ParticipantAccess): boolean {
  return isStudioOperator(participant) && participant?.status !== 'green-room';
}

export function canControlStudioRecording(participant: ParticipantAccess): boolean {
  return canUseAdmittedOperatorControls(participant);
}
