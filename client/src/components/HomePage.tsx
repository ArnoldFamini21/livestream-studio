import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { buildStudioCalendarInvite } from '@studio/shared';
import {
  buildHostEntryPath,
  buildHostEntryUrl,
  persistHostSession,
  readSavedHostStudios,
  removeSavedHostStudio,
  upsertSavedHostStudio,
  type SavedHostStudio,
} from '../utils/hostSession.ts';

const API_URL = import.meta.env.VITE_API_URL || '';
const INVITE_BASE_URL = import.meta.env.VITE_INVITE_BASE_URL || window.location.origin;
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

function getScheduleState(room: SavedScheduledStudio): string {
  if (!room.scheduledFor) return 'Ready';
  const scheduledAt = Date.parse(room.scheduledFor);
  if (!Number.isFinite(scheduledAt)) return 'Ready';
  return scheduledAt > Date.now() ? 'Upcoming' : 'Ready';
}

function buildGuestInviteDetails(room: SavedScheduledStudio, inviteUrl: string): string {
  return [
    room.name,
    room.hostName ? `Host: ${room.hostName}` : null,
    `Status: ${getScheduleState(room)}`,
    room.scheduledFor ? `Time: ${formatScheduledDate(room.scheduledFor)}` : null,
    `Join: ${inviteUrl}`,
    room.passwordProtected ? 'Password protected. Ask the host for the password.' : null,
  ].filter(Boolean).join('\n');
}

function buildGuestInviteEmailHref(room: SavedScheduledStudio, inviteUrl: string): string {
  const subject = encodeURIComponent(`Join ${room.name}`);
  const body = encodeURIComponent(buildGuestInviteDetails(room, inviteUrl));
  return `mailto:?subject=${subject}&body=${body}`;
}

export function HomePage() {
  const [roomName, setRoomName] = useState('');
  const [hostName, setHostName] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [roomPassword, setRoomPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [schedulingLoading, setSchedulingLoading] = useState(false);
  const [savedScheduledRooms, setSavedScheduledRooms] = useState<SavedScheduledStudio[]>(() => readSavedScheduledStudios());
  const navigate = useNavigate();

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

    try {
      const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: roomName,
          hostName,
          password: roomPassword.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error');
        setError(`Failed to create room: ${res.status} ${errorText}`);
        return;
      }
      const room = await res.json();
      if (typeof room.hostToken !== 'string') {
        setError('Studio was created, but host access was not returned. Please create a new studio.');
        return;
      }
      const savedHostName = room.hostName || hostName;
      // Scoped per room so old tokens don't leak across rooms.
      persistHostSession({ roomId: room.id, hostName: savedHostName, hostToken: room.hostToken });
      setSavedScheduledRooms(upsertSavedScheduledStudio({
        id: room.id,
        name: room.name,
        hostName: savedHostName,
        hostToken: room.hostToken,
        createdAt: room.createdAt || new Date().toISOString(),
        passwordProtected: Boolean(room.settings?.passwordProtected),
        status: room.status,
      }));
      navigate(buildHostEntryPath(room.id));
    } catch (err) {
      console.error('Failed to create room:', err);
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  const scheduleRoom = async () => {
    if (!roomName.trim() || !hostName.trim()) return;
    setSchedulingLoading(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/rooms/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: roomName,
          hostName,
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
          password: roomPassword.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error');
        setError(`Failed to schedule room: ${res.status} ${errorText}`);
        return;
      }
      const room = await res.json();
      const savedHostName = room.hostName || hostName;
      if (typeof room.hostToken !== 'string') {
        setError('Studio was scheduled, but host access was not returned. Please schedule it again.');
        return;
      }
      persistHostSession({ roomId: room.id, hostName: savedHostName, hostToken: room.hostToken });
      const savedRoom: ScheduledRoomModal = {
        id: room.id,
        name: room.name,
        hostName: savedHostName,
        hostToken: room.hostToken,
        createdAt: room.createdAt || new Date().toISOString(),
        scheduledFor: room.scheduledFor || undefined,
        passwordProtected: Boolean(room.settings?.passwordProtected),
        status: room.status,
      };
      setSavedScheduledRooms(upsertSavedScheduledStudio(savedRoom));
      setScheduledRoom(savedRoom);
      setCopied(false);
      setHostCopied(false);
    } catch (err) {
      console.error('Failed to schedule room:', err);
      setError('Network error. Please check your connection and try again.');
    } finally {
      setSchedulingLoading(false);
    }
  };

  const inviteLink = scheduledRoom ? `${INVITE_BASE_URL}/join/${scheduledRoom.id}` : '';
  const hostEntryLink = scheduledRoom ? buildHostEntryUrl(INVITE_BASE_URL, scheduledRoom.id, scheduledRoom.hostToken) : '';
  const buildInviteLink = (roomId: string) => `${INVITE_BASE_URL}/join/${roomId}`;
  const buildHostLink = (room: SavedScheduledStudio) => buildHostEntryUrl(INVITE_BASE_URL, room.id, room.hostToken);

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
    await writeClipboardText(buildInviteLink(room.id));
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
      inviteUrl: buildInviteLink(room.id),
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
      const dataUrl = await createInviteQrDataUrl(buildInviteLink(room.id));
      downloadDataUrl(dataUrl, `${safeFileName(room.name)}_guest_invite_qr.png`);
    } catch {
      setError('Could not generate a QR code for that studio.');
    } finally {
      setSavedQrDownloadingId(null);
    }
  };

  const emailGuestInvite = (room: SavedScheduledStudio) => {
    window.location.href = buildGuestInviteEmailHref(room, buildInviteLink(room.id));
  };

  const emailScheduledGuestInvite = () => {
    if (!scheduledRoom || !inviteLink) return;
    window.location.href = buildGuestInviteEmailHref(scheduledRoom, inviteLink);
  };

  const openScheduledAsHost = (room: SavedScheduledStudio) => {
    persistHostSession({ roomId: room.id, hostName: room.hostName || hostName || 'Host', hostToken: room.hostToken });
    navigate(buildHostEntryPath(room.id));
  };

  const forgetScheduledRoom = (roomId: string) => {
    setSavedScheduledRooms(removeSavedScheduledStudio(roomId));
  };

  const goToStudioAsHost = () => {
    if (!scheduledRoom) return;
    persistHostSession({ roomId: scheduledRoom.id, hostName: scheduledRoom.hostName || hostName || 'Host', hostToken: scheduledRoom.hostToken });
    navigate(buildHostEntryPath(scheduledRoom.id));
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

          {savedScheduledRooms.length > 0 && (
            <section style={styles.schedulePanel}>
              <div style={styles.schedulePanelHeader}>
                <h2 style={styles.schedulePanelTitle}>Your Studios</h2>
                <span style={styles.schedulePanelCount}>{savedScheduledRooms.length}</span>
              </div>
              <div style={styles.savedRoomList}>
                {savedScheduledRooms.map((room) => {
                  const roomInviteLink = buildInviteLink(room.id);
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
