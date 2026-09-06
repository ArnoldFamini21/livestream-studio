import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { StudioIcon } from './StudioIcon.tsx';
import { WorkspaceDialog } from './WorkspaceDialog.tsx';
import '../styles/workspace.css';
import { buildStudioCalendarInvite, type AccountUser, type BrandKitCatalogEntry, type RecordingCatalogEntry, type RoomRegistrantListResponse, type WorkspaceStudioCatalogEntry, type WorkspaceTeamCatalogMember } from '@studio/shared';
import {
  buildHostEntryPath,
  buildHostEntryUrl,
  getValidHostToken,
  HOST_STUDIOS_STORAGE_KEY,
  persistLegacyHostSession,
  persistHostSession,
  readSavedHostStudios,
  removeSavedHostStudio,
  upsertSavedHostStudio,
  type SavedHostStudio,
} from '../utils/hostSession.ts';
import { getApiErrorMessage, getJson, postJson } from '../utils/apiClient.ts';
import {
  fetchAccountSession,
  loginAccount,
  logoutAccount,
  registerAccount,
} from '../utils/accountAuth.ts';
import {
  hasCreatedRoomDetails,
  resolveCreatedRoomHostAccess,
  type CreatedRoomResponse,
} from '../utils/hostAccess.ts';
import { buildRegistrantsCsv } from '../utils/webinarRegistration.ts';
import { buildGuestInviteEmailHref, buildGuestInviteUrl, buildGuestPreparationSheet } from '../utils/inviteLinks.ts';
import { useRecordingLibrary, type LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import {
  BRAND_KIT_STORAGE_KEY,
  parseSavedBrandKits,
  serializeSavedBrandKits,
  type SavedBrandKit,
} from '../utils/brandKits.ts';
import {
  buildWorkspaceDashboardSummary,
  buildWorkspaceRecordingDashboardItems,
  formatWorkspaceDuration,
  formatWorkspaceFileSize,
  getWorkspaceRecordingExportLabel,
  getWorkspaceRecordingExportState,
  type WorkspaceDashboardRecording,
} from '../utils/workspaceDashboard.ts';
import { fetchRecordingCatalog } from '../utils/recordingCatalog.ts';
import {
  catalogEntryToSavedBrandKit,
  fetchBrandKitCatalog,
} from '../utils/brandKitCatalog.ts';
import {
  deleteAccountWorkspaceStudioCatalogEntry,
  deleteWorkspaceStudioCatalogEntry,
  fetchAccountWorkspaceStudioCatalog,
  fetchWorkspaceStudioCatalog,
  mergeWorkspaceStudioCatalogEntries,
  syncAccountWorkspaceStudioCatalogEntry,
  syncWorkspaceStudioCatalogEntry,
} from '../utils/workspaceStudioCatalog.ts';
import {
  deleteWorkspaceTeamCatalogMember,
  fetchWorkspaceTeamCatalog,
  mergeWorkspaceTeamCatalogMembers,
  syncWorkspaceTeamCatalogMember,
} from '../utils/workspaceTeamCatalog.ts';
import {
  buildWorkspaceBackup,
  mergeWorkspaceBackup,
  parseWorkspaceBackupJson,
  serializeWorkspaceBackup,
} from '../utils/workspaceBackup.ts';
import {
  WORKSPACE_TEAM_STORAGE_KEY,
  buildWorkspaceTeamStudioCallSheet,
  buildWorkspaceTeamStudioInviteEmailHref,
  createWorkspaceTeamMember,
  getWorkspaceTeamRoleLabel,
  parseSavedWorkspaceTeamMembers,
  removeWorkspaceTeamMember,
  serializeWorkspaceTeamMembers,
  upsertWorkspaceTeamMember,
  type SavedWorkspaceTeamMember,
  type WorkspaceTeamRole,
} from '../utils/workspaceTeam.ts';

const INVITE_BASE_URL = import.meta.env.VITE_INVITE_BASE_URL || window.location.origin;
const CREATE_STUDIO_TIMEOUT_MS = 90_000;
const SERVER_WAKE_NOTICE_DELAY_MS = 6_000;
const SAVED_HOST_ACCESS_MISSING_MESSAGE = 'Host access is missing for this studio. Create a new studio to get a fresh private host link.';
const INVITE_QR_OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 220,
  color: {
    dark: '#0f172a',
    light: '#ffffff',
  },
} as const;

interface SavedScheduledStudio extends SavedHostStudio {
  name: string;
  createdAt: string;
  passwordProtected: boolean;
  registrationEnabled?: boolean;
}

interface ScheduledRoomModal extends SavedScheduledStudio {}

function toDateTimeLocalValue(date: Date): string {
  const timezoneOffsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - timezoneOffsetMs).toISOString().slice(0, 16);
}

function toSavedScheduledStudios(studios: SavedHostStudio[]): SavedScheduledStudio[] {
  return studios
    .filter((item): item is SavedScheduledStudio => (
      typeof item.name === 'string' &&
      typeof item.createdAt === 'string'
    ))
    .map((item) => ({
      ...item,
      passwordProtected: Boolean(item.passwordProtected),
      registrationEnabled: Boolean(item.registrationEnabled),
    }));
}

function readSavedScheduledStudios(): SavedScheduledStudio[] {
  return toSavedScheduledStudios(readSavedHostStudios());
}

