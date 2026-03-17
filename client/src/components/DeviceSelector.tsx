import { useEffect, useRef } from 'react';
import type { MediaDeviceInfo } from '../hooks/useMediaDevices.ts';

interface DeviceSelectorProps {
  audioDevices: MediaDeviceInfo[];
  videoDevices: MediaDeviceInfo[];
  audioOutputDevices: MediaDeviceInfo[];
  selectedAudioDeviceId: string;
  selectedVideoDeviceId: string;
  selectedAudioOutputDeviceId: string;
  onAudioDeviceChange: (deviceId: string) => void;
  onVideoDeviceChange: (deviceId: string) => void;
  onAudioOutputDeviceChange: (deviceId: string) => void;
  onClose: () => void;
}

export function DeviceSelector({
  audioDevices,
  videoDevices,
  audioOutputDevices,
  selectedAudioDeviceId,
  selectedVideoDeviceId,
  selectedAudioOutputDeviceId,
  onAudioDeviceChange,
  onVideoDeviceChange,
  onAudioOutputDeviceChange,
  onClose,
}: DeviceSelectorProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && e.target instanceof Node && !panelRef.current.contains(e.target)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label="Device Settings">
      <div ref={panelRef} style={styles.panel}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <h3 style={styles.title}>Device Settings</h3>
            <p style={styles.subtitle}>Choose your audio and video sources</p>
          </div>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close device settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {/* Microphone */}
          <DeviceGroup
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              </svg>
            }
            label="Microphone"
            devices={audioDevices}
            selectedId={selectedAudioDeviceId}
            onChange={onAudioDeviceChange}
            emptyText="No microphones detected"
          />

          {/* Camera */}
          <DeviceGroup
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            }
            label="Camera"
            devices={videoDevices}
            selectedId={selectedVideoDeviceId}
            onChange={onVideoDeviceChange}
            emptyText="No cameras detected"
          />

          {/* Speaker */}
          {audioOutputDevices.length > 0 && (
            <DeviceGroup
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              }
              label="Speaker"
              devices={audioOutputDevices}
              selectedId={selectedAudioOutputDeviceId}
              onChange={onAudioOutputDeviceChange}
              emptyText="No speakers detected"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DeviceGroup({
  icon,
  label,
  devices,
  selectedId,
  onChange,
  emptyText,
}: {
  icon: React.ReactNode;
  label: string;
  devices: MediaDeviceInfo[];
  selectedId: string;
  onChange: (id: string) => void;
  emptyText: string;
}) {
  return (
    <div style={groupStyles.group}>
      <div style={groupStyles.labelRow}>
        {icon}
        <span style={groupStyles.label}>{label}</span>
      </div>
      {devices.length > 0 ? (
        <select
          style={groupStyles.select}
          value={selectedId}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`Select ${label.toLowerCase()}`}
        >
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      ) : (
        <p style={groupStyles.empty}>{emptyText}</p>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    animation: 'fadeIn 0.15s ease-out',
  },
  panel: {
    background: 'var(--bg-secondary)',
    borderRadius: 'var(--radius-xl)',
    border: '1px solid var(--border)',
    width: '100%',
    maxWidth: 460,
    boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden',
    animation: 'scaleIn 0.2s ease-out',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: '20px 24px 16px',
    borderBottom: '1px solid var(--border)',
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
    letterSpacing: '-0.01em',
  },
  subtitle: {
    fontSize: 12,
    color: 'var(--text-muted)',
    marginTop: 2,
  },
  closeBtn: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    padding: 0,
    transition: 'all var(--transition)',
  },
  body: {
    padding: '20px 24px 28px',
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
};

const groupStyles: Record<string, React.CSSProperties> = {
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  labelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-secondary)',
  },
  select: {
    width: '100%',
    padding: '10px 36px 10px 12px',
    borderRadius: 'var(--radius)',
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
    cursor: 'pointer',
    appearance: 'none' as const,
    backgroundImage:
      'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\'%3E%3Cpath fill=\'%2352525b\' d=\'M6 8L1 3h10z\'/%3E%3C/svg%3E")',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
    transition: 'border-color var(--transition)',
  },
  empty: {
    fontSize: 13,
    color: 'var(--text-muted)',
    fontStyle: 'italic',
    margin: 0,
  },
};
