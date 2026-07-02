import type { LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import type { SavedBrandKit } from './brandKits.ts';
import type { SavedHostStudio } from './hostSession.ts';
import type { SavedWorkspaceTeamMember } from './workspaceTeam.ts';

export interface WorkspaceDashboardSummary {
  totalStudios: number;
  upcomingStudios: number;
  readyStudios: number;
  passwordProtectedStudios: number;
  totalRecordings: number;
  totalRecordingTracks: number;
  totalRecordingBytes: number;
  totalRecordingDurationSeconds: number;
  cloudRecordingCount: number;
  totalBrandKits: number;
  brandKitsWithLogo: number;
  brandKitsWithBackground: number;
  totalTeamMembers: number;
  productionTeamMembers: number;
  latestStudio: Pick<SavedHostStudio, 'id' | 'name' | 'hostName' | 'createdAt' | 'scheduledFor'> | null;
  latestRecording: Pick<LocalRecordingSession, 'id' | 'roomName' | 'createdAt'> | null;
  latestBrandKit: Pick<SavedBrandKit, 'id' | 'name' | 'createdAt'> | null;
  latestTeamMember: Pick<SavedWorkspaceTeamMember, 'id' | 'name' | 'role' | 'createdAt'> | null;
}

function getStudioTime(studio: SavedHostStudio): number {
  const scheduledAt = Date.parse(studio.scheduledFor || '');
  if (Number.isFinite(scheduledAt)) return scheduledAt;
  const createdAt = Date.parse(studio.createdAt || '');
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function getCreatedAtTime(value: { createdAt?: string }): number {
  const createdAt = Date.parse(value.createdAt || '');
  return Number.isFinite(createdAt) ? createdAt : 0;
}

export function buildWorkspaceDashboardSummary(
  studios: SavedHostStudio[],
  recordings: LocalRecordingSession[],
  brandKits: SavedBrandKit[],
  teamMembersOrNowMs: SavedWorkspaceTeamMember[] | number = [],
  maybeNowMs = Date.now()
): WorkspaceDashboardSummary {
  const teamMembers = Array.isArray(teamMembersOrNowMs) ? teamMembersOrNowMs : [];
  const nowMs = typeof teamMembersOrNowMs === 'number' ? teamMembersOrNowMs : maybeNowMs;
  const latestStudio = studios.reduce<SavedHostStudio | null>((latest, studio) => {
    if (!latest) return studio;
    return getStudioTime(studio) > getStudioTime(latest) ? studio : latest;
  }, null);
  const latestRecording = recordings.reduce<LocalRecordingSession | null>((latest, recording) => {
    if (!latest) return recording;
    return getCreatedAtTime(recording) > getCreatedAtTime(latest) ? recording : latest;
  }, null);
  const latestBrandKit = brandKits.reduce<SavedBrandKit | null>((latest, kit) => {
    if (!latest) return kit;
    return getCreatedAtTime(kit) > getCreatedAtTime(latest) ? kit : latest;
  }, null);
  const latestTeamMember = teamMembers.reduce<SavedWorkspaceTeamMember | null>((latest, member) => {
    if (!latest) return member;
    return getCreatedAtTime(member) > getCreatedAtTime(latest) ? member : latest;
  }, null);

  return {
    totalStudios: studios.length,
    upcomingStudios: studios.filter((studio) => {
      const scheduledAt = Date.parse(studio.scheduledFor || '');
      return Number.isFinite(scheduledAt) && scheduledAt > nowMs;
    }).length,
    readyStudios: studios.filter((studio) => {
      const scheduledAt = Date.parse(studio.scheduledFor || '');
      return !Number.isFinite(scheduledAt) || scheduledAt <= nowMs;
    }).length,
    passwordProtectedStudios: studios.filter((studio) => studio.passwordProtected).length,
    totalRecordings: recordings.length,
    totalRecordingTracks: recordings.reduce((total, recording) => total + recording.trackCount, 0),
    totalRecordingBytes: recordings.reduce((total, recording) => total + recording.totalBytes, 0),
    totalRecordingDurationSeconds: Math.round(recordings.reduce((total, recording) => {
      if (!Number.isFinite(recording.durationSeconds)) return total;
      return total + Math.max(0, Number(recording.durationSeconds));
    }, 0)),
    cloudRecordingCount: recordings.filter((recording) => Boolean(recording.cloud)).length,
    totalBrandKits: brandKits.length,
    brandKitsWithLogo: brandKits.filter((kit) => Boolean(kit.logoUrl)).length,
    brandKitsWithBackground: brandKits.filter((kit) => kit.stageBackground.type !== 'none' && Boolean(kit.stageBackground.value)).length,
    totalTeamMembers: teamMembers.length,
    productionTeamMembers: teamMembers.filter((member) => member.role === 'owner' || member.role === 'producer').length,
    latestStudio: latestStudio
      ? {
          id: latestStudio.id,
          name: latestStudio.name,
          hostName: latestStudio.hostName,
          createdAt: latestStudio.createdAt,
          scheduledFor: latestStudio.scheduledFor,
        }
      : null,
    latestRecording: latestRecording
      ? {
          id: latestRecording.id,
          roomName: latestRecording.roomName,
          createdAt: latestRecording.createdAt,
        }
      : null,
    latestBrandKit: latestBrandKit
      ? {
          id: latestBrandKit.id,
          name: latestBrandKit.name,
          createdAt: latestBrandKit.createdAt,
        }
      : null,
    latestTeamMember: latestTeamMember
      ? {
          id: latestTeamMember.id,
          name: latestTeamMember.name,
          role: latestTeamMember.role,
          createdAt: latestTeamMember.createdAt,
        }
      : null,
  };
}

export function formatWorkspaceFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatWorkspaceDuration(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const totalSeconds = Math.max(0, Math.round(Number(seconds)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}
