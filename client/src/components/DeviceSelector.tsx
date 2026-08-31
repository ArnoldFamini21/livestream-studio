import { useEffect, useRef } from 'react';
import type { MediaDeviceInfo } from '../hooks/useMediaDevices.ts';
import type { VirtualBackgroundConfig } from '../hooks/useVirtualBackground.ts';
import {
  VIDEO_QUALITY_PRESETS,
  type AudioProcessingPreferences,
  type VideoQualityPresetId,
} from '../utils/mediaPreferences.ts';
import { VirtualBackgroundPicker } from './VirtualBackgroundPicker.tsx';

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
  audioProcessing?: AudioProcessingPreferences;
  onAudioProcessingChange?: (next: AudioProcessingPreferences) => void;
  videoQuality?: VideoQualityPresetId;
  recommendedVideoQuality?: VideoQualityPresetId;
  onVideoQualityChange?: (next: VideoQualityPresetId) => void;
  onClose: () => void;
  // Virtual background controls. Optional so callers can opt out.
  virtualBackground?: VirtualBackgroundConfig;
  onVirtualBackgroundChange?: (next: VirtualBackgroundConfig) => void;
  virtualBackgroundReady?: boolean;
  virtualBackgroundError?: string | null;
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
  audioProcessing,
  onAudioProcessingChange,
  videoQuality,
  recommendedVideoQuality,
  onVideoQualityChange,
  onClose,
  virtualBackground,
  onVirtualBackgroundChange,
  virtualBackgroundReady,
  virtualBackgroundError,
}: DeviceSelectorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const updateAudioProcessing = (key: keyof AudioProcessingPreferences, value: boolean) => {
    if (!audioProcessing || !onAudioProcessingChange) return;
    onAudioProcessingChange({ ...audioProcessing, [key]: value });
  };

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
          <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose} aria-label="Close device settings">
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

          {videoQuality && onVideoQualityChange && (
            <div style={styles.qualitySection}>
              <div style={styles.processingHeader}>
                <span style={styles.processingTitle}>Camera Quality</span>
                <span style={styles.qualitySummary}>
                  {VIDEO_QUALITY_PRESETS.find((preset) => preset.id === videoQuality)?.label}
                </span>
              </div>
              <div style={styles.qualityGrid} role="group" aria-label="Camera quality">
                {VIDEO_QUALITY_PRESETS.map((preset) => {
                  const active = preset.id === videoQuality;
                  const recommended = preset.id === recommendedVideoQuality;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      style={{
                        ...styles.qualityOption,
                        ...(active ? styles.qualityOptionActive : {}),
                      }}
                      onClick={() => onVideoQualityChange(preset.id)}
                      aria-pressed={active}
                    >
                      <span style={styles.qualityLabelRow}>
                        <span style={styles.qualityLabel}>{preset.label}</span>
                        {recommended && <span style={styles.qualityBadge}>Suggested</span>}
                      </span>
                      <span style={styles.qualityDescription}>{preset.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

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

          {audioProcessing && onAudioProcessingChange && (
            <div style={styles.processingSection}>
              <div style={styles.processingHeader}>
                <span style={styles.processingTitle}>Audio Processing</span>
              </div>
              <div style={styles.processingGrid}>
                <label style={styles.processingOption}>
                  <span style={styles.processingLabel}>Echo cancellation</span>
                  <span style={styles.processingState}>{audioProcessing.echoCancellation ? 'On' : 'Off'}</span>
                  <input
                    type="checkbox"
                    checked={audioProcessing.echoCancellation}
                    onChange={(e) => updateAudioProcessing('echoCancellation', e.target.checked)}
                    aria-label="Toggle echo cancellation"
                    style={styles.processingCheckbox}
                  />
                </label>
                <label style={styles.processingOption}>
                  <span style={styles.processingLabel}>Noise suppression</span>
                  <span style={styles.processingState}>{audioProcessing.noiseSuppression ? 'On' : 'Off'}</span>
                  <input
                    type="checkbox"
                    checked={audioProcessing.noiseSuppression}
                    onChange={(e) => updateAudioProcessing('noiseSuppression', e.target.checked)}
                    aria-label="Toggle noise suppression"
                    style={styles.processingCheckbox}
                  />
                </label>
                <label style={styles.processingOption}>
                  <span style={styles.processingLabel}>Studio voice cleanup</span>
                  <span style={styles.processingState}>{audioProcessing.voiceIsolation ? 'On' : 'Off'}</span>
                  <input
                    type="checkbox"
                    checked={audioProcessing.voiceIsolation}
                    onChange={(e) => updateAudioProcessing('voiceIsolation', e.target.checked)}
                    aria-label="Toggle studio voice cleanup"
                    style={styles.processingCheckbox}
                  />
                </label>
              </div>
            </div>
          )}

          {virtualBackground && onVirtualBackgroundChange && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 4 }}>
              <VirtualBackgroundPicker
                value={virtualBackground}
                onChange={onVirtualBackgroundChange}
                warmingUp={virtualBackground.mode !== 'off' && !virtualBackgroundReady}
                error={virtualBackgroundError ?? null}
              />
            </div>
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
          className="device-select"
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
  processingSection: {
    borderTop: '1px solid var(--border)',
    paddingTop: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  processingHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  processingTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  processingGrid: {
    display: 'grid',
    gap: 8,
  },
  qualitySection: {
    borderTop: '1px solid var(--border)',
    paddingTop: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  qualitySummary: {
    fontSize: 11,
    fontWeight: 800,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
  },
  qualityGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 6,
  },
  qualityOption: {
    minWidth: 0,
    minHeight: 66,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 4,
    padding: '8px 7px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    textAlign: 'center',
  },
  qualityOptionActive: {
    background: 'rgba(124, 58, 237, 0.18)',
    borderColor: 'rgba(167, 139, 250, 0.56)',
    color: '#ede9fe',
  },
  qualityLabel: {
    fontSize: 13,
    fontWeight: 900,
    lineHeight: 1.1,
  },
  qualityLabelRow: {
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    flexWrap: 'wrap',
  },
  qualityBadge: {
    maxWidth: '100%',
    padding: '1px 4px',
    borderRadius: 5,
    background: 'rgba(167, 139, 250, 0.12)',
    color: 'var(--accent-hover)',
    border: '1px solid rgba(167, 139, 250, 0.28)',
    fontSize: 8,
    fontWeight: 900,
    lineHeight: 1.1,
    textTransform: 'uppercase',
  },
  qualityDescription: {
    fontSize: 9,
    lineHeight: 1.25,
    color: 'var(--text-muted)',
  },
  processingOption: {
    minHeight: 42,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
    alignItems: 'center',
    gap: 10,
    padding: '9px 10px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    cursor: 'pointer',
  },
  processingLabel: {
    minWidth: 0,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  processingState: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
  },
  processingCheckbox: {
    width: 18,
    height: 18,
    accentColor: 'var(--accent)',
    cursor: 'pointer',
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
