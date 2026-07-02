import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { buildStudioCalendarInvite } from '@studio/shared';
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
import { getApiErrorMessage, postJson } from '../utils/apiClient.ts';
import {
  hasCreatedRoomDetails,
  resolveCreatedRoomHostAccess,
  type CreatedRoomResponse,
} from '../utils/hostAccess.ts';
import { buildGuestInviteEmailHref, buildGuestInviteUrl } from '../utils/inviteLinks.ts';
import { useRecordingLibrary, type LocalRecordingSession } from '../hooks/useRecordingLibrary.ts';
import {
  BRAND_KIT_STORAGE_KEY,
  parseSavedBrandKits,
  serializeSavedBrandKits,
  type SavedBrandKit,
} from '../utils/brandKits.ts';
import {
  buildWorkspaceDashboardSummary,
  formatWorkspaceDuration,
  formatWorkspaceFileSize,
} from '../utils/workspaceDashboard.ts';
import {
  buildWorkspaceBackup,
  mergeWorkspaceBackup,
  parseWorkspaceBackupJson,
  serializeWorkspaceBackup,
} from '../utils/workspaceBackup.ts';
import {
  WORKSPACE_TEAM_STORAGE_KEY,
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
}

interface ScheduledRoomModal extends SavedScheduledStudio {}

function toDateTimeLocalValue(date: Date): string {
  const timezoneOffsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - timezoneOffsetMs).toISOString().slice(0, 16);
}

function readSavedScheduledStudios(): SavedScheduledStudio[] {
  return readSavedHostStudios()
    .filter((item): item is SavedScheduledStudio => (
      typeof item.name === 'string' &&
      typeof item.createdAt === 'string'
    ))
    .map((item) => ({
      ...item,
      passwordProtected: Boolean(item.passwordProtected),
    }));
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
    status: room.status,
  };
}

