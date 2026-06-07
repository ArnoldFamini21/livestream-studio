import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { buildStudioCalendarInvite } from '@studio/shared';

interface InvitePanelProps {
  roomName: string;
  roomId: string;
  hostName?: string;
  inviteUrl: string;
  scheduledFor?: string;
  passwordProtected: boolean;
  participantCount: number;
  waitingCount: number;
  isLive: boolean;
  onCreateCoHostInvite: () => Promise<{ inviteUrl: string; expiresAt: string }>;
  onClose: () => void;
}

type CopyTarget = 'link' | 'details' | 'co-host' | 'qr-image' | null;

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand('copy');
  document.body.removeChild(textArea);
}

async function copyImage(dataUrl: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Image copy is not supported in this browser.');
  }

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  await navigator.clipboard.write([
    new ClipboardItem({
      [blob.type || 'image/png']: blob,
    }),
  ]);
}

function downloadDataUrl(dataUrl: string, fileName: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  link.click();
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

function safeFileName(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'studio';
}

export function InvitePanel({
  roomName,
  roomId,
  hostName,
  inviteUrl,
  scheduledFor,
  passwordProtected,
  participantCount,
  waitingCount,
  isLive,
  onCreateCoHostInvite,
  onClose,
}: InvitePanelProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [coHostInvite, setCoHostInvite] = useState<{ inviteUrl: string; expiresAt: string } | null>(null);
  const [coHostError, setCoHostError] = useState<string | null>(null);
  const [isCreatingCoHostInvite, setIsCreatingCoHostInvite] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  const scheduledLabel = useMemo(() => {
    if (!scheduledFor) return null;
    return new Date(scheduledFor).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }, [scheduledFor]);

  const inviteDetails = useMemo(() => {
    const lines = [
      `${roomName}`,
      hostName ? `Host: ${hostName}` : null,
      `Status: ${isLive ? 'Live now' : 'Studio waiting room'}`,
      scheduledLabel ? `Time: ${scheduledLabel}` : null,
      `Join: ${inviteUrl}`,
      passwordProtected ? 'Password protected. Ask the host for the password.' : null,
    ].filter(Boolean);
    return lines.join('\n');
  }, [hostName, inviteUrl, isLive, passwordProtected, roomName, scheduledLabel]);

  const mailtoHref = useMemo(() => {
    const subject = encodeURIComponent(`Join ${roomName}`);
    const body = encodeURIComponent(inviteDetails);
    return `mailto:?subject=${subject}&body=${body}`;
  }, [inviteDetails, roomName]);

  const calendarInvite = useMemo(() => buildStudioCalendarInvite({
    roomName,
    hostName,
    inviteUrl,
    scheduledFor,
    uid: `studio-${roomId}`,
    passwordProtected,
  }), [hostName, inviteUrl, passwordProtected, roomId, roomName, scheduledFor]);

  const coHostExpiresLabel = useMemo(() => {
    if (!coHostInvite) return null;
    return new Date(coHostInvite.expiresAt).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }, [coHostInvite]);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    setQrError(null);

    QRCode.toDataURL(inviteUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 224,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrError('Could not generate QR code.');
      });

    return () => {
      cancelled = true;
    };
  }, [inviteUrl]);

  const handleCopy = async (target: Exclude<CopyTarget, null>, text: string) => {
    try {
      await copyText(text);
      setCopied(target);
      setCopyError(null);
    } catch {
      setCopyError('Could not copy. Select the link and copy it manually.');
    }
  };

  const handleCopyQr = async () => {
    if (!qrDataUrl) return;
    try {
      await copyImage(qrDataUrl);
      setCopied('qr-image');
      setCopyError(null);
    } catch {
      setCopyError('Could not copy QR image. Download it instead.');
    }
  };

  const handleDownloadQr = () => {
    if (!qrDataUrl) return;
    downloadDataUrl(qrDataUrl, `${safeFileName(roomName)}_guest_invite_qr.png`);
  };

  const handleDownloadCalendar = () => {
    if (!calendarInvite) return;
    downloadTextFile(calendarInvite, `${safeFileName(roomName)}_calendar.ics`, 'text/calendar;charset=utf-8');
  };

  const handleCreateCoHostInvite = async () => {
    if (isCreatingCoHostInvite) return;
    setIsCreatingCoHostInvite(true);
    setCoHostError(null);
    try {
      const invite = await onCreateCoHostInvite();
      setCoHostInvite(invite);
      await copyText(invite.inviteUrl);
      setCopied('co-host');
      setCopyError(null);
    } catch (err) {
      setCoHostError(err instanceof Error ? err.message : 'Could not create co-host invite.');
    } finally {
      setIsCreatingCoHostInvite(false);
    }
  };

  return (
    <div
      style={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-panel-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={styles.panel}>
        <div style={styles.header}>
          <div>
            <span style={styles.kicker}>{isLive ? 'Live Studio' : 'Studio Invite'}</span>
            <h2 id="invite-panel-title" style={styles.title}>Invite Guests</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            style={styles.closeBtn}
            onClick={onClose}
            aria-label="Close invite panel"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={styles.metaGrid}>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>Room</span>
            <span style={styles.metaValue}>{roomName}</span>
          </div>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>Code</span>
            <span style={styles.metaValue}>{roomId}</span>
          </div>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>In Session</span>
            <span style={styles.metaValue}>{participantCount}</span>
          </div>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>Waiting</span>
            <span style={styles.metaValue}>{waitingCount}</span>
          </div>
        </div>

        {copyError && (
          <div style={{ ...styles.notice, ...styles.errorNotice }} role="alert">
            <span style={styles.noticeIcon}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </span>
            <span>{copyError}</span>
          </div>
        )}

        {scheduledLabel && (
          <div style={styles.notice}>
            <span style={styles.noticeIcon}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </span>
            <span>{scheduledLabel}</span>
          </div>
        )}

        {passwordProtected && (
          <div style={{ ...styles.notice, ...styles.warningNotice }}>
            <span style={styles.noticeIcon}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            <span>Password protected</span>
          </div>
        )}

        <div style={styles.linkBox}>
          <label style={styles.linkLabel} htmlFor="studio-invite-url">Guest Link</label>
          <div style={styles.linkRow}>
            <input
              id="studio-invite-url"
              style={styles.linkInput}
              value={inviteUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              style={{ ...styles.copyBtn, ...(copied === 'link' ? styles.copyBtnDone : {}) }}
              onClick={() => void handleCopy('link', inviteUrl)}
            >
              {copied === 'link' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        <div style={styles.qrCard}>
          <div style={styles.qrPreview}>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="Guest invite QR code" style={styles.qrImage} />
            ) : (
              <div style={styles.qrPlaceholder}>
                {qrError ? (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fca5a5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                ) : (
                  <span style={styles.qrLoadingDot} />
                )}
              </div>
            )}
          </div>

          <div style={styles.qrContent}>
            <span style={styles.linkLabel}>Mobile Join</span>
            <p style={styles.qrText}>Guests can scan this code to open the invite link on their phone.</p>
            <div style={styles.qrActions}>
              <button
                type="button"
                style={{ ...styles.qrActionBtn, ...(copied === 'qr-image' ? styles.actionBtnDone : {}) }}
                onClick={() => void handleCopyQr()}
                disabled={!qrDataUrl}
              >
                {copied === 'qr-image' ? 'Copied QR' : 'Copy QR'}
              </button>
              <button
                type="button"
                style={styles.qrActionBtn}
                onClick={handleDownloadQr}
                disabled={!qrDataUrl}
              >
                Download
              </button>
            </div>
            {qrError && <span style={styles.errorText}>{qrError}</span>}
          </div>
        </div>

        <div style={styles.coHostBox}>
          <div style={styles.coHostHeader}>
            <div>
              <span style={styles.linkLabel}>Co-host Link</span>
              {coHostExpiresLabel && <span style={styles.expiryText}>Expires {coHostExpiresLabel}</span>}
            </div>
            {!coHostInvite && (
              <button
                type="button"
                style={styles.secondaryBtn}
                onClick={() => void handleCreateCoHostInvite()}
                disabled={isCreatingCoHostInvite}
              >
                {isCreatingCoHostInvite ? 'Creating...' : 'Create'}
              </button>
            )}
          </div>
          {coHostInvite && (
            <div style={styles.linkRow}>
              <input
                style={styles.linkInput}
                value={coHostInvite.inviteUrl}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                aria-label="Co-host invite link"
              />
              <button
                type="button"
                style={{ ...styles.copyBtn, ...(copied === 'co-host' ? styles.copyBtnDone : {}) }}
                onClick={() => void handleCopy('co-host', coHostInvite.inviteUrl)}
              >
                {copied === 'co-host' ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          {coHostError && <span style={styles.errorText}>{coHostError}</span>}
        </div>

        <div style={styles.actionRow}>
          <button
            type="button"
            style={{ ...styles.actionBtn, ...(copied === 'details' ? styles.actionBtnDone : {}) }}
            onClick={() => void handleCopy('details', inviteDetails)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            {copied === 'details' ? 'Copied Details' : 'Copy Details'}
          </button>
          <a style={styles.actionBtn} href={mailtoHref}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-10 6L2 7" />
            </svg>
            Email
          </a>
          {calendarInvite && (
            <button type="button" style={styles.actionBtn} onClick={handleDownloadCalendar}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              Calendar
            </button>
          )}
          <a style={styles.actionBtn} href={inviteUrl} target="_blank" rel="noreferrer">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
            </svg>
            Open
          </a>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 1900,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    background: 'rgba(2, 6, 23, 0.72)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  },
  panel: {
    width: 520,
    maxWidth: '100%',
    maxHeight: 'calc(100vh - 40px)',
    overflowY: 'auto',
    borderRadius: 12,
    border: '1px solid rgba(255, 255, 255, 0.1)',
    background: '#111827',
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.45)',
    padding: 18,
    color: 'var(--text-primary)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    marginBottom: 16,
  },
  kicker: {
    display: 'block',
    marginBottom: 4,
    fontSize: 11,
    fontWeight: 800,
    color: 'var(--accent)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  title: {
    margin: 0,
    fontSize: 20,
    lineHeight: 1.15,
    fontWeight: 800,
    letterSpacing: 0,
  },
  closeBtn: {
    width: 34,
    height: 34,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))',
    gap: 8,
    marginBottom: 12,
  },
  metaItem: {
    minWidth: 0,
    padding: '9px 10px',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
  },
  metaLabel: {
    display: 'block',
    marginBottom: 3,
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  metaValue: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 34,
    padding: '8px 10px',
    marginBottom: 8,
    borderRadius: 8,
    background: 'rgba(96, 165, 250, 0.1)',
    border: '1px solid rgba(96, 165, 250, 0.18)',
    color: '#bfdbfe',
    fontSize: 12,
    fontWeight: 700,
  },
  warningNotice: {
    background: 'rgba(245, 158, 11, 0.12)',
    border: '1px solid rgba(245, 158, 11, 0.22)',
    color: '#fcd34d',
  },
  errorNotice: {
    background: 'rgba(239, 68, 68, 0.12)',
    border: '1px solid rgba(239, 68, 68, 0.24)',
    color: '#fca5a5',
  },
  noticeIcon: {
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  linkBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    marginTop: 14,
    marginBottom: 12,
  },
  coHostBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 10,
    marginBottom: 12,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.07)',
    background: 'rgba(255, 255, 255, 0.035)',
  },
  coHostHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  linkLabel: {
    display: 'block',
    fontSize: 11,
    fontWeight: 800,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  expiryText: {
    display: 'block',
    marginTop: 3,
    fontSize: 11,
    color: 'var(--text-muted)',
  },
  linkRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: 8,
  },
  linkInput: {
    minWidth: 0,
    height: 40,
    padding: '0 12px',
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(15, 23, 42, 0.95)',
    color: 'var(--text-secondary)',
    fontSize: 13,
    outline: 'none',
  },
  qrCard: {
    display: 'grid',
    gridTemplateColumns: '116px minmax(0, 1fr)',
    gap: 12,
    alignItems: 'center',
    padding: 10,
    marginBottom: 12,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.07)',
    background: 'rgba(255, 255, 255, 0.035)',
  },
  qrPreview: {
    width: 116,
    height: 116,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    background: '#ffffff',
    overflow: 'hidden',
  },
  qrImage: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  },
  qrPlaceholder: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f8fafc',
  },
  qrLoadingDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: '#0f172a',
    animation: 'pulse 1s infinite',
  },
  qrContent: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  qrText: {
    margin: 0,
    color: 'var(--text-muted)',
    fontSize: 12,
    lineHeight: 1.4,
  },
  qrActions: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 8,
  },
  qrActionBtn: {
    minHeight: 34,
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.05)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
  },
  copyBtn: {
    height: 40,
    padding: '0 14px',
    borderRadius: 8,
    border: '1px solid var(--accent)',
    background: 'var(--accent)',
    color: 'white',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
  },
  copyBtnDone: {
    border: '1px solid rgba(34, 197, 94, 0.45)',
    background: 'rgba(34, 197, 94, 0.18)',
    color: '#86efac',
  },
  secondaryBtn: {
    height: 34,
    padding: '0 13px',
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.1)',
    background: 'rgba(255, 255, 255, 0.06)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
  },
  errorText: {
    fontSize: 11,
    color: '#fca5a5',
  },
  actionRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: 8,
  },
  actionBtn: {
    minHeight: 38,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    minWidth: 0,
    padding: '0 10px',
    borderRadius: 8,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    background: 'rgba(255, 255, 255, 0.05)',
    color: 'var(--text-secondary)',
    fontSize: 12,
    fontWeight: 800,
    textDecoration: 'none',
    cursor: 'pointer',
  },
  actionBtnDone: {
    border: '1px solid rgba(34, 197, 94, 0.35)',
    background: 'rgba(34, 197, 94, 0.14)',
    color: '#86efac',
  },
};