function readSavedBrandKitLibrary(): SavedBrandKit[] {
  try {
    return parseSavedBrandKits(localStorage.getItem(BRAND_KIT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeSavedBrandKitLibrary(kits: SavedBrandKit[]) {
  try {
    localStorage.setItem(BRAND_KIT_STORAGE_KEY, serializeSavedBrandKits(kits));
    return true;
  } catch {
    return false;
  }
}

function readSavedWorkspaceTeamLibrary(): SavedWorkspaceTeamMember[] {
  try {
    return parseSavedWorkspaceTeamMembers(localStorage.getItem(WORKSPACE_TEAM_STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeSavedWorkspaceTeamLibrary(members: SavedWorkspaceTeamMember[]) {
  try {
    localStorage.setItem(WORKSPACE_TEAM_STORAGE_KEY, serializeWorkspaceTeamMembers(members));
    return true;
  } catch {
    return false;
  }
}

function writeSavedHostStudioLibrary(studios: SavedHostStudio[]) {
  try {
    localStorage.setItem(HOST_STUDIOS_STORAGE_KEY, JSON.stringify(studios));
    return true;
  } catch {
    return false;
  }
}

function upsertSavedScheduledStudio(room: SavedScheduledStudio): SavedScheduledStudio[] {
  upsertSavedHostStudio(room);
  return readSavedScheduledStudios();
}

function removeSavedScheduledStudio(roomId: string): SavedScheduledStudio[] {
  removeSavedHostStudio(roomId);
  return readSavedScheduledStudios();
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }
}

function downloadTextFile(text: string, fileName: string, type: string) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadDataUrl(dataUrl: string, fileName: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  link.click();
}

function createInviteQrDataUrl(inviteUrl: string): Promise<string> {
  return QRCode.toDataURL(inviteUrl, INVITE_QR_OPTIONS);
}

function safeFileName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'studio';
}

function formatScheduledDate(value?: string): string {
  if (!value) return 'Unscheduled';
  return new Date(value).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatDashboardDate(value?: string): string {
  if (!value) return 'Unscheduled';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unscheduled';
  return new Date(timestamp).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getScheduleState(room: SavedScheduledStudio): string {
  if (!room.scheduledFor) return 'Ready';
  const scheduledAt = Date.parse(room.scheduledFor);
  if (!Number.isFinite(scheduledAt)) return 'Ready';
  return scheduledAt > Date.now() ? 'Upcoming' : 'Ready';
}

function toSavedScheduledRoom(
  room: CreatedRoomResponse & { id: string; name: string },
  hostName: string,
  hostToken: string
): ScheduledRoomModal {
  return {
    id: room.id,
    name: room.name,
    hostName,
    hostToken,
    createdAt: room.createdAt || new Date().toISOString(),
    scheduledFor: room.scheduledFor || undefined,
    passwordProtected: Boolean(room.settings?.passwordProtected),
    registrationEnabled: Boolean(room.registration?.enabled),
    status: room.status,
  };
}

export function HomePage() {
  const [workspaceParams, setWorkspaceParams] = useSearchParams();
  type WorkspaceView = 'studios' | 'recordings' | 'brand' | 'team' | 'settings';
  const requestedView = workspaceParams.get('view');
  const workspaceView: WorkspaceView = requestedView === 'recordings' || requestedView === 'brand' || requestedView === 'team' || requestedView === 'settings' ? requestedView : 'studios';
  const setWorkspaceView = (view: WorkspaceView) => {
    setWorkspaceParams(previous => {
      const next = new URLSearchParams(previous);
      if (view === 'studios') next.delete('view');
      else next.set('view', view);
      return next;
    });
  };
  const [showCreate, setShowCreate] = useState(false);
  const [studioSearch, setStudioSearch] = useState('');
  const [downloadingRecordingId, setDownloadingRecordingId] = useState<string | null>(null);
  const [studioFilter, setStudioFilter] = useState<'all' | 'upcoming'>('all');
  const [roomName, setRoomName] = useState('');
  const [hostName, setHostName] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [schedulingLoading, setSchedulingLoading] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [savedScheduledRooms, setSavedScheduledRooms] = useState<SavedScheduledStudio[]>(() => readSavedScheduledStudios());
  const [savedBrandKits, setSavedBrandKits] = useState<SavedBrandKit[]>(() => readSavedBrandKitLibrary());
  const [savedTeamMembers, setSavedTeamMembers] = useState<SavedWorkspaceTeamMember[]>(() => readSavedWorkspaceTeamLibrary());
  const [teamMemberName, setTeamMemberName] = useState('');
  const [teamMemberEmail, setTeamMemberEmail] = useState('');
  const [teamMemberRole, setTeamMemberRole] = useState<WorkspaceTeamRole>('producer');
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardNotice, setDashboardNotice] = useState<string | null>(null);
  const [accountUser, setAccountUser] = useState<AccountUser | null>(null);
  const [accountSessionExpiresAt, setAccountSessionExpiresAt] = useState('');
  const [accountMode, setAccountMode] = useState<'login' | 'register'>('register');
  const [accountName, setAccountName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [serverWorkspaceStudioCatalog, setServerWorkspaceStudioCatalog] = useState<WorkspaceStudioCatalogEntry[]>([]);
  const [serverWorkspaceStudioCatalogLoading, setServerWorkspaceStudioCatalogLoading] = useState(false);
  const [serverWorkspaceStudioCatalogError, setServerWorkspaceStudioCatalogError] = useState<string | null>(null);
  const [accountWorkspaceStudioCatalog, setAccountWorkspaceStudioCatalog] = useState<WorkspaceStudioCatalogEntry[]>([]);
  const [accountWorkspaceStudioCatalogLoading, setAccountWorkspaceStudioCatalogLoading] = useState(false);
  const [accountWorkspaceStudioCatalogError, setAccountWorkspaceStudioCatalogError] = useState<string | null>(null);
  const [serverRecordingCatalog, setServerRecordingCatalog] = useState<RecordingCatalogEntry[]>([]);
  const [serverRecordingCatalogLoading, setServerRecordingCatalogLoading] = useState(false);
  const [serverRecordingCatalogError, setServerRecordingCatalogError] = useState<string | null>(null);
  const [serverBrandKitCatalog, setServerBrandKitCatalog] = useState<BrandKitCatalogEntry[]>([]);
  const [serverBrandKitCatalogLoading, setServerBrandKitCatalogLoading] = useState(false);
  const [serverBrandKitCatalogError, setServerBrandKitCatalogError] = useState<string | null>(null);
  const [serverWorkspaceTeamCatalog, setServerWorkspaceTeamCatalog] = useState<WorkspaceTeamCatalogMember[]>([]);
  const [serverWorkspaceTeamCatalogLoading, setServerWorkspaceTeamCatalogLoading] = useState(false);
  const [serverWorkspaceTeamCatalogError, setServerWorkspaceTeamCatalogError] = useState<string | null>(null);
  const navigate = useNavigate();
  const recordingLibrary = useRecordingLibrary();
  const workspaceImportInputRef = useRef<HTMLInputElement | null>(null);
  const lastWorkspaceStudioCatalogSyncKey = useRef('');
  const lastAccountWorkspaceStudioCatalogSyncKey = useRef('');

  const [error, setError] = useState<string | null>(null);

  // Invite link modal state
  const [scheduledRoom, setScheduledRoom] = useState<ScheduledRoomModal | null>(null);
  const [copied, setCopied] = useState(false);
  const [hostCopied, setHostCopied] = useState(false);
  const [scheduledQrDataUrl, setScheduledQrDataUrl] = useState('');
  const [scheduledQrError, setScheduledQrError] = useState('');
  const [savedRoomCopiedId, setSavedRoomCopiedId] = useState<string | null>(null);
  const [savedHostCopiedId, setSavedHostCopiedId] = useState<string | null>(null);
  const [savedQrDownloadingId, setSavedQrDownloadingId] = useState<string | null>(null);
  const [registrantsDownloadingId, setRegistrantsDownloadingId] = useState<string | null>(null);

  const createRoom = async () => {
    if (!roomName.trim() || !hostName.trim()) return;
    setLoading(true);
    setError(null);
    setProgressMessage(null);
    const progressTimer = window.setTimeout(() => {
      setProgressMessage('Still creating. The studio server is waking up and may need a moment.');
    }, SERVER_WAKE_NOTICE_DELAY_MS);

    try {
      const createdRoom = await postJson<CreatedRoomResponse>('/api/rooms', {
        name: roomName,
        hostName,
        password: roomPassword.trim() || undefined,
        registrationEnabled,
      }, {
        timeoutMs: CREATE_STUDIO_TIMEOUT_MS,
      });
      if (!hasCreatedRoomDetails(createdRoom)) {
        setError('Studio was created, but room details were incomplete. Please create a new studio.');
        return;
      }
      const { room } = await resolveCreatedRoomHostAccess(createdRoom, {
        preferLegacyFallback: true,
        recoverBeforeLegacyFallback: false,
      });
      const savedHostName = room.hostName || hostName;
      const hostToken = getValidHostToken(room.hostToken);
      if (!hostToken) {
        persistLegacyHostSession({ roomId: room.id, hostName: savedHostName });
        navigate(buildHostEntryPath(room.id));
        return;
      }
      // Scoped per room so old tokens don't leak across rooms.
      persistHostSession({ roomId: room.id, hostName: savedHostName, hostToken });
      const savedRoom = toSavedScheduledRoom(room, savedHostName, hostToken);
      const nextStudios = upsertSavedScheduledStudio(savedRoom);
      setSavedScheduledRooms(nextStudios);
      void syncWorkspaceStudiosToSavedStudios(nextStudios, nextStudios);
      navigate(buildHostEntryPath(room.id, hostToken));
    } catch (err) {
      console.error('Failed to create room:', err);
      setError(getApiErrorMessage(err, 'Failed to create studio. Please try again.'));
    } finally {
      window.clearTimeout(progressTimer);
      setProgressMessage(null);
      setLoading(false);
    }
  };

  const scheduleRoom = async () => {
    if (!roomName.trim() || !hostName.trim()) return;
    setSchedulingLoading(true);
    setError(null);
    setProgressMessage(null);
    const progressTimer = window.setTimeout(() => {
      setProgressMessage('Still scheduling. The studio server is waking up and may need a moment.');
    }, SERVER_WAKE_NOTICE_DELAY_MS);

    try {
      const createdRoom = await postJson<CreatedRoomResponse>('/api/rooms/schedule', {
        name: roomName,
        hostName,
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
        password: roomPassword.trim() || undefined,
        registrationEnabled,
      }, {
        timeoutMs: CREATE_STUDIO_TIMEOUT_MS,
      });
      if (!hasCreatedRoomDetails(createdRoom)) {
        setError('Studio was scheduled, but room details were incomplete. Please schedule it again.');
        return;
      }
      const { room } = await resolveCreatedRoomHostAccess(createdRoom);
      const savedHostName = room.hostName || hostName;
      const hostToken = getValidHostToken(room.hostToken);
      if (!hostToken) {
        persistLegacyHostSession({ roomId: room.id, hostName: savedHostName });
        navigate(buildHostEntryPath(room.id));
        return;
      }
      persistHostSession({ roomId: room.id, hostName: savedHostName, hostToken });
      const savedRoom = toSavedScheduledRoom(room, savedHostName, hostToken);
      const nextStudios = upsertSavedScheduledStudio(savedRoom);
      setSavedScheduledRooms(nextStudios);
      void syncWorkspaceStudiosToSavedStudios(nextStudios, nextStudios);
      setScheduledRoom(savedRoom);
      setCopied(false);
      setHostCopied(false);
    } catch (err) {
      console.error('Failed to schedule room:', err);
      setError(getApiErrorMessage(err, 'Failed to schedule studio. Please try again.'));
    } finally {
      window.clearTimeout(progressTimer);
      setProgressMessage(null);
      setSchedulingLoading(false);
    }
  };

  const inviteLink = scheduledRoom ? buildGuestInviteUrl(INVITE_BASE_URL, scheduledRoom.id, scheduledRoom.name) : '';
  const hostEntryLink = scheduledRoom ? buildHostEntryUrl(INVITE_BASE_URL, scheduledRoom.id, scheduledRoom.hostToken) : '';
  const buildInviteLink = (room: SavedScheduledStudio) => buildGuestInviteUrl(INVITE_BASE_URL, room.id, room.name);
  const buildHostLink = (room: SavedScheduledStudio) => buildHostEntryUrl(INVITE_BASE_URL, room.id, room.hostToken);
  const cloudWorkspaceStudioCatalog = useMemo(() => {
    const byId = new Map<string, WorkspaceStudioCatalogEntry>();
    for (const studio of serverWorkspaceStudioCatalog) byId.set(studio.id, studio);
    for (const studio of accountWorkspaceStudioCatalog) byId.set(studio.id, studio);
    return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [accountWorkspaceStudioCatalog, serverWorkspaceStudioCatalog]);

  const dashboardStudios = useMemo(
    () => toSavedScheduledStudios(mergeWorkspaceStudioCatalogEntries(savedScheduledRooms, cloudWorkspaceStudioCatalog)),
    [cloudWorkspaceStudioCatalog, savedScheduledRooms]
  );
  const dashboardRecordings = useMemo(
    () => buildWorkspaceRecordingDashboardItems(recordingLibrary.sessions, serverRecordingCatalog),
    [recordingLibrary.sessions, serverRecordingCatalog]
  );
  const dashboardBrandKits = useMemo(() => {
    const byId = new Map<string, SavedBrandKit>();
    for (const kit of savedBrandKits) byId.set(kit.id, kit);
    for (const kit of serverBrandKitCatalog) {
      if (!byId.has(kit.id)) byId.set(kit.id, catalogEntryToSavedBrandKit(kit));
    }
    return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [savedBrandKits, serverBrandKitCatalog]);
  const dashboardTeamMembers = useMemo(
    () => mergeWorkspaceTeamCatalogMembers(savedTeamMembers, serverWorkspaceTeamCatalog),
    [savedTeamMembers, serverWorkspaceTeamCatalog]
  );
  const workspaceDashboard = useMemo(
    () => buildWorkspaceDashboardSummary(dashboardStudios, dashboardRecordings, dashboardBrandKits, dashboardTeamMembers),
    [dashboardStudios, dashboardRecordings, dashboardBrandKits, dashboardTeamMembers]
  );
  const recentRecordings = dashboardRecordings;
  const localRecordingIds = useMemo(
    () => new Set(recordingLibrary.sessions.map((session) => session.id)),
    [recordingLibrary.sessions]
  );
  const localBrandKitIds = useMemo(
    () => new Set(savedBrandKits.map((kit) => kit.id)),
    [savedBrandKits]
  );
  const hasTeamInviteRecipients = dashboardTeamMembers.some((member) => member.email);
  const recentBrandKits = dashboardBrandKits;
  const recentTeamMembers = dashboardTeamMembers
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const workspaceSyncNotice = dashboardNotice ||
    (serverWorkspaceStudioCatalogLoading ? 'Refreshing cloud studios...' : null) ||
    (accountWorkspaceStudioCatalogLoading ? 'Refreshing account studios...' : null) ||
    (workspaceView === 'recordings' && serverRecordingCatalogLoading ? 'Refreshing cloud recording catalog...' : null) ||
    (workspaceView === 'brand' && serverBrandKitCatalogLoading ? 'Refreshing cloud brand kit catalog...' : null) ||
    (workspaceView === 'team' && serverWorkspaceTeamCatalogLoading ? 'Refreshing cloud team roster...' : null) ||
    serverWorkspaceStudioCatalogError ||
    accountWorkspaceStudioCatalogError ||
    (workspaceView === 'recordings' ? serverRecordingCatalogError : null) ||
    (workspaceView === 'brand' ? serverBrandKitCatalogError : null) ||
    (workspaceView === 'team' ? serverWorkspaceTeamCatalogError : null);

  useEffect(() => {
    if (!scheduledRoom || !inviteLink) {
      setScheduledQrDataUrl('');
      setScheduledQrError('');
      return;
    }

    let cancelled = false;
    setScheduledQrDataUrl('');
    setScheduledQrError('');
    createInviteQrDataUrl(inviteLink)
      .then((dataUrl) => {
        if (!cancelled) setScheduledQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setScheduledQrError('Could not generate guest QR code.');
      });

    return () => {
      cancelled = true;
    };
  }, [inviteLink, scheduledRoom]);

  useEffect(() => {
    let cancelled = false;
    fetchAccountSession()
      .then((response) => {
        if (cancelled) return;
        setAccountUser(response.user);
        setAccountSessionExpiresAt(response.session?.expiresAt || '');
      })
      .catch(() => {
        if (cancelled) return;
        setAccountUser(null);
        setAccountSessionExpiresAt('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const hostAccessibleStudios = savedScheduledRooms.filter((room) => getValidHostToken(room.hostToken));
    if (hostAccessibleStudios.length === 0) {
      setServerWorkspaceStudioCatalog([]);
      setServerWorkspaceStudioCatalogError(null);
      setServerWorkspaceStudioCatalogLoading(false);
      return;
    }

    let cancelled = false;
    setServerWorkspaceStudioCatalogLoading(true);
    setServerWorkspaceStudioCatalogError(null);

    Promise.allSettled(
      hostAccessibleStudios.map((room) => fetchWorkspaceStudioCatalog(room.id, room.hostToken))
    )
      .then((results) => {
        if (cancelled) return;
        const byId = new Map<string, WorkspaceStudioCatalogEntry>();
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const studio of result.value.studios) {
            byId.set(studio.id, studio);
          }
        }
        setServerWorkspaceStudioCatalog(
          Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        );
        const failedCount = results.filter((result) => result.status === 'rejected').length;
        setServerWorkspaceStudioCatalogError(failedCount > 0
          ? `Could not refresh cloud studios for ${failedCount} saved studio${failedCount === 1 ? '' : 's'}.`
          : null
        );
      })
      .catch(() => {
        if (!cancelled) {
          setServerWorkspaceStudioCatalog([]);
          setServerWorkspaceStudioCatalogError('Could not refresh cloud studios.');
        }
      })
      .finally(() => {
        if (!cancelled) setServerWorkspaceStudioCatalogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [savedScheduledRooms]);

  useEffect(() => {
    if (!accountUser) {
      setAccountWorkspaceStudioCatalog([]);
      setAccountWorkspaceStudioCatalogError(null);
      setAccountWorkspaceStudioCatalogLoading(false);
      lastAccountWorkspaceStudioCatalogSyncKey.current = '';
      return;
    }

    let cancelled = false;
    setAccountWorkspaceStudioCatalogLoading(true);
    setAccountWorkspaceStudioCatalogError(null);

    fetchAccountWorkspaceStudioCatalog()
      .then((response) => {
        if (cancelled) return;
        setAccountWorkspaceStudioCatalog(
          response.studios.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        );
      })
      .catch(() => {
        if (!cancelled) {
          setAccountWorkspaceStudioCatalog([]);
          setAccountWorkspaceStudioCatalogError('Could not refresh account studios.');
        }
      })
      .finally(() => {
        if (!cancelled) setAccountWorkspaceStudioCatalogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountUser]);

  useEffect(() => {
    const syncKey = savedScheduledRooms
      .filter((room) => getValidHostToken(room.hostToken))
      .map((room) => `${room.id}:${room.hostToken}:${room.createdAt}:${room.scheduledFor || ''}`)
      .join('|');
    if (!syncKey || syncKey === lastWorkspaceStudioCatalogSyncKey.current) return;
    lastWorkspaceStudioCatalogSyncKey.current = syncKey;
    void syncWorkspaceStudiosToSavedStudios(savedScheduledRooms, savedScheduledRooms, false);
  }, [savedScheduledRooms]);

  useEffect(() => {
    const syncKey = accountUser
      ? [
          accountUser.id,
          ...savedScheduledRooms
            .filter((room) => getValidHostToken(room.hostToken))
            .map((room) => `${room.id}:${room.hostToken}:${room.createdAt}:${room.scheduledFor || ''}`),
        ].join('|')
      : '';
    if (!syncKey || syncKey === lastAccountWorkspaceStudioCatalogSyncKey.current) return;
    lastAccountWorkspaceStudioCatalogSyncKey.current = syncKey;
    void syncAccountWorkspaceStudios(savedScheduledRooms, false);
  }, [accountUser, savedScheduledRooms]);

  useEffect(() => {
    if (workspaceView !== 'recordings') {
      setServerRecordingCatalogLoading(false);
      return;
    }
    const hostAccessibleStudios = dashboardStudios.filter((room) => getValidHostToken(room.hostToken));
    if (hostAccessibleStudios.length === 0) {
      setServerRecordingCatalog([]);
      setServerRecordingCatalogError(null);
      setServerRecordingCatalogLoading(false);
      return;
    }

    let cancelled = false;
    setServerRecordingCatalogLoading(true);
    setServerRecordingCatalogError(null);

    Promise.allSettled(
      hostAccessibleStudios.map((room) => fetchRecordingCatalog(room.id, room.hostToken))
    )
      .then((results) => {
        if (cancelled) return;
        const byId = new Map<string, RecordingCatalogEntry>();
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const recording of result.value.recordings) {
            byId.set(recording.id, recording);
          }
        }
        setServerRecordingCatalog(
          Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        );
        const failedCount = results.filter((result) => result.status === 'rejected').length;
        setServerRecordingCatalogError(failedCount > 0
          ? `Could not refresh cloud recordings for ${failedCount} saved studio${failedCount === 1 ? '' : 's'}.`
          : null
        );
      })
      .catch(() => {
        if (!cancelled) {
          setServerRecordingCatalog([]);
          setServerRecordingCatalogError('Could not refresh cloud recordings.');
        }
      })
      .finally(() => {
        if (!cancelled) setServerRecordingCatalogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dashboardStudios, workspaceView]);

  useEffect(() => {
    if (workspaceView !== 'brand') {
      setServerBrandKitCatalogLoading(false);
      return;
    }
    const hostAccessibleStudios = dashboardStudios.filter((room) => getValidHostToken(room.hostToken));
    if (hostAccessibleStudios.length === 0) {
      setServerBrandKitCatalog([]);
      setServerBrandKitCatalogError(null);
      setServerBrandKitCatalogLoading(false);
      return;
    }

    let cancelled = false;
    setServerBrandKitCatalogLoading(true);
    setServerBrandKitCatalogError(null);

    Promise.allSettled(
      hostAccessibleStudios.map((room) => fetchBrandKitCatalog(room.id, room.hostToken))
    )
      .then((results) => {
        if (cancelled) return;
        const byId = new Map<string, BrandKitCatalogEntry>();
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const kit of result.value.brandKits) {
            byId.set(kit.id, kit);
          }
        }
        setServerBrandKitCatalog(
          Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        );
        const failedCount = results.filter((result) => result.status === 'rejected').length;
        setServerBrandKitCatalogError(failedCount > 0
          ? `Could not refresh cloud brand kits for ${failedCount} saved studio${failedCount === 1 ? '' : 's'}.`
          : null
        );
      })
      .catch(() => {
        if (!cancelled) {
          setServerBrandKitCatalog([]);
          setServerBrandKitCatalogError('Could not refresh cloud brand kits.');
        }
      })
      .finally(() => {
        if (!cancelled) setServerBrandKitCatalogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dashboardStudios, workspaceView]);

  useEffect(() => {
    if (workspaceView !== 'team') {
      setServerWorkspaceTeamCatalogLoading(false);
      return;
    }
    const hostAccessibleStudios = dashboardStudios.filter((room) => getValidHostToken(room.hostToken));
    if (hostAccessibleStudios.length === 0) {
      setServerWorkspaceTeamCatalog([]);
      setServerWorkspaceTeamCatalogError(null);
      setServerWorkspaceTeamCatalogLoading(false);
      return;
    }

    let cancelled = false;
    setServerWorkspaceTeamCatalogLoading(true);
    setServerWorkspaceTeamCatalogError(null);

    Promise.allSettled(
      hostAccessibleStudios.map((room) => fetchWorkspaceTeamCatalog(room.id, room.hostToken))
    )
      .then((results) => {
        if (cancelled) return;
        const byId = new Map<string, WorkspaceTeamCatalogMember>();
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          for (const member of result.value.members) {
            byId.set(member.id, member);
          }
        }
        setServerWorkspaceTeamCatalog(
          Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        );
        const failedCount = results.filter((result) => result.status === 'rejected').length;
        setServerWorkspaceTeamCatalogError(failedCount > 0
          ? `Could not refresh cloud team roster for ${failedCount} saved studio${failedCount === 1 ? '' : 's'}.`
          : null
        );
      })
      .catch(() => {
        if (!cancelled) {
          setServerWorkspaceTeamCatalog([]);
          setServerWorkspaceTeamCatalogError('Could not refresh cloud team roster.');
        }
      })
      .finally(() => {
        if (!cancelled) setServerWorkspaceTeamCatalogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dashboardStudios, workspaceView]);

  const copyToClipboard = async () => {
    await writeClipboardText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyHostEntryLink = async () => {
    if (!hostEntryLink) return;
    await writeClipboardText(hostEntryLink);
    setHostCopied(true);
    setTimeout(() => setHostCopied(false), 2000);
  };

  const copySavedInviteLink = async (room: SavedScheduledStudio) => {
    await writeClipboardText(buildInviteLink(room));
    setSavedRoomCopiedId(room.id);
    setTimeout(() => setSavedRoomCopiedId(null), 2000);
  };

  const copySavedHostLink = async (room: SavedScheduledStudio) => {
    await writeClipboardText(buildHostLink(room));
    setSavedHostCopiedId(room.id);
    setTimeout(() => setSavedHostCopiedId(null), 2000);
  };

  const downloadCalendarInvite = (room: SavedScheduledStudio) => {
    const calendar = buildStudioCalendarInvite({
      roomName: room.name,
      hostName: room.hostName,
      inviteUrl: buildInviteLink(room),
      scheduledFor: room.scheduledFor,
      createdAt: room.createdAt,
      uid: `studio-${room.id}`,
      passwordProtected: room.passwordProtected,
    });
    if (!calendar) return;
    downloadTextFile(calendar, `${safeFileName(room.name)}_calendar.ics`, 'text/calendar;charset=utf-8');
  };

  const downloadScheduledInviteQr = () => {
    if (!scheduledRoom || !scheduledQrDataUrl) return;
    downloadDataUrl(scheduledQrDataUrl, `${safeFileName(scheduledRoom.name)}_guest_invite_qr.png`);
  };

  const downloadSavedInviteQr = async (room: SavedScheduledStudio) => {
    if (savedQrDownloadingId) return;
    setError(null);
    setSavedQrDownloadingId(room.id);
    try {
      const dataUrl = await createInviteQrDataUrl(buildInviteLink(room));
      downloadDataUrl(dataUrl, `${safeFileName(room.name)}_guest_invite_qr.png`);
    } catch {
      setError('Could not generate a QR code for that studio.');
    } finally {
      setSavedQrDownloadingId(null);
    }
  };

  const downloadRegistrants = async (room: SavedScheduledStudio) => {
    if (registrantsDownloadingId) return;
    setError(null);
    setRegistrantsDownloadingId(room.id);
    try {
      const data = await getJson<RoomRegistrantListResponse>(
        `/api/rooms/${encodeURIComponent(room.id)}/registrants`,
        {
          headers: {
            'x-host-token': room.hostToken,
          },
          timeoutMs: 15_000,
        }
      );
      downloadTextFile(
        buildRegistrantsCsv(data, room.name),
        `${safeFileName(room.name)}_registrants.csv`,
        'text/csv;charset=utf-8'
      );
      setDashboardNotice(`Exported ${data.registrants.length} registrant${data.registrants.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not export registrants for that studio.'));
    } finally {
      setRegistrantsDownloadingId(null);
    }
  };

  const emailGuestInvite = (room: SavedScheduledStudio) => {
    window.location.href = buildGuestInviteEmailHref({
      roomName: room.name,
      hostName: room.hostName,
      status: getScheduleState(room),
      scheduledLabel: room.scheduledFor ? formatScheduledDate(room.scheduledFor) : null,
      inviteUrl: buildInviteLink(room),
      passwordProtected: room.passwordProtected,
    });
  };

  const downloadGuestPreparationSheet = (room: SavedScheduledStudio) => {
    downloadTextFile(
      buildGuestPreparationSheet({
        roomName: room.name,
        hostName: room.hostName,
        status: getScheduleState(room),
        scheduledLabel: room.scheduledFor ? formatScheduledDate(room.scheduledFor) : null,
        generatedAt: formatDashboardDate(new Date().toISOString()),
        inviteUrl: buildInviteLink(room),
        passwordProtected: room.passwordProtected,
        registrationEnabled: room.registrationEnabled,
      }),
      `${safeFileName(room.name)}_guest_prep.txt`,
      'text/plain;charset=utf-8'
    );
    setDashboardError(null);
    setDashboardNotice('Guest preparation sheet downloaded.');
  };

  const buildTeamInviteInput = (room: SavedScheduledStudio) => ({
    roomName: room.name,
    hostName: room.hostName,
    scheduledLabel: room.scheduledFor ? formatScheduledDate(room.scheduledFor) : null,
    guestInviteUrl: buildInviteLink(room),
    hostEntryUrl: buildHostLink(room),
    passwordProtected: room.passwordProtected,
    members: dashboardTeamMembers,
  });

  const emailTeamInvite = (room: SavedScheduledStudio) => {
    if (!hasTeamInviteRecipients) {
      setDashboardError('Add at least one team member email before sending a team invite.');
      return;
    }

    setDashboardError(null);
    window.location.href = buildWorkspaceTeamStudioInviteEmailHref(buildTeamInviteInput(room));
  };

  const downloadTeamCallSheet = (room: SavedScheduledStudio) => {
    if (dashboardTeamMembers.length === 0) {
      setDashboardError('Add at least one team member before exporting a team call sheet.');
      return;
    }

    setDashboardError(null);
    downloadTextFile(
      buildWorkspaceTeamStudioCallSheet({
        ...buildTeamInviteInput(room),
        generatedAt: formatDashboardDate(new Date().toISOString()),
      }),
      `${safeFileName(room.name)}_team_call_sheet.txt`,
      'text/plain;charset=utf-8'
    );
    setDashboardNotice('Team call sheet downloaded.');
  };

  const emailScheduledGuestInvite = () => {
    if (!scheduledRoom || !inviteLink) return;
    window.location.href = buildGuestInviteEmailHref({
      roomName: scheduledRoom.name,
      hostName: scheduledRoom.hostName,
      status: getScheduleState(scheduledRoom),
      scheduledLabel: scheduledRoom.scheduledFor ? formatScheduledDate(scheduledRoom.scheduledFor) : null,
      inviteUrl: inviteLink,
      passwordProtected: scheduledRoom.passwordProtected,
    });
  };

  const openScheduledAsHost = (room: SavedScheduledStudio) => {
    const savedHostName = room.hostName || hostName || 'Host';
    const hostToken = getValidHostToken(room.hostToken);
    if (!hostToken) {
      setError(SAVED_HOST_ACCESS_MISSING_MESSAGE);
      return;
    }
    persistHostSession({ roomId: room.id, hostName: savedHostName, hostToken });
    navigate(buildHostEntryPath(room.id, hostToken));
  };

  const forgetScheduledRoom = (roomId: string) => {
    const currentDashboardStudios = dashboardStudios;
    setSavedScheduledRooms(removeSavedScheduledStudio(roomId));
    void deleteWorkspaceStudioFromSavedStudios(roomId, currentDashboardStudios);
    void deleteAccountWorkspaceStudio(roomId);
  };

  const deleteRecordingSession = async (session: LocalRecordingSession) => {
    if (!window.confirm(`Delete recording "${session.roomName}" from this browser?`)) return;
    setDashboardError(null);
    setDashboardNotice(null);
    try {
      await recordingLibrary.deleteSession(session.id);
      setDashboardNotice('Recording deleted.');
    } catch {
      setDashboardError('Could not delete that recording.');
    }
  };

  const downloadLocalRecording = async (recording: WorkspaceDashboardRecording) => {
    setDownloadingRecordingId(recording.id);
    setDashboardError(null);
    try {
      const files = await recordingLibrary.loadFiles(recording.id);
      if (files.length === 0) throw new Error('No local tracks were found for this recording.');
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      for (const [index, file] of files.entries()) {
        const name = file.fileName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        zip.file(`${index + 1}_${name}`, file.blob);
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${safeFileName(recording.roomName)}_tracks.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setDashboardNotice('Recording tracks downloaded.');
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'Could not download the recording.');
    } finally {
      setDownloadingRecordingId(null);
    }
  };

  const copyRecordingMp4ShareLink = async (recording: WorkspaceDashboardRecording) => {
    const mp4ShareUrl = recording.mediaExport?.mp4ShareUrl;
    if (!mp4ShareUrl) return;
    setDashboardError(null);
    setDashboardNotice(null);
    try {
      await writeClipboardText(mp4ShareUrl);
      setDashboardNotice('MP4 share link copied.');
    } catch {
      setDashboardError('Could not copy the MP4 share link.');
    }
  };

  const openRecordingMp4ShareLink = (recording: WorkspaceDashboardRecording) => {
    const mp4ShareUrl = recording.mediaExport?.mp4ShareUrl;
    if (!mp4ShareUrl) return;
    window.open(mp4ShareUrl, '_blank', 'noopener,noreferrer');
  };

  const deleteDashboardRecordingSession = async (recording: WorkspaceDashboardRecording) => {
    const localSession = recordingLibrary.sessions.find((session) => session.id === recording.id);
    if (!localSession) {
      setDashboardError('That recording is only in the cloud catalog and cannot be deleted from this browser.');
      return;
    }
    await deleteRecordingSession(localSession);
  };

  const deleteBrandKit = (kit: SavedBrandKit) => {
    if (!window.confirm(`Delete brand kit "${kit.name}" from this browser?`)) return;
    setDashboardNotice(null);
    const next = savedBrandKits.filter((item) => item.id !== kit.id);
    if (!writeSavedBrandKitLibrary(next)) {
      setDashboardError('Could not update saved brand kits in this browser.');
      return;
    }
    setDashboardError(null);
    setDashboardNotice('Brand kit deleted.');
    setSavedBrandKits(next);
  };

  const mergeSyncedWorkspaceStudios = (studios: WorkspaceStudioCatalogEntry[]) => {
    if (studios.length === 0) return;
    setServerWorkspaceStudioCatalog((current) => {
      const byId = new Map<string, WorkspaceStudioCatalogEntry>();
      for (const studio of current) byId.set(studio.id, studio);
      for (const studio of studios) byId.set(studio.id, studio);
      return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    });
  };

  const mergeSyncedAccountWorkspaceStudios = (studios: WorkspaceStudioCatalogEntry[]) => {
    if (studios.length === 0) return;
    setAccountWorkspaceStudioCatalog((current) => {
      const byId = new Map<string, WorkspaceStudioCatalogEntry>();
      for (const studio of current) byId.set(studio.id, studio);
      for (const studio of studios) byId.set(studio.id, studio);
      return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    });
  };

  const syncWorkspaceStudiosToSavedStudios = async (
    studios: SavedScheduledStudio[],
    catalogStudios: SavedScheduledStudio[] = dashboardStudios,
    showErrors = true
  ) => {
    const hostAccessibleCatalogs = catalogStudios.filter((room) => getValidHostToken(room.hostToken));
    const syncableStudios = studios.filter((room) => getValidHostToken(room.hostToken));
    if (hostAccessibleCatalogs.length === 0 || syncableStudios.length === 0) return;

    const results = await Promise.allSettled(
      hostAccessibleCatalogs.flatMap((room) => (
        syncableStudios.map((studio) => syncWorkspaceStudioCatalogEntry({
          roomId: room.id,
          hostToken: room.hostToken,
          studio,
        }))
      ))
    );

    const synced = results
      .filter((result): result is PromiseFulfilledResult<WorkspaceStudioCatalogEntry> => result.status === 'fulfilled')
      .map((result) => result.value);
    mergeSyncedWorkspaceStudios(synced);

    const failedCount = results.filter((result) => result.status === 'rejected').length;
    if (showErrors) {
      setServerWorkspaceStudioCatalogError(failedCount > 0
        ? `Saved locally, but ${failedCount} cloud studio sync ${failedCount === 1 ? 'request' : 'requests'} failed.`
        : null
      );
    }
  };

  const syncAccountWorkspaceStudios = async (
    studios: SavedScheduledStudio[],
    showErrors = true
  ) => {
    if (!accountUser) return;
    const syncableStudios = studios.filter((room) => getValidHostToken(room.hostToken));
    if (syncableStudios.length === 0) return;

    const results = await Promise.allSettled(
      syncableStudios.map((studio) => syncAccountWorkspaceStudioCatalogEntry(studio))
    );
    const synced = results
      .filter((result): result is PromiseFulfilledResult<WorkspaceStudioCatalogEntry> => result.status === 'fulfilled')
      .map((result) => result.value);
    mergeSyncedAccountWorkspaceStudios(synced);

    const failedCount = results.filter((result) => result.status === 'rejected').length;
    if (showErrors) {
      setAccountWorkspaceStudioCatalogError(failedCount > 0
        ? `Saved locally, but ${failedCount} account studio sync ${failedCount === 1 ? 'request' : 'requests'} failed.`
        : null
      );
    }
  };

  const deleteWorkspaceStudioFromSavedStudios = async (
    studioId: string,
    catalogStudios: SavedScheduledStudio[] = dashboardStudios
  ) => {
    const hostAccessibleCatalogs = catalogStudios.filter((room) => getValidHostToken(room.hostToken));
    if (hostAccessibleCatalogs.length === 0) return;

    setServerWorkspaceStudioCatalog((current) => current.filter((studio) => studio.id !== studioId));
    const results = await Promise.allSettled(
      hostAccessibleCatalogs.map((room) => deleteWorkspaceStudioCatalogEntry(room.id, room.hostToken, studioId))
    );
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    setServerWorkspaceStudioCatalogError(failedCount > 0
      ? `Removed locally, but cloud studio removal failed for ${failedCount} saved studio${failedCount === 1 ? '' : 's'}.`
      : null
    );
  };

  const deleteAccountWorkspaceStudio = async (studioId: string) => {
    if (!accountUser) return;
    setAccountWorkspaceStudioCatalog((current) => current.filter((studio) => studio.id !== studioId));
    try {
      await deleteAccountWorkspaceStudioCatalogEntry(studioId);
      setAccountWorkspaceStudioCatalogError(null);
    } catch {
      setAccountWorkspaceStudioCatalogError('Removed locally, but account studio removal failed.');
    }
  };

  const mergeSyncedWorkspaceTeamMembers = (members: WorkspaceTeamCatalogMember[]) => {
    if (members.length === 0) return;
    setServerWorkspaceTeamCatalog((current) => {
      const byId = new Map<string, WorkspaceTeamCatalogMember>();
      for (const member of current) byId.set(member.id, member);
      for (const member of members) byId.set(member.id, member);
      return Array.from(byId.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    });
  };

  const syncWorkspaceTeamMembersToSavedStudios = async (
    members: SavedWorkspaceTeamMember[],
    studios: SavedScheduledStudio[] = dashboardStudios
  ) => {
    const hostAccessibleStudios = studios.filter((room) => getValidHostToken(room.hostToken));
    if (hostAccessibleStudios.length === 0 || members.length === 0) return;

    const results = await Promise.allSettled(
      hostAccessibleStudios.flatMap((room) => (
        members.map((member) => syncWorkspaceTeamCatalogMember({
          roomId: room.id,
          hostToken: room.hostToken,
          member,
        }))
      ))
    );

    const synced = results
      .filter((result): result is PromiseFulfilledResult<WorkspaceTeamCatalogMember> => result.status === 'fulfilled')
      .map((result) => result.value);
    mergeSyncedWorkspaceTeamMembers(synced);

    const failedCount = results.filter((result) => result.status === 'rejected').length;
    setServerWorkspaceTeamCatalogError(failedCount > 0
      ? `Saved locally, but ${failedCount} cloud roster sync ${failedCount === 1 ? 'request' : 'requests'} failed.`
      : null
    );
  };

  const deleteWorkspaceTeamMemberFromSavedStudios = async (memberId: string) => {
    const hostAccessibleStudios = dashboardStudios.filter((room) => getValidHostToken(room.hostToken));
    if (hostAccessibleStudios.length === 0) return;

    setServerWorkspaceTeamCatalog((current) => current.filter((member) => member.id !== memberId));
    const results = await Promise.allSettled(
      hostAccessibleStudios.map((room) => deleteWorkspaceTeamCatalogMember(room.id, room.hostToken, memberId))
    );
    const failedCount = results.filter((result) => result.status === 'rejected').length;
    setServerWorkspaceTeamCatalogError(failedCount > 0
      ? `Removed locally, but cloud roster removal failed for ${failedCount} saved studio${failedCount === 1 ? '' : 's'}.`
      : null
    );
  };

  const addTeamMember = () => {
    setDashboardError(null);
    setDashboardNotice(null);
    const member = createWorkspaceTeamMember({
      name: teamMemberName,
      email: teamMemberEmail,
      role: teamMemberRole,
    });
    if (!member) {
      setDashboardError('Enter a team member name.');
      return;
    }
    const next = upsertWorkspaceTeamMember(savedTeamMembers, member);
    if (!writeSavedWorkspaceTeamLibrary(next)) {
      setDashboardError('Could not update the workspace team in this browser.');
      return;
    }
    setSavedTeamMembers(next);
    setTeamMemberName('');
    setTeamMemberEmail('');
    setTeamMemberRole('producer');
    setDashboardNotice('Team member saved.');
    void syncWorkspaceTeamMembersToSavedStudios([member]);
  };

  const deleteTeamMember = (member: SavedWorkspaceTeamMember) => {
    if (!window.confirm(`Remove "${member.name}" from this workspace roster?`)) return;
    setDashboardError(null);
    setDashboardNotice(null);
    const next = removeWorkspaceTeamMember(savedTeamMembers, member.id);
    if (!writeSavedWorkspaceTeamLibrary(next)) {
      setDashboardError('Could not update the workspace team in this browser.');
      return;
    }
    setSavedTeamMembers(next);
    setDashboardNotice('Team member removed.');
    void deleteWorkspaceTeamMemberFromSavedStudios(member.id);
  };

  const exportWorkspaceBackup = () => {
    if (dashboardStudios.length > 0 && !window.confirm('Workspace backups include private host links for saved studios. Keep the exported file private.')) {
      return;
    }
    const backup = buildWorkspaceBackup({
      studios: dashboardStudios,
      brandKits: savedBrandKits,
      teamMembers: dashboardTeamMembers,
      recordings: recordingLibrary.sessions,
    });
    downloadTextFile(
      serializeWorkspaceBackup(backup),
      `livestream_studio_workspace_${new Date().toISOString().slice(0, 10)}.json`,
      'application/json;charset=utf-8'
    );
    setDashboardError(null);
    setDashboardNotice('Workspace backup exported.');
  };

  const openWorkspaceBackupImport = () => {
    workspaceImportInputRef.current?.click();
  };

  const importWorkspaceBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setDashboardError(null);
    setDashboardNotice(null);
    try {
      const backup = parseWorkspaceBackupJson(await file.text());
      const result = mergeWorkspaceBackup(readSavedHostStudios(), savedBrandKits, backup, savedTeamMembers);
      if (
        !writeSavedHostStudioLibrary(result.studios) ||
        !writeSavedBrandKitLibrary(result.brandKits) ||
        !writeSavedWorkspaceTeamLibrary(result.teamMembers)
      ) {
        throw new Error('Could not save imported workspace in this browser.');
      }
      const importedStudios = readSavedScheduledStudios();
      setSavedScheduledRooms(importedStudios);
      setSavedBrandKits(result.brandKits);
      setSavedTeamMembers(result.teamMembers);
      void syncWorkspaceStudiosToSavedStudios(importedStudios, importedStudios);
      void syncAccountWorkspaceStudios(importedStudios);
      void syncWorkspaceTeamMembersToSavedStudios(result.teamMembers, importedStudios);
      setDashboardNotice(
        `Imported ${result.importedStudios} studios, ${result.importedBrandKits} brand kits, and ${result.importedTeamMembers} team members.`
      );
    } catch (err) {
      setDashboardError(err instanceof Error ? err.message : 'Could not import that workspace backup.');
    }
  };

  const submitAccountAuth = async () => {
    setAccountError(null);
    setDashboardNotice(null);
    const email = accountEmail.trim();
    const password = accountPassword;
    const name = accountName.trim() || hostName.trim() || 'Studio Host';
    if (!email || !password || (accountMode === 'register' && !name)) {
      setAccountError('Enter account details to continue.');
      return;
    }

    setAccountLoading(true);
    try {
      const result = accountMode === 'register'
        ? await registerAccount({ email, name, password })
        : await loginAccount({ email, password });
      setAccountUser(result.user);
      setAccountSessionExpiresAt(result.session.expiresAt);
      setAccountName(result.user.name);
      setAccountEmail(result.user.email);
      setAccountPassword('');
      setDashboardNotice(accountMode === 'register' ? 'Account created.' : 'Signed in.');
    } catch (err) {
      setAccountError(getApiErrorMessage(err, 'Account request failed. Please try again.'));
    } finally {
      setAccountLoading(false);
    }
  };

  const signOutAccount = async () => {
    setAccountError(null);
    setDashboardNotice(null);
    setAccountLoading(true);
    try {
      await logoutAccount();
      setAccountUser(null);
      setAccountSessionExpiresAt('');
      setAccountWorkspaceStudioCatalog([]);
      setAccountWorkspaceStudioCatalogError(null);
      lastAccountWorkspaceStudioCatalogSyncKey.current = '';
      setAccountPassword('');
      setDashboardNotice('Signed out.');
    } catch (err) {
      setAccountError(getApiErrorMessage(err, 'Could not sign out. Please try again.'));
    } finally {
      setAccountLoading(false);
    }
  };

  const goToStudioAsHost = () => {
    if (!scheduledRoom) return;
    const savedHostName = scheduledRoom.hostName || hostName || 'Host';
    const hostToken = getValidHostToken(scheduledRoom.hostToken);
    if (!hostToken) {
      setError(SAVED_HOST_ACCESS_MISSING_MESSAGE);
      return;
    }
    persistHostSession({ roomId: scheduledRoom.id, hostName: savedHostName, hostToken });
    navigate(buildHostEntryPath(scheduledRoom.id, hostToken));
  };

  const closeModal = () => {
    setShowCreate(false);
    setScheduledRoom(null);
    setCopied(false);
    setHostCopied(false);
    setScheduledQrDataUrl('');
    setScheduledQrError('');
    setRoomName('');
    setHostName('');
    setScheduledFor('');
    setRoomPassword('');
    setRegistrationEnabled(false);
  };

  const minScheduleDateTime = toDateTimeLocalValue(new Date(Date.now() + 60_000));

  const filteredStudios = dashboardStudios.filter(room =>
    room.name.toLowerCase().includes(studioSearch.toLowerCase()) &&
    (studioFilter === 'all' || getScheduleState(room) === 'Upcoming')
  );
  const viewTitles = { studios: 'Your studios', recordings: 'Recordings', brand: 'Brand kits', team: 'Team', settings: 'Settings' };
  const viewDescriptions = {
    studios: 'A little preparation. A great conversation.',
    recordings: 'Your sessions, ready for the next chapter.',
    brand: 'A consistent look for every conversation.',
    team: 'Bring your production team together.',
    settings: 'Manage your account and workspace.',
  };

  return (
    <div className="workspace-app">
      <a className="workspace-skip" href="#workspace-main">Skip to content</a>
      <aside className="workspace-nav">
        <a className="workspace-logo" href="/" aria-label="Live Stream Studio home"><span className="brand-symbol"><StudioIcon name="video" /></span><span>Live Stream<span>Studio</span></span></a>
        <div className="workspace-switcher"><span className="workspace-avatar">AF</span><span>My workspace<small>Personal workspace</small></span></div>
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="Workspace">
          {(['studios', 'recordings', 'brand', 'team'] as const).map(view => <button key={view} aria-current={workspaceView === view ? 'page' : undefined} onClick={() => setWorkspaceView(view)}><StudioIcon name={view} />{viewTitles[view]}{view === 'studios' && dashboardStudios.length > 0 && <span className="nav-count">{dashboardStudios.length}</span>}</button>)}
        </nav>
        <div className="workspace-nav-bottom">
          <button aria-current={workspaceView === 'settings' ? 'page' : undefined} onClick={() => setWorkspaceView('settings')}><StudioIcon name="settings" />Settings & account</button>
          <div className="workspace-attribution">Powered by<a href="https://ArnoldFamily.com" target="_blank" rel="noopener noreferrer">ArnoldFamily.com <span>↗</span></a></div>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-topbar"><span>Workspace <span className="breadcrumb-divider">/</span> <strong>{viewTitles[workspaceView]}</strong></span><button className="account-chip" onClick={() => setWorkspaceView('settings')}><span className="account-avatar">{accountUser?.name.slice(0, 1).toUpperCase() || 'AF'}</span>{accountUser?.name || 'My account'}<StudioIcon name="chevron" /></button></header>
        <main id="workspace-main" className="workspace-main">
          <div className="workspace-page-heading"><div><span className="eyebrow">CREATE. CONNECT. GO LIVE.</span><h1>{viewTitles[workspaceView]}</h1><p>{viewDescriptions[workspaceView]}</p></div><button className="workspace-primary" onClick={() => setShowCreate(true)}><StudioIcon name="plus" />Create studio</button></div>
          {(dashboardError || recordingLibrary.error) && <p className="workspace-alert" role="alert">{dashboardError || recordingLibrary.error}</p>}
          {workspaceSyncNotice && !dashboardError && !recordingLibrary.error && <p className="workspace-notice" role="status">{workspaceSyncNotice}</p>}
          {error && !showCreate && <p className="workspace-alert" role="alert">{error}</p>}
          {workspaceView === 'studios' && <>
            <section className="workspace-hero">
              <div className="hero-copy"><span className="hero-kicker"><span /> YOUR NEXT GREAT CONVERSATION</span><h2>Big ideas.<br />Beautifully broadcast.</h2><p>Your guests, your brand, your stage.<br />One space to bring it all together.</p><button className="hero-action" onClick={() => setShowCreate(true)}>Let's create something <span>↗</span></button></div>
              <div className="hero-illustration" aria-hidden="true"><div className="mini-studio"><div className="mini-top"><span className="mini-dot" />Studio preview <span>16:9</span></div><div className="mini-stage"><div className="mini-person person-one"><StudioIcon name="person" /><span>You</span></div><div className="mini-person person-two"><StudioIcon name="person" /><span>Your guest</span></div></div><div className="mini-controls"><span><StudioIcon name="mic" /></span><span><StudioIcon name="video" /></span><i /><b>Go live</b></div></div><span className="illustration-caption">MAKE ROOM FOR YOUR STORY.</span></div>
            </section>
            {dashboardStudios.length === 0 && <section className="workspace-empty"><span className="empty-icon"><StudioIcon name="studios" /></span><h2>A fresh stage, just for you</h2><p>Create your first studio to invite guests, record a conversation,<br />or prepare your next live show.</p><button className="workspace-secondary" onClick={() => setShowCreate(true)}><StudioIcon name="plus" />Create your first studio</button></section>}
          </>}
          {workspaceView === 'studios' && dashboardStudios.length > 0 && (
            <section className="ws-schedulePanel" style={styles.schedulePanel}>
              <div className="ws-schedulePanelHeader" style={styles.schedulePanelHeader}>
                <h2 className="ws-schedulePanelTitle" style={styles.schedulePanelTitle}>Your Studios</h2>
                <span className="ws-schedulePanelCount" style={styles.schedulePanelCount}>{dashboardStudios.length}</span>
              </div>
              <div className="studio-list-tools">
                <div className="studio-filters" role="group" aria-label="Filter studios">
                  <button aria-pressed={studioFilter === 'all'} onClick={() => setStudioFilter('all')}>All studios</button>
                  <button aria-pressed={studioFilter === 'upcoming'} onClick={() => setStudioFilter('upcoming')}>Upcoming</button>
                </div>
                <label className="studio-search"><StudioIcon name="search" /><input aria-label="Search studios" placeholder="Search studios" value={studioSearch} onChange={e => setStudioSearch(e.target.value)} /></label>
              </div>
              {filteredStudios.length === 0 && <p className="search-empty" role="status">No studios match your search.</p>}
              <div className="ws-savedRoomList" style={styles.savedRoomList}>
                {filteredStudios.map((room) => {
                  const scheduleState = getScheduleState(room);
                  return (
                    <div key={room.id} className="ws-savedRoomCard" style={styles.savedRoomCard}>
                      <div className="ws-savedRoomTop" style={styles.savedRoomTop}><span className="room-art"><StudioIcon name="video" /></span>
                        <div className="ws-savedRoomInfo" style={styles.savedRoomInfo}>
                          <span className="ws-savedRoomName" style={styles.savedRoomName}>{room.name}</span>
                          <span className="ws-savedRoomMeta" style={styles.savedRoomMeta}>{formatScheduledDate(room.scheduledFor)}</span>
                        </div>
                        <span style={{
                          ...styles.savedRoomBadge,
                          ...(scheduleState === 'Upcoming' ? styles.savedRoomBadgeUpcoming : {}),
                        }}>
                          {scheduleState}
                        </span>
                      </div>


                      <div className="ws-savedRoomActions" style={styles.savedRoomActions}>
                        <button
                          className="ws-savedRoomAction" style={styles.savedRoomAction}
                          onClick={() => copySavedInviteLink(room)}
                        >
                          {savedRoomCopiedId === room.id ? 'Copied' : 'Guest Link'}
                        </button>
                        <button
                          className="ws-savedRoomPrimaryAction" style={{ ...styles.savedRoomAction, ...styles.savedRoomPrimaryAction }}
                          onClick={() => openScheduledAsHost(room)}
                        >
                          Enter studio
                        </button>
                        <details className="studio-row-more"><summary aria-label={`More actions for ${room.name}`}><StudioIcon name="more" /></summary><div>
                        <button
                          className="ws-savedRoomAction" style={styles.savedRoomAction}
                          onClick={() => emailGuestInvite(room)}
                        >
                          Email
                        </button>
                        <button
                          className="ws-savedRoomAction" style={styles.savedRoomAction}
                          onClick={() => downloadGuestPreparationSheet(room)}
                        >
                          Guest Prep
                        </button>
                        {dashboardTeamMembers.length > 0 && (
                          <>
                            <button
                              className="ws-savedRoomAction" style={styles.savedRoomAction}
                              onClick={() => emailTeamInvite(room)}
                              disabled={!hasTeamInviteRecipients}
                            >
                              Team Email
                            </button>
                            <button
                              className="ws-savedRoomAction" style={styles.savedRoomAction}
                              onClick={() => downloadTeamCallSheet(room)}
                            >
                              Team Sheet
                            </button>
                          </>
                        )}
                        <button
                          className="ws-savedRoomAction" style={styles.savedRoomAction}
                          onClick={() => copySavedHostLink(room)}
                        >
                          {savedHostCopiedId === room.id ? 'Copied' : 'Host Link'}
                        </button>
                        <button
                          className="ws-savedRoomAction" style={styles.savedRoomAction}
                          onClick={() => void downloadSavedInviteQr(room)}
                          disabled={savedQrDownloadingId === room.id}
                        >
                          {savedQrDownloadingId === room.id ? 'QR...' : 'QR'}
                        </button>
                        {room.scheduledFor && (
                          <button
                            className="ws-savedRoomAction" style={styles.savedRoomAction}
                            onClick={() => downloadCalendarInvite(room)}
                          >
                            Calendar
                          </button>
                        )}
                        {room.registrationEnabled && (
                          <button
                            className="ws-savedRoomAction" style={styles.savedRoomAction}
                            onClick={() => void downloadRegistrants(room)}
                            disabled={registrantsDownloadingId === room.id}
                          >
                            {registrantsDownloadingId === room.id ? 'Exporting...' : 'Registrants'}
                          </button>
                        )}
                        <button
                          style={{ ...styles.savedRoomAction, ...styles.savedRoomDangerAction }}
                          onClick={() => forgetScheduledRoom(room.id)}
                        >
                          Remove
                        </button></div></details>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {workspaceView === 'settings' && <section className="workspace-surface" aria-label="Account and workspace settings">              <div className="ws-workspaceHeader" style={styles.workspaceHeader}>
                <div className="ws-workspaceHeaderCopy" style={styles.workspaceHeaderCopy}>
                  <h2 className="ws-workspaceTitle" style={styles.workspaceTitle}>Workspace</h2>
                  <p className="ws-workspaceSubtitle" style={styles.workspaceSubtitle}>Saved studios, team, recordings, and brand assets</p>
                </div>
                <div className="ws-workspaceHeaderActions" style={styles.workspaceHeaderActions}>
                  <button
                    className="ws-workspaceHeaderAction" style={styles.workspaceHeaderAction}
                    onClick={exportWorkspaceBackup}
                  >
                    Export
                  </button>
                  <button
                    className="ws-workspaceHeaderAction" style={styles.workspaceHeaderAction}
                    onClick={openWorkspaceBackupImport}
                  >
                    Import
                  </button>
                  <span className="ws-workspaceBadge" style={styles.workspaceBadge}>
                    {workspaceDashboard.totalStudios + workspaceDashboard.totalRecordings + workspaceDashboard.totalBrandKits + workspaceDashboard.totalTeamMembers}
                  </span>
                </div>
                <input
                  ref={workspaceImportInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="ws-workspaceImportInput" style={styles.workspaceImportInput}
                  onChange={(event) => void importWorkspaceBackup(event)}
                />
              </div>

              <div className="ws-accountPanel" style={styles.accountPanel}>
                <div className="ws-accountHeader" style={styles.accountHeader}>
                  <div className="ws-accountHeaderCopy" style={styles.accountHeaderCopy}>
                    <span className="ws-workspaceSectionTitle" style={styles.workspaceSectionTitle}>Account</span>
                    {accountUser ? (
                      <span className="ws-workspaceRowMeta" style={styles.workspaceRowMeta}>
                        {accountUser.name} | {accountUser.email}
                      </span>
                    ) : (
                      <span className="ws-workspaceRowMeta" style={styles.workspaceRowMeta}>Not signed in</span>
                    )}
                  </div>
                  {accountUser ? (
                    <button
                      className="ws-workspaceRowAction" style={styles.workspaceRowAction}
                      onClick={() => void signOutAccount()}
                      disabled={accountLoading}
                    >
                      {accountLoading ? 'Signing out...' : 'Sign out'}
                    </button>
                  ) : (
                    <div className="ws-accountModeToggle" style={styles.accountModeToggle}>
                      <button
                        style={{
                          ...styles.accountModeButton,
                          ...(accountMode === 'register' ? styles.accountModeButtonActive : {}),
                        }}
                        onClick={() => setAccountMode('register')}
                      >
                        Register
                      </button>
                      <button
                        style={{
                          ...styles.accountModeButton,
                          ...(accountMode === 'login' ? styles.accountModeButtonActive : {}),
                        }}
                        onClick={() => setAccountMode('login')}
                      >
                        Log in
                      </button>
                    </div>
                  )}
                </div>

                {accountUser ? (
                  <div className="ws-accountSignedInRow" style={styles.accountSignedInRow}>
                    <span className="ws-accountStatusDot" style={styles.accountStatusDot} />
                    <span className="ws-workspaceRowMeta" style={styles.workspaceRowMeta}>
                      Session active{accountSessionExpiresAt ? ` until ${formatDashboardDate(accountSessionExpiresAt)}` : ''}
                    </span>
                  </div>
                ) : (
                  <div className="ws-accountFormGrid" style={styles.accountFormGrid}>
                    {accountMode === 'register' && (
                      <input
                        className="ws-accountInput" style={styles.accountInput}
                        placeholder="Name"
                        aria-label="Account name"
                        value={accountName}
                        onChange={(event) => setAccountName(event.target.value)}
                        onKeyDown={(event) => event.key === 'Enter' && void submitAccountAuth()}
                        maxLength={80}
                      />
                    )}
                    <input
                      className="ws-accountInput" style={styles.accountInput}
                      placeholder="Email"
                      aria-label="Account email"
                      type="email"
                      value={accountEmail}
                      onChange={(event) => setAccountEmail(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && void submitAccountAuth()}
                      autoComplete="email"
                    />
                    <input
                      className="ws-accountInput" style={styles.accountInput}
                      placeholder="Password"
                      aria-label="Account password"
                      type="password"
                      value={accountPassword}
                      onChange={(event) => setAccountPassword(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && void submitAccountAuth()}
                      autoComplete={accountMode === 'register' ? 'new-password' : 'current-password'}
                    />
                    <button
                      className="ws-accountSubmitButton" style={styles.accountSubmitButton}
                      onClick={() => void submitAccountAuth()}
                      disabled={accountLoading}
                    >
                      {accountLoading ? 'Working...' : accountMode === 'register' ? 'Create Account' : 'Log in'}
                    </button>
                  </div>
                )}
                {accountError && <p className="ws-workspaceError" style={styles.workspaceError}>{accountError}</p>}
              </div>

</section>}
          {workspaceView === 'team' && <section className="workspace-surface">              <div className="ws-workspaceSection" style={styles.workspaceSection}>
                <div className="ws-workspaceSectionHeader" style={styles.workspaceSectionHeader}>
                  <span className="ws-workspaceSectionTitle" style={styles.workspaceSectionTitle}>Team roster</span>
                  <span className="ws-workspaceSectionCount" style={styles.workspaceSectionCount}>{workspaceDashboard.totalTeamMembers}/12</span>
                </div>
                <div className="ws-workspaceTeamForm" style={styles.workspaceTeamForm}>
                  <input
                    className="ws-workspaceInput" style={styles.workspaceInput}
                    aria-label="Team member name"
                    value={teamMemberName}
                    onChange={(event) => setTeamMemberName(event.target.value)}
                    placeholder="Name"
                    maxLength={80}
                  />
                  <input
                    className="ws-workspaceInput" style={styles.workspaceInput}
                    aria-label="Team member email"
                    value={teamMemberEmail}
                    onChange={(event) => setTeamMemberEmail(event.target.value)}
                    placeholder="Email"
                    maxLength={160}
                    type="email"
                  />
                  <select
                    className="ws-workspaceSelect" style={styles.workspaceSelect}
                    aria-label="Team member role"
                    value={teamMemberRole}
                    onChange={(event) => setTeamMemberRole(event.target.value as WorkspaceTeamRole)}
                  >
                    <option value="producer">Producer</option>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="guest-manager">Guest Manager</option>
                  </select>
                  <button
                    className="ws-workspaceAddButton" style={styles.workspaceAddButton}
                    onClick={addTeamMember}
                    disabled={!teamMemberName.trim()}
                  >
                    Add
                  </button>
                </div>
                {recentTeamMembers.length > 0 && (
                  <div className="ws-workspaceRows" style={styles.workspaceRows}>
                    {recentTeamMembers.map((member) => (
                      <div key={member.id} className="ws-workspaceRow" style={styles.workspaceRow}>
                        <span className="ws-workspaceRoleBadge" style={styles.workspaceRoleBadge}>{getWorkspaceTeamRoleLabel(member.role).slice(0, 1)}</span>
                        <div className="ws-workspaceRowCopy" style={styles.workspaceRowCopy}>
                          <span className="ws-workspaceRowTitle" style={styles.workspaceRowTitle}>{member.name}</span>
                          <span className="ws-workspaceRowMeta" style={styles.workspaceRowMeta}>
                            {getWorkspaceTeamRoleLabel(member.role)}{member.email ? ` | ${member.email}` : ''}
                          </span>
                        </div>
                        <button
                          className="ws-workspaceRowAction" style={styles.workspaceRowAction}
                          onClick={() => deleteTeamMember(member)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

<p className="section-footnote">Keep a production roster and generate call sheets from your studio's actions.</p></section>}
          {workspaceView === 'recordings' && <section className="workspace-surface">              {(recordingLibrary.isLoading || serverRecordingCatalogLoading || recentRecordings.length > 0) && (
                <div className="ws-workspaceSection" style={styles.workspaceSection}>
                  <div className="ws-workspaceSectionHeader" style={styles.workspaceSectionHeader}>
                    <span className="ws-workspaceSectionTitle" style={styles.workspaceSectionTitle}>All recordings</span>
                    <span className="ws-workspaceSectionCount" style={styles.workspaceSectionCount}>
                      {recordingLibrary.isLoading || serverRecordingCatalogLoading
                        ? 'Loading'
                        : `${workspaceDashboard.cloudRecordingCount} cloud | ${workspaceDashboard.readyMp4RecordingCount} MP4`}
                    </span>
                  </div>
                  {!recordingLibrary.isLoading && !serverRecordingCatalogLoading && (
                    <div className="ws-workspaceRows" style={styles.workspaceRows}>
                      {recentRecordings.map((session) => {
                        const exportState = getWorkspaceRecordingExportState(session);
                        const exportLabel = getWorkspaceRecordingExportLabel(session);
                        return (
                          <div key={session.id} className="ws-workspaceRow" style={styles.workspaceRow}>
                            <span className="ws-workspaceRecordingSourceBadge" style={styles.workspaceRecordingSourceBadge}>
                              {session.source === 'local-and-server' ? 'Both' : session.source === 'server' ? 'Cloud' : 'Local'}
                            </span>
                            {session.mediaExport && (
                              <span style={{
                                ...styles.workspaceRecordingExportBadge,
                                ...(exportState === 'ready' ? styles.workspaceRecordingExportBadgeReady : {}),
                                ...(exportState === 'error' ? styles.workspaceRecordingExportBadgeError : {}),
                              }}>
                                {exportState === 'ready' ? 'MP4' : exportState === 'error' ? 'Fix' : 'Mix'}
                              </span>
                            )}
                            <div className="ws-workspaceRowCopy" style={styles.workspaceRowCopy}>
                              <span className="ws-workspaceRowTitle" style={styles.workspaceRowTitle}>{session.roomName}</span>
                              <span className="ws-workspaceRowMeta" style={styles.workspaceRowMeta}>
                                {formatDashboardDate(session.createdAt)} | {formatWorkspaceDuration(session.durationSeconds)} | {session.trackCount} track{session.trackCount === 1 ? '' : 's'}
                              </span>
                              {session.mediaExport && (
                                <span style={{
                                  ...styles.workspaceRowMeta,
                                  ...(exportState === 'ready' ? styles.workspaceRowMetaReady : {}),
                                  ...(exportState === 'error' ? styles.workspaceRowMetaError : {}),
                                }}>
                                  {exportLabel}
                                </span>
                              )}
                            </div>
                            <div className="ws-workspaceRowActions" style={styles.workspaceRowActions}>
                              {session.mediaExport?.mp4ShareUrl && (
                                <>
                                  <button
                                    className="ws-workspaceRowSecondaryAction" style={styles.workspaceRowSecondaryAction}
                                    onClick={() => openRecordingMp4ShareLink(session)}
                                  >
                                    Open
                                  </button>
                                  <button
                                    className="ws-workspaceRowSecondaryAction" style={styles.workspaceRowSecondaryAction}
                                    onClick={() => void copyRecordingMp4ShareLink(session)}
                                  >
                                    Copy
                                  </button>
                                </>
                              )}
                              {localRecordingIds.has(session.id) && (
                                <>
                                <button className="ws-workspaceRowAction" style={styles.workspaceRowAction} onClick={() => void downloadLocalRecording(session)} disabled={downloadingRecordingId !== null}>
                                  {downloadingRecordingId === session.id ? 'Preparing…' : 'Download tracks'}
                                </button>
                                <button
                                  className="ws-workspaceRowAction" style={styles.workspaceRowAction}
                                  onClick={() => void deleteDashboardRecordingSession(session)}
                                >
                                  Delete
                                </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

{!recordingLibrary.isLoading && !serverRecordingCatalogLoading && recentRecordings.length === 0 && <div className="workspace-empty"><span className="empty-icon"><StudioIcon name="recordings" /></span><h2>Your next story starts here</h2><p>Record a session in your studio to see it in your library.</p><button className="workspace-secondary" onClick={() => setWorkspaceView('studios')}>Go to studios <span>→</span></button></div>}</section>}
          {workspaceView === 'brand' && <section className="workspace-surface">              {recentBrandKits.length > 0 && (
                <div className="ws-workspaceSection" style={styles.workspaceSection}>
                  <div className="ws-workspaceSectionHeader" style={styles.workspaceSectionHeader}>
                    <span className="ws-workspaceSectionTitle" style={styles.workspaceSectionTitle}>Brand kits</span>
                    <span className="ws-workspaceSectionCount" style={styles.workspaceSectionCount}>{recentBrandKits.length}/{workspaceDashboard.totalBrandKits}</span>
                  </div>
                  <div className="ws-workspaceRows" style={styles.workspaceRows}>
                    {recentBrandKits.map((kit) => (
                      <div key={kit.id} className="ws-workspaceRow" style={styles.workspaceRow}>
                        <span style={{ ...styles.workspaceBrandSwatch, background: kit.brandColor }} />
                        <div className="ws-workspaceRowCopy" style={styles.workspaceRowCopy}>
                          <span className="ws-workspaceRowTitle" style={styles.workspaceRowTitle}>{kit.name}</span>
                          <span className="ws-workspaceRowMeta" style={styles.workspaceRowMeta}>
                            {kit.studioTheme} | {kit.logoUrl ? 'Logo saved' : 'No logo'} | {kit.stageBackground.type}
                            {!localBrandKitIds.has(kit.id) ? ' | Cloud' : ''}
                          </span>
                        </div>
                        {localBrandKitIds.has(kit.id) && (
                          <button
                            className="ws-workspaceRowAction" style={styles.workspaceRowAction}
                            onClick={() => deleteBrandKit(kit)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
{recentBrandKits.length === 0 && <div className="workspace-empty"><span className="empty-icon"><StudioIcon name="brand" /></span><h2>Make it unmistakably yours</h2><p>Open Brand inside a studio to save your logo, colors,<br />and background as a reusable brand kit.</p><button className="workspace-secondary" onClick={() => setWorkspaceView('studios')}>Go to studios <span>→</span></button></div>}</section>}
          <footer className="workspace-footer"><span>Good conversations start here.</span><div><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link></div></footer>
        </main>
      </div>
      {showCreate && !scheduledRoom && <WorkspaceDialog title="Create a studio" onClose={() => { if (!loading && !schedulingLoading) setShowCreate(false); }}>          <div className="ws-card" style={styles.card}>
            <div className="ws-cardInner" style={styles.cardInner}>
              <h2 id="create-studio-title" className="ws-cardTitle" style={styles.cardTitle}>Create a studio</h2>
              <p className="ws-cardSub" style={styles.cardSub}>Set up your broadcast in seconds</p>

              <div className="ws-field" style={styles.field}>
                <label className="ws-label" style={styles.label} htmlFor="studio-name">Studio name</label>
                <input
                  className="ws-input" style={styles.input}
                  id="studio-name" autoFocus placeholder="e.g. The Morning Show"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                />
              </div>

              <div className="ws-field" style={styles.field}>
                <label className="ws-label" style={styles.label} htmlFor="host-name">Your name</label>
                <input
                  className="ws-input" style={styles.input}
                  id="host-name" placeholder="How guests will see you"
                  value={hostName}
                  onChange={(e) => setHostName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                  maxLength={50}
                />
              </div>

              <details className="setup-options"><summary>Scheduling & guest access</summary>
              <div className="ws-field" style={styles.field}>
                <label className="ws-label" style={styles.label} htmlFor="schedule-time">Schedule time (optional)</label>
                <input
                  className="ws-input" style={styles.input}
                  id="schedule-time" type="datetime-local"
                  value={scheduledFor}
                  min={minScheduleDateTime}
                  onChange={(e) => setScheduledFor(e.target.value)}
                />
              </div>

              <div className="ws-field" style={styles.field}>
                <label className="ws-label" style={styles.label} htmlFor="guest-password">Guest password (optional)</label>
                <input
                  className="ws-input" style={styles.input}
                  type="password"
                  id="guest-password" placeholder="Require guests to enter a password"
                  value={roomPassword}
                  onChange={(e) => setRoomPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                  maxLength={100}
                  autoComplete="new-password"
                />
                <p className="ws-fieldHint" style={styles.fieldHint}>Hosts can still enter with the creator session.</p>
              </div>

              <label className="ws-registrationToggle" style={styles.registrationToggle}>
                <input
                  type="checkbox"
                  checked={registrationEnabled}
                  onChange={(e) => setRegistrationEnabled(e.target.checked)}
                />
                <span className="ws-registrationToggleCopy" style={styles.registrationToggleCopy}>
                  <span className="ws-registrationToggleTitle" style={styles.registrationToggleTitle}>Collect guest registration</span>
                  <span className="ws-registrationToggleText" style={styles.registrationToggleText}>Guests enter name and email before joining; hosts can export a CSV.</span>
                </span>
              </label>

              </details>
              {error && (
                <p className="ws-error" style={styles.error}>{error}</p>
              )}
              {progressMessage && !error && (
                <p className="ws-progress" style={styles.progress}>{progressMessage}</p>
              )}

              <button
                className="btn-primary ws-button" style={styles.button}
                onClick={createRoom}
                disabled={loading || schedulingLoading || !roomName.trim() || !hostName.trim()}
              >
                {loading ? (
                  <span className="ws-loadingInner" style={styles.loadingInner}>
                    <span className="ws-loadingDot" style={styles.loadingDot} />
                    Creating...
                  </span>
                ) : (
                  'Create Studio'
                )}
              </button>

              <div className="ws-divider" style={styles.divider}>
                <span className="ws-dividerLine" style={styles.dividerLine} />
                <span className="ws-dividerText" style={styles.dividerText}>or</span>
                <span className="ws-dividerLine" style={styles.dividerLine} />
              </div>

              <button
                className="ws-scheduleButton" style={styles.scheduleButton}
                onClick={scheduleRoom}
                disabled={loading || schedulingLoading || !roomName.trim() || !hostName.trim()}
              >
                {schedulingLoading ? (
                  <span className="ws-loadingInner" style={styles.loadingInner}>
                    <span style={{ ...styles.loadingDot, background: 'var(--accent)' }} />
                    Scheduling...
                  </span>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8, flexShrink: 0 }}>
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    Schedule & Get Invite Link
                  </>
                )}
              </button>
            </div>
          </div>

</WorkspaceDialog>}

      {/* Invite Link Modal */}
      {scheduledRoom && (
        <WorkspaceDialog title="Studio scheduled" onClose={closeModal}>
          <div className="ws-modal" style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className="ws-modalIcon" style={styles.modalIcon}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>

            <h3 className="ws-modalTitle" style={styles.modalTitle}>Studio Scheduled</h3>
            <p className="ws-modalSub" style={styles.modalSub}>
              <strong>{scheduledRoom.name}</strong> is ready. Share this invite link with your guests.
            </p>
            {scheduledRoom.scheduledFor && (
              <p className="ws-modalSchedule" style={styles.modalSchedule}>
                Scheduled for {new Date(scheduledRoom.scheduledFor).toLocaleString([], {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            )}
            {scheduledRoom.passwordProtected && (
              <p className="ws-modalSchedule" style={styles.modalSchedule}>Password protected. Share the password with guests separately.</p>
            )}
            {scheduledRoom.registrationEnabled && (
              <p className="ws-modalSchedule" style={styles.modalSchedule}>Guest registration is on. You can export registrants from Your Studios.</p>
            )}

            <div className="ws-linkBox" style={styles.linkBox}>
              <input
                className="ws-linkInput" style={styles.linkInput}
                value={inviteLink}
                readOnly
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button className="ws-copyButton" style={styles.copyButton} onClick={copyToClipboard}>
                {copied ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
                {copied ? 'Copied!' : 'Copy Guest'}
              </button>
            </div>

            <div className="ws-modalQrCard" style={styles.modalQrCard}>
              <div className="ws-modalQrPreview" style={styles.modalQrPreview}>
                {scheduledQrDataUrl ? (
                  <img src={scheduledQrDataUrl} alt="Guest invite QR code" className="ws-modalQrImage" style={styles.modalQrImage} />
                ) : (
                  <div className="ws-modalQrPlaceholder" style={styles.modalQrPlaceholder}>
                    {scheduledQrError ? (
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                    ) : (
                      <span className="ws-modalQrLoadingDot" style={styles.modalQrLoadingDot} />
                    )}
                  </div>
                )}
              </div>
              <div className="ws-modalQrCopy" style={styles.modalQrCopy}>
                <span className="ws-modalQrLabel" style={styles.modalQrLabel}>Guest QR</span>
                <span className="ws-modalQrText" style={styles.modalQrText}>Guests can scan this to open the join link on a phone.</span>
                {scheduledQrError && <span className="ws-modalQrError" style={styles.modalQrError}>{scheduledQrError}</span>}
              </div>
            </div>

            <div className="ws-modalActions" style={styles.modalActions}>
              <button
                className="btn-primary ws-modalStartButton" style={styles.modalStartButton}
                onClick={goToStudioAsHost}
              >
                Start Studio Now
              </button>
              <button className="ws-modalDoneButton" style={styles.modalDoneButton} onClick={copyHostEntryLink}>
                {hostCopied ? 'Host Link Copied' : 'Copy Host Link'}
              </button>
              <button className="ws-modalDoneButton" style={styles.modalDoneButton} onClick={emailScheduledGuestInvite}>
                Email Guest
              </button>
              <button className="ws-modalDoneButton" style={styles.modalDoneButton} onClick={downloadScheduledInviteQr} disabled={!scheduledQrDataUrl}>
                Download QR
              </button>
              {scheduledRoom.scheduledFor && (
                <button className="ws-modalDoneButton" style={styles.modalDoneButton} onClick={() => downloadCalendarInvite(scheduledRoom)}>
                  Calendar
                </button>
              )}
              <button className="ws-modalDoneButton" style={styles.modalDoneButton} onClick={closeModal}>
                Done
              </button>
            </div>
          </div>
        </WorkspaceDialog>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    width: '100%',
    maxWidth: 420,
    flex: '1 1 380px',
    background: 'rgba(255, 255, 255, 0.04)',
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.28)',
    overflow: 'hidden',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  cardInner: {
    padding: '28px 28px 32px',
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 4,
    letterSpacing: '-0.01em',
    color: 'rgba(226, 232, 240, 0.92)',
  },
  cardSub: {
    fontSize: 13,
    color: 'var(--text-muted)',
    marginBottom: 24,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    display: 'block',
    fontSize: 13,
    color: 'var(--text-secondary)',
    marginBottom: 6,
    fontWeight: 500,
  },
  fieldHint: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 5,
  },
  input: {
    width: '100%',
  },
  registrationToggle: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '11px 12px',
    marginBottom: 14,
    borderRadius: 12,
    border: '1px solid rgba(103, 232, 249, 0.14)',
    background: 'rgba(103, 232, 249, 0.06)',
    cursor: 'pointer',
  },
  registrationToggleCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    minWidth: 0,
  },
  registrationToggleTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: '#a5f3fc',
  },
  registrationToggleText: {
    fontSize: 11,
    color: 'var(--text-muted)',
    lineHeight: 1.35,
  },
  button: {
    width: '100%',
    padding: '12px 20px',
    fontSize: 15,
    fontWeight: 600,
    marginTop: 8,
    letterSpacing: '-0.01em',
    borderRadius: 12,
  },
  loadingInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'white',
    animation: 'pulse 1s infinite',
  },
  error: {
    fontSize: 13,
    color: '#ef4444',
    marginTop: 0,
    marginBottom: 8,
    lineHeight: 1.4,
  },
  progress: {
    fontSize: 12,
    color: '#93c5fd',
    marginTop: 0,
    marginBottom: 8,
    lineHeight: 1.4,
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    margin: '16px 0',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: 'rgba(255, 255, 255, 0.06)',
  },
  dividerText: {
    fontSize: 12,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  scheduleButton: {
    width: '100%',
    padding: '12px 20px',
    fontSize: 14,
    fontWeight: 600,
    background: 'transparent',
    color: '#67e8f9',
    border: '1.5px solid rgba(103, 232, 249, 0.3)',
    borderRadius: 12,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.18s ease',
    letterSpacing: '-0.01em',
  },
  workspaceHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14,
  },
  workspaceHeaderCopy: {
    minWidth: 0,
  },
  workspaceHeaderActions: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 7,
    flexWrap: 'wrap',
  },
  workspaceHeaderAction: {
    minHeight: 28,
    borderRadius: 8,
    border: '1px solid rgba(103, 232, 249, 0.2)',
    background: 'rgba(103, 232, 249, 0.08)',
    color: '#a5f3fc',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
    padding: '0 10px',
  },
  workspaceImportInput: {
    display: 'none',
  },
  workspaceTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'rgba(226, 232, 240, 0.94)',
    letterSpacing: 0,
    marginBottom: 3,
  },
  workspaceSubtitle: {
    fontSize: 12,
    color: 'var(--text-muted)',
    lineHeight: 1.35,
  },
  workspaceBadge: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    color: '#bbf7d0',
    background: 'rgba(34, 197, 94, 0.1)',
    border: '1px solid rgba(34, 197, 94, 0.18)',
  },
  accountPanel: {
    borderRadius: 12,
    border: '1px solid rgba(167, 139, 250, 0.14)',
    background: 'rgba(167, 139, 250, 0.06)',
    padding: 12,
    marginBottom: 12,
  },
  accountHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  accountHeaderCopy: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  accountModeToggle: {
    flexShrink: 0,
    display: 'inline-grid',
    gridTemplateColumns: '1fr 1fr',
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
  },
  accountModeButton: {
    minHeight: 28,
    border: 0,
    background: 'rgba(15, 23, 42, 0.38)',
    color: 'var(--text-muted)',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
    padding: '0 10px',
  },
  accountModeButtonActive: {
    background: 'rgba(167, 139, 250, 0.28)',
    color: '#ddd6fe',
  },
  accountFormGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: 8,
  },
  accountInput: {
    minWidth: 0,
    minHeight: 34,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.09)',
    background: 'rgba(15, 23, 42, 0.42)',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 650,
    padding: '0 10px',
    outline: 'none',
  },
  accountSubmitButton: {
    minHeight: 34,
    borderRadius: 8,
    border: '1px solid rgba(167, 139, 250, 0.24)',
    background: 'rgba(167, 139, 250, 0.22)',
    color: '#ddd6fe',
    fontSize: 12,
    fontWeight: 900,
    cursor: 'pointer',
    padding: '0 10px',
  },
  accountSignedInRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 26,
  },
  accountStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    background: '#34d399',
    boxShadow: '0 0 0 4px rgba(52, 211, 153, 0.08)',
  },
  workspaceError: {
    fontSize: 12,
    color: '#f87171',
    marginBottom: 10,
    lineHeight: 1.4,
  },
  workspaceSection: {
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
    paddingTop: 12,
    marginTop: 12,
  },
  workspaceSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
  },
  workspaceSectionTitle: {
    fontSize: 12,
    fontWeight: 800,
    color: 'rgba(226, 232, 240, 0.9)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  workspaceSectionCount: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
  },
  workspaceRows: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  workspaceTeamForm: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: 8,
    marginBottom: 10,
  },
  workspaceInput: {
    minWidth: 0,
    minHeight: 34,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.09)',
    background: 'rgba(15, 23, 42, 0.42)',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 650,
    padding: '0 10px',
    outline: 'none',
  },
  workspaceSelect: {
    minWidth: 0,
    minHeight: 34,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.09)',
    background: 'rgba(15, 23, 42, 0.42)',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 700,
    padding: '0 10px',
    outline: 'none',
  },
  workspaceAddButton: {
    minHeight: 34,
    borderRadius: 8,
    border: '1px solid rgba(34, 197, 94, 0.22)',
    background: 'rgba(34, 197, 94, 0.1)',
    color: '#bbf7d0',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
  },
  workspaceRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minHeight: 42,
  },
  workspaceRecordingSourceBadge: {
    flex: '0 0 42px',
    minHeight: 24,
    borderRadius: 8,
    border: '1px solid rgba(103, 232, 249, 0.2)',
    background: 'rgba(103, 232, 249, 0.08)',
    color: '#67e8f9',
    fontSize: 10,
    fontWeight: 900,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  workspaceRecordingExportBadge: {
    flex: '0 0 34px',
    minHeight: 24,
    borderRadius: 8,
    border: '1px solid rgba(167, 139, 250, 0.22)',
    background: 'rgba(167, 139, 250, 0.1)',
    color: '#ddd6fe',
    fontSize: 10,
    fontWeight: 900,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  workspaceRecordingExportBadgeReady: {
    borderColor: 'rgba(34, 197, 94, 0.24)',
    background: 'rgba(34, 197, 94, 0.1)',
    color: '#bbf7d0',
  },
  workspaceRecordingExportBadgeError: {
    borderColor: 'rgba(248, 113, 113, 0.22)',
    background: 'rgba(248, 113, 113, 0.08)',
    color: '#fca5a5',
  },
  workspaceRowCopy: {
    minWidth: 0,
    flex: '1 1 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  workspaceRowTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  workspaceRowMeta: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  workspaceRowMetaReady: {
    color: '#bbf7d0',
  },
  workspaceRowMetaError: {
    color: '#fca5a5',
  },
  workspaceRowActions: {
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    flexWrap: 'wrap',
  },
  workspaceRowAction: {
    flex: '0 0 68px',
    minHeight: 30,
    borderRadius: 8,
    border: '1px solid rgba(248, 113, 113, 0.18)',
    background: 'rgba(248, 113, 113, 0.06)',
    color: '#fca5a5',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
  },
  workspaceRowSecondaryAction: {
    flex: '0 0 48px',
    minHeight: 30,
    borderRadius: 8,
    border: '1px solid rgba(103, 232, 249, 0.22)',
    background: 'rgba(103, 232, 249, 0.08)',
    color: '#67e8f9',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
  },
  workspaceBrandSwatch: {
    flex: '0 0 18px',
    width: 18,
    height: 18,
    borderRadius: 999,
    border: '1px solid rgba(255, 255, 255, 0.18)',
  },
  workspaceRoleBadge: {
    flex: '0 0 24px',
    width: 24,
    height: 24,
    borderRadius: 999,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid rgba(103, 232, 249, 0.2)',
    background: 'rgba(103, 232, 249, 0.08)',
    color: '#a5f3fc',
    fontSize: 11,
    fontWeight: 900,
  },
  schedulePanel: {
    width: '100%',
    maxWidth: 460,
    flex: '1 1 360px',
    background: 'rgba(255, 255, 255, 0.035)',
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.22)',
    padding: 18,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  schedulePanelHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  schedulePanelTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: 'rgba(226, 232, 240, 0.94)',
    letterSpacing: '-0.01em',
  },
  schedulePanelCount: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    color: '#67e8f9',
    background: 'rgba(103, 232, 249, 0.1)',
    border: '1px solid rgba(103, 232, 249, 0.18)',
  },
  savedRoomList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  savedRoomCard: {
    borderRadius: 12,
    background: 'rgba(15, 23, 42, 0.5)',
    border: '1px solid rgba(255, 255, 255, 0.07)',
    padding: 12,
  },
  savedRoomTop: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
  savedRoomInfo: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  savedRoomName: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  savedRoomMeta: {
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  savedRoomBadge: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 800,
    color: '#22c55e',
    background: 'rgba(34, 197, 94, 0.1)',
    border: '1px solid rgba(34, 197, 94, 0.16)',
    padding: '4px 7px',
    borderRadius: 999,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  savedRoomBadgeUpcoming: {
    color: '#f59e0b',
    background: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.18)',
  },
  savedRoomActions: {
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  },
  savedRoomAction: {
    flex: '1 1 86px',
    minHeight: 32,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
  },
  savedRoomPrimaryAction: {
    background: '#2563eb',
    color: 'white',
    borderColor: '#2563eb',
  },
  savedRoomDangerAction: {
    color: '#f87171',
    borderColor: 'rgba(248, 113, 113, 0.18)',
  },

  // Modal styles
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 24,
    animation: 'fadeIn 0.2s ease-out',
  },
  modal: {
    background: 'rgba(15, 23, 42, 0.95)',
    borderRadius: 18,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.45)',
    padding: '32px 28px',
    width: '100%',
    maxWidth: 440,
    textAlign: 'center',
    position: 'relative',
    animation: 'scaleIn 0.3s ease-out',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  },
  modalIcon: {
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 600,
    marginBottom: 8,
    letterSpacing: '-0.01em',
  },
  modalSub: {
    fontSize: 14,
    color: 'var(--text-secondary)',
    marginBottom: 12,
    lineHeight: 1.5,
  },
  modalSchedule: {
    fontSize: 13,
    color: 'var(--accent-hover)',
    marginBottom: 24,
    lineHeight: 1.4,
  },
  linkBox: {
    display: 'flex',
    gap: 8,
    marginBottom: 24,
  },
  linkInput: {
    flex: 1,
    fontSize: 13,
    padding: '10px 12px',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 10,
    color: 'var(--text-primary)',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  modalQrCard: {
    display: 'grid',
    gridTemplateColumns: '108px minmax(0, 1fr)',
    gap: 12,
    alignItems: 'center',
    padding: 10,
    marginBottom: 20,
    borderRadius: 12,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.04)',
    textAlign: 'left',
  },
  modalQrPreview: {
    width: 108,
    height: 108,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    background: '#ffffff',
    overflow: 'hidden',
  },
  modalQrImage: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  },
  modalQrPlaceholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f8fafc',
  },
  modalQrLoadingDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: '#0f172a',
    animation: 'pulse 1s infinite',
  },
  modalQrCopy: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
  },
  modalQrLabel: {
    fontSize: 11,
    fontWeight: 800,
    color: '#67e8f9',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
  },
  modalQrText: {
    fontSize: 12,
    lineHeight: 1.4,
    color: 'var(--text-secondary)',
  },
  modalQrError: {
    fontSize: 11,
    color: '#fca5a5',
  },
  copyButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    background: 'var(--accent-solid)',
    color: 'white',
    border: 'none',
    borderRadius: 10,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'background 0.18s ease',
  },
  modalActions: {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap',
  },
  modalStartButton: {
    flex: 1,
    padding: '12px 20px',
    fontSize: 14,
    fontWeight: 600,
    borderRadius: 12,
  },
  modalDoneButton: {
    flex: 1,
    padding: '12px 20px',
    fontSize: 14,
    fontWeight: 600,
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-secondary)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'all 0.18s ease',
  },
};