export function HomePage() {
  const [roomName, setRoomName] = useState('');
  const [hostName, setHostName] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
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
  const navigate = useNavigate();
  const recordingLibrary = useRecordingLibrary();
  const workspaceImportInputRef = useRef<HTMLInputElement | null>(null);

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
      setSavedScheduledRooms(upsertSavedScheduledStudio(toSavedScheduledRoom(room, savedHostName, hostToken)));
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
      setSavedScheduledRooms(upsertSavedScheduledStudio(savedRoom));
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
  const workspaceDashboard = useMemo(
    () => buildWorkspaceDashboardSummary(savedScheduledRooms, recordingLibrary.sessions, savedBrandKits, savedTeamMembers),
    [savedScheduledRooms, recordingLibrary.sessions, savedBrandKits, savedTeamMembers]
  );
  const recentRecordings = recordingLibrary.sessions.slice(0, 3);
  const recentBrandKits = savedBrandKits.slice(0, 4);
  const recentTeamMembers = savedTeamMembers.slice(0, 5);

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
    setSavedScheduledRooms(removeSavedScheduledStudio(roomId));
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
  };

  const exportWorkspaceBackup = () => {
    if (savedScheduledRooms.length > 0 && !window.confirm('Workspace backups include private host links for saved studios. Keep the exported file private.')) {
      return;
    }
    const backup = buildWorkspaceBackup({
      studios: savedScheduledRooms,
      brandKits: savedBrandKits,
      teamMembers: savedTeamMembers,
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
      setSavedScheduledRooms(readSavedScheduledStudios());
      setSavedBrandKits(result.brandKits);
      setSavedTeamMembers(result.teamMembers);
      setDashboardNotice(
        `Imported ${result.importedStudios} studios, ${result.importedBrandKits} brand kits, and ${result.importedTeamMembers} team members.`
      );
    } catch (err) {
      setDashboardError(err instanceof Error ? err.message : 'Could not import that workspace backup.');
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
    setScheduledRoom(null);
    setCopied(false);
    setHostCopied(false);
    setScheduledQrDataUrl('');
    setScheduledQrError('');
    setRoomName('');
    setHostName('');
    setScheduledFor('');
    setRoomPassword('');
  };

  const minScheduleDateTime = toDateTimeLocalValue(new Date(Date.now() + 60_000));

  return (
    <div style={styles.page}>
      {/* Background glow effects */}
      <div style={styles.bgGlow1} />
      <div style={styles.bgGlow2} />

      <div style={styles.container}>
        {/* Logo / Brand */}
        <div style={styles.brand}>
          <div style={styles.logoMark}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="10" fill="url(#grad)" />
              <path d="M10 12L16 8L22 12V20L16 24L10 20V12Z" stroke="white" strokeWidth="1.5" fill="none" />
              <circle cx="16" cy="16" r="3" fill="white" />
              <defs>
                <linearGradient id="grad" x1="0" y1="0" x2="32" y2="32">
                  <stop stopColor="#a78bfa" />
                  <stop offset="1" stopColor="#67e8f9" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 style={styles.title}>Studio</h1>
        </div>

        <p style={styles.poweredBy}>
          Powered by{' '}
          <a href="https://arnoldfamini.com" target="_blank" rel="noopener noreferrer" style={styles.poweredByLink}>
            ArnoldFamini.com
          </a>
        </p>

        <p style={styles.tagline}>
          Professional live streaming & recording, right in your browser.
        </p>

        <div style={styles.contentGrid}>
          {/* Card */}
          <div style={styles.card}>
            <div style={styles.cardInner}>
              <h2 style={styles.cardTitle}>Create a studio</h2>
              <p style={styles.cardSub}>Set up your broadcast in seconds</p>

              <div style={styles.field}>
                <label style={styles.label}>Studio name</label>
                <input
                  style={styles.input}
                  placeholder="e.g. The Morning Show"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Your name</label>
                <input
                  style={styles.input}
                  placeholder="How guests will see you"
                  value={hostName}
                  onChange={(e) => setHostName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                  maxLength={50}
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Schedule time (optional)</label>
                <input
                  style={styles.input}
                  type="datetime-local"
                  value={scheduledFor}
                  min={minScheduleDateTime}
                  onChange={(e) => setScheduledFor(e.target.value)}
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Guest password (optional)</label>
                <input
                  style={styles.input}
                  type="password"
                  placeholder="Require guests to enter a password"
                  value={roomPassword}
                  onChange={(e) => setRoomPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && createRoom()}
                  maxLength={100}
                  autoComplete="new-password"
                />
                <p style={styles.fieldHint}>Hosts can still enter with the creator session.</p>
              </div>

              {error && (
                <p style={styles.error}>{error}</p>
              )}
              {progressMessage && !error && (
                <p style={styles.progress}>{progressMessage}</p>
              )}

              <button
                className="btn-primary"
                style={styles.button}
                onClick={createRoom}
                disabled={loading || !roomName.trim() || !hostName.trim()}
              >
                {loading ? (
                  <span style={styles.loadingInner}>
                    <span style={styles.loadingDot} />
                    Creating...
                  </span>
                ) : (
                  'Create Studio'
                )}
              </button>

              <div style={styles.divider}>
                <span style={styles.dividerLine} />
                <span style={styles.dividerText}>or</span>
                <span style={styles.dividerLine} />
              </div>

              <button
                style={styles.scheduleButton}
                onClick={scheduleRoom}
                disabled={schedulingLoading || !roomName.trim() || !hostName.trim()}
              >
                {schedulingLoading ? (
                  <span style={styles.loadingInner}>
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

          <section style={styles.workspacePanel} aria-label="Workspace dashboard">
              <div style={styles.workspaceHeader}>
                <div style={styles.workspaceHeaderCopy}>
                  <h2 style={styles.workspaceTitle}>Workspace</h2>
                  <p style={styles.workspaceSubtitle}>Saved studios, team, recordings, and brand assets</p>
                </div>
                <div style={styles.workspaceHeaderActions}>
                  <button
                    style={styles.workspaceHeaderAction}
                    onClick={exportWorkspaceBackup}
                  >
                    Export
                  </button>
                  <button
                    style={styles.workspaceHeaderAction}
                    onClick={openWorkspaceBackupImport}
                  >
                    Import
                  </button>
                  <span style={styles.workspaceBadge}>
                    {workspaceDashboard.totalStudios + workspaceDashboard.totalRecordings + workspaceDashboard.totalBrandKits + workspaceDashboard.totalTeamMembers}
                  </span>
                </div>
                <input
                  ref={workspaceImportInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={styles.workspaceImportInput}
                  onChange={(event) => void importWorkspaceBackup(event)}
                />
              </div>

              <div style={styles.workspaceStats}>
                <div style={styles.workspaceStat}>
                  <span style={styles.workspaceStatValue}>{workspaceDashboard.totalStudios}</span>
                  <span style={styles.workspaceStatLabel}>
                    {workspaceDashboard.upcomingStudios} upcoming | {workspaceDashboard.passwordProtectedStudios} locked
                  </span>
                </div>
                <div style={styles.workspaceStat}>
                  <span style={styles.workspaceStatValue}>{workspaceDashboard.totalRecordings}</span>
                  <span style={styles.workspaceStatLabel}>
                    {workspaceDashboard.totalRecordingTracks} tracks | {formatWorkspaceFileSize(workspaceDashboard.totalRecordingBytes)}
                  </span>
                </div>
                <div style={styles.workspaceStat}>
                  <span style={styles.workspaceStatValue}>{workspaceDashboard.totalBrandKits}</span>
                  <span style={styles.workspaceStatLabel}>
                    {workspaceDashboard.brandKitsWithLogo} logo | {workspaceDashboard.brandKitsWithBackground} background
                  </span>
                </div>
                <div style={styles.workspaceStat}>
                  <span style={styles.workspaceStatValue}>{workspaceDashboard.totalTeamMembers}</span>
                  <span style={styles.workspaceStatLabel}>
                    {workspaceDashboard.productionTeamMembers} production | roster
                  </span>
                </div>
              </div>

              <div style={styles.workspaceMetaGrid}>
                {workspaceDashboard.latestStudio && (
                  <div style={styles.workspaceMetaItem}>
                    <span style={styles.workspaceMetaLabel}>Latest studio</span>
                    <span style={styles.workspaceMetaValue}>{workspaceDashboard.latestStudio.name || 'Untitled studio'}</span>
                    <span style={styles.workspaceMetaSub}>{formatDashboardDate(workspaceDashboard.latestStudio.scheduledFor || workspaceDashboard.latestStudio.createdAt)}</span>
                  </div>
                )}
                {workspaceDashboard.latestRecording && (
                  <div style={styles.workspaceMetaItem}>
                    <span style={styles.workspaceMetaLabel}>Latest recording</span>
                    <span style={styles.workspaceMetaValue}>{workspaceDashboard.latestRecording.roomName}</span>
                    <span style={styles.workspaceMetaSub}>{formatDashboardDate(workspaceDashboard.latestRecording.createdAt)}</span>
                  </div>
                )}
                {workspaceDashboard.latestBrandKit && (
                  <div style={styles.workspaceMetaItem}>
                    <span style={styles.workspaceMetaLabel}>Latest brand kit</span>
                    <span style={styles.workspaceMetaValue}>{workspaceDashboard.latestBrandKit.name}</span>
                    <span style={styles.workspaceMetaSub}>{formatDashboardDate(workspaceDashboard.latestBrandKit.createdAt)}</span>
                  </div>
                )}
                {workspaceDashboard.latestTeamMember && (
                  <div style={styles.workspaceMetaItem}>
                    <span style={styles.workspaceMetaLabel}>Latest team</span>
                    <span style={styles.workspaceMetaValue}>{workspaceDashboard.latestTeamMember.name}</span>
                    <span style={styles.workspaceMetaSub}>{getWorkspaceTeamRoleLabel(workspaceDashboard.latestTeamMember.role)}</span>
                  </div>
                )}
              </div>

              {(dashboardError || recordingLibrary.error) && (
                <p style={styles.workspaceError}>{dashboardError || recordingLibrary.error}</p>
              )}
              {dashboardNotice && !dashboardError && !recordingLibrary.error && (
                <p style={styles.workspaceNotice}>{dashboardNotice}</p>
              )}

              <div style={styles.workspaceSection}>
                <div style={styles.workspaceSectionHeader}>
                  <span style={styles.workspaceSectionTitle}>Team roster</span>
                  <span style={styles.workspaceSectionCount}>{workspaceDashboard.totalTeamMembers}/12</span>
                </div>
                <div style={styles.workspaceTeamForm}>
                  <input
                    style={styles.workspaceInput}
                    value={teamMemberName}
                    onChange={(event) => setTeamMemberName(event.target.value)}
                    placeholder="Name"
                    maxLength={80}
                  />
                  <input
                    style={styles.workspaceInput}
                    value={teamMemberEmail}
                    onChange={(event) => setTeamMemberEmail(event.target.value)}
                    placeholder="Email"
                    maxLength={160}
                    type="email"
                  />
                  <select
                    style={styles.workspaceSelect}
                    value={teamMemberRole}
                    onChange={(event) => setTeamMemberRole(event.target.value as WorkspaceTeamRole)}
                  >
                    <option value="producer">Producer</option>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="guest-manager">Guest Manager</option>
                  </select>
                  <button
                    style={styles.workspaceAddButton}
                    onClick={addTeamMember}
                    disabled={!teamMemberName.trim()}
                  >
                    Add
                  </button>
                </div>
                {recentTeamMembers.length > 0 && (
                  <div style={styles.workspaceRows}>
                    {recentTeamMembers.map((member) => (
                      <div key={member.id} style={styles.workspaceRow}>
                        <span style={styles.workspaceRoleBadge}>{getWorkspaceTeamRoleLabel(member.role).slice(0, 1)}</span>
                        <div style={styles.workspaceRowCopy}>
                          <span style={styles.workspaceRowTitle}>{member.name}</span>
                          <span style={styles.workspaceRowMeta}>
                            {getWorkspaceTeamRoleLabel(member.role)}{member.email ? ` | ${member.email}` : ''}
                          </span>
                        </div>
                        <button
                          style={styles.workspaceRowAction}
                          onClick={() => deleteTeamMember(member)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {(recordingLibrary.isLoading || recentRecordings.length > 0) && (
                <div style={styles.workspaceSection}>
                  <div style={styles.workspaceSectionHeader}>
                    <span style={styles.workspaceSectionTitle}>Recent recordings</span>
                    <span style={styles.workspaceSectionCount}>
                      {recordingLibrary.isLoading ? 'Loading' : `${workspaceDashboard.cloudRecordingCount} cloud`}
                    </span>
                  </div>
                  {!recordingLibrary.isLoading && (
                    <div style={styles.workspaceRows}>
                      {recentRecordings.map((session) => (
                        <div key={session.id} style={styles.workspaceRow}>
                          <div style={styles.workspaceRowCopy}>
                            <span style={styles.workspaceRowTitle}>{session.roomName}</span>
                            <span style={styles.workspaceRowMeta}>
                              {formatDashboardDate(session.createdAt)} | {formatWorkspaceDuration(session.durationSeconds)} | {session.trackCount} track{session.trackCount === 1 ? '' : 's'}
                            </span>
                          </div>
                          <button
                            style={styles.workspaceRowAction}
                            onClick={() => void deleteRecordingSession(session)}
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {recentBrandKits.length > 0 && (
                <div style={styles.workspaceSection}>
                  <div style={styles.workspaceSectionHeader}>
                    <span style={styles.workspaceSectionTitle}>Brand kits</span>
                    <span style={styles.workspaceSectionCount}>{recentBrandKits.length}/{workspaceDashboard.totalBrandKits}</span>
                  </div>
                  <div style={styles.workspaceRows}>
                    {recentBrandKits.map((kit) => (
                      <div key={kit.id} style={styles.workspaceRow}>
                        <span style={{ ...styles.workspaceBrandSwatch, background: kit.brandColor }} />
                        <div style={styles.workspaceRowCopy}>
                          <span style={styles.workspaceRowTitle}>{kit.name}</span>
                          <span style={styles.workspaceRowMeta}>
                            {kit.studioTheme} | {kit.logoUrl ? 'Logo saved' : 'No logo'} | {kit.stageBackground.type}
                          </span>
                        </div>
                        <button
                          style={styles.workspaceRowAction}
                          onClick={() => deleteBrandKit(kit)}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

          {savedScheduledRooms.length > 0 && (
            <section style={styles.schedulePanel}>
              <div style={styles.schedulePanelHeader}>
                <h2 style={styles.schedulePanelTitle}>Your Studios</h2>
                <span style={styles.schedulePanelCount}>{savedScheduledRooms.length}</span>
              </div>
              <div style={styles.savedRoomList}>
                {savedScheduledRooms.map((room) => {
                  const roomInviteLink = buildInviteLink(room);
                  const scheduleState = getScheduleState(room);
                  return (
                    <div key={room.id} style={styles.savedRoomCard}>
                      <div style={styles.savedRoomTop}>
                        <div style={styles.savedRoomInfo}>
                          <span style={styles.savedRoomName}>{room.name}</span>
                          <span style={styles.savedRoomMeta}>{formatScheduledDate(room.scheduledFor)}</span>
                        </div>
                        <span style={{
                          ...styles.savedRoomBadge,
                          ...(scheduleState === 'Upcoming' ? styles.savedRoomBadgeUpcoming : {}),
                        }}>
                          {scheduleState}
                        </span>
                      </div>

                      <div style={styles.savedRoomLink}>{roomInviteLink}</div>

                      <div style={styles.savedRoomActions}>
                        <button
                          style={styles.savedRoomAction}
                          onClick={() => copySavedInviteLink(room)}
                        >
                          {savedRoomCopiedId === room.id ? 'Copied' : 'Guest Link'}
                        </button>
                        <button
                          style={styles.savedRoomAction}
                          onClick={() => emailGuestInvite(room)}
                        >
                          Email
                        </button>
                        <button
                          style={styles.savedRoomAction}
                          onClick={() => copySavedHostLink(room)}
                        >
                          {savedHostCopiedId === room.id ? 'Copied' : 'Host Link'}
                        </button>
                        <button
                          style={styles.savedRoomAction}
                          onClick={() => void downloadSavedInviteQr(room)}
                          disabled={savedQrDownloadingId === room.id}
                        >
                          {savedQrDownloadingId === room.id ? 'QR...' : 'QR'}
                        </button>
                        {room.scheduledFor && (
                          <button
                            style={styles.savedRoomAction}
                            onClick={() => downloadCalendarInvite(room)}
                          >
                            Calendar
                          </button>
                        )}
                        <button
                          style={{ ...styles.savedRoomAction, ...styles.savedRoomPrimaryAction }}
                          onClick={() => openScheduledAsHost(room)}
                        >
                          Host
                        </button>
                        <button
                          style={{ ...styles.savedRoomAction, ...styles.savedRoomDangerAction }}
                          onClick={() => forgetScheduledRoom(room.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
	        </div>

        <p style={styles.hint}>
          Have an invite link? Just open it to join as a guest -- no sign-up needed.
        </p>

        <div style={styles.legalLinks}>
          <Link to="/privacy" style={styles.legalLink}>Privacy Policy</Link>
          <span style={styles.legalSep}>|</span>
          <Link to="/terms" style={styles.legalLink}>Terms of Service</Link>
        </div>
      </div>

      {/* Invite Link Modal */}
      {scheduledRoom && (
        <div style={styles.modalOverlay} onClick={closeModal}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <button style={styles.modalClose} onClick={closeModal}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>

            <div style={styles.modalIcon}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            </div>

            <h3 style={styles.modalTitle}>Studio Scheduled</h3>
            <p style={styles.modalSub}>
              <strong>{scheduledRoom.name}</strong> is ready. Share this invite link with your guests.
            </p>
            {scheduledRoom.scheduledFor && (
              <p style={styles.modalSchedule}>
                Scheduled for {new Date(scheduledRoom.scheduledFor).toLocaleString([], {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            )}
            {scheduledRoom.passwordProtected && (
              <p style={styles.modalSchedule}>Password protected. Share the password with guests separately.</p>
            )}

            <div style={styles.linkBox}>
              <input
                style={styles.linkInput}
                value={inviteLink}
                readOnly
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button style={styles.copyButton} onClick={copyToClipboard}>
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

            <div style={styles.modalQrCard}>
              <div style={styles.modalQrPreview}>
                {scheduledQrDataUrl ? (
                  <img src={scheduledQrDataUrl} alt="Guest invite QR code" style={styles.modalQrImage} />
                ) : (
                  <div style={styles.modalQrPlaceholder}>
                    {scheduledQrError ? (
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                    ) : (
                      <span style={styles.modalQrLoadingDot} />
                    )}
                  </div>
                )}
              </div>
              <div style={styles.modalQrCopy}>
                <span style={styles.modalQrLabel}>Guest QR</span>
                <span style={styles.modalQrText}>Guests can scan this to open the join link on a phone.</span>
                {scheduledQrError && <span style={styles.modalQrError}>{scheduledQrError}</span>}
              </div>
            </div>

            <div style={styles.modalActions}>
              <button
                className="btn-primary"
                style={styles.modalStartButton}
                onClick={goToStudioAsHost}
              >
                Start Studio Now
              </button>
              <button style={styles.modalDoneButton} onClick={copyHostEntryLink}>
                {hostCopied ? 'Host Link Copied' : 'Copy Host Link'}
              </button>
              <button style={styles.modalDoneButton} onClick={emailScheduledGuestInvite}>
                Email Guest
              </button>
              <button style={styles.modalDoneButton} onClick={downloadScheduledInviteQr} disabled={!scheduledQrDataUrl}>
                Download QR
              </button>
              {scheduledRoom.scheduledFor && (
                <button style={styles.modalDoneButton} onClick={() => downloadCalendarInvite(scheduledRoom)}>
                  Calendar
                </button>
              )}
              <button style={styles.modalDoneButton} onClick={closeModal}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100%',
    padding: 24,
    position: 'relative',
    overflowY: 'auto',
    overflowX: 'hidden',
  },
  bgGlow1: {
    position: 'absolute',
    top: '-20%',
    left: '-10%',
    width: 600,
    height: 600,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(167, 139, 250, 0.06) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  bgGlow2: {
    position: 'absolute',
    bottom: '-30%',
    right: '-10%',
    width: 500,
    height: 500,
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(103, 232, 249, 0.04) 0%, transparent 70%)',
    pointerEvents: 'none',
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    width: '100%',
    maxWidth: 940,
    position: 'relative',
    zIndex: 1,
    animation: 'slideUp 0.5s ease-out',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  logoMark: {
    display: 'flex',
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: 'var(--text-primary)',
  },
  poweredBy: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginBottom: 8,
    textAlign: 'center',
    opacity: 0.7,
    letterSpacing: '0.03em',
  } as React.CSSProperties,
  poweredByLink: {
    color: '#67e8f9',
    textDecoration: 'none',
    fontWeight: 500,
  } as React.CSSProperties,
  tagline: {
    fontSize: 15,
    color: 'var(--text-secondary)',
    marginBottom: 28,
    textAlign: 'center',
    lineHeight: 1.5,
  },
  contentGrid: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 20,
    flexWrap: 'wrap',
    width: '100%',
  },
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
  workspacePanel: {
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
  workspaceStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
    gap: 8,
    marginBottom: 12,
  },
  workspaceStat: {
    minWidth: 0,
    borderRadius: 10,
    background: 'rgba(15, 23, 42, 0.42)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    padding: '10px 11px',
  },
  workspaceStatValue: {
    display: 'block',
    fontSize: 20,
    fontWeight: 800,
    color: 'var(--text-primary)',
    lineHeight: 1.1,
    marginBottom: 5,
  },
  workspaceStatLabel: {
    display: 'block',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-muted)',
    lineHeight: 1.3,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  workspaceMetaGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: 8,
    marginBottom: 12,
  },
  workspaceMetaItem: {
    minWidth: 0,
    display: 'grid',
    gridTemplateColumns: '96px minmax(0, 1fr)',
    gap: '2px 8px',
    alignItems: 'baseline',
    padding: '8px 0',
    borderTop: '1px solid rgba(255, 255, 255, 0.06)',
  },
  workspaceMetaLabel: {
    gridRow: '1 / span 2',
    fontSize: 10,
    fontWeight: 800,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  workspaceMetaValue: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  workspaceMetaSub: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  workspaceError: {
    fontSize: 12,
    color: '#f87171',
    marginBottom: 10,
    lineHeight: 1.4,
  },
  workspaceNotice: {
    fontSize: 12,
    color: '#67e8f9',
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
  savedRoomLink: {
    fontSize: 11,
    color: 'var(--text-muted)',
    fontFamily: 'monospace',
    lineHeight: 1.35,
    padding: '8px 9px',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, 0.035)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    wordBreak: 'break-all' as const,
    marginBottom: 10,
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
  hint: {
    marginTop: 20,
    fontSize: 13,
    color: 'var(--text-muted)',
    textAlign: 'center',
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
  modalClose: {
    position: 'absolute',
    top: 12,
    right: 12,
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    borderRadius: 6,
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
  legalLinks: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 16,
  },
  legalLink: {
    fontSize: 12,
    color: 'var(--text-muted)',
    textDecoration: 'none',
    opacity: 0.7,
  },
  legalSep: {
    fontSize: 12,
    color: 'var(--text-muted)',
    opacity: 0.4,
  },
};
