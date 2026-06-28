import { useState } from 'react';
import type { BroadcastOrientation, StreamDestination } from '@studio/shared';
import type { SessionHealthSummary } from '../hooks/useSessionHealth.ts';
import type { RtmpRelayReadiness, RtmpRelayStats } from '../hooks/useRtmpRelay.ts';
import {
  getDefaultRtmpUrl,
  getEnabledDestinationPreflightIssue,
  getStreamDestinationIssue,
  maskStreamKey,
  MAX_ENABLED_DESTINATIONS,
} from '../utils/streamDestinations.ts';
import {
  formatRtmpRelayOutputSummary,
  getRtmpRelayOutputPreset,
  getRtmpRelayTargetKbps,
  RTMP_RELAY_OUTPUT_PRESETS,
  type RtmpRelayOutputPresetId,
} from '../utils/rtmpRelayOutput.ts';
import { formatRelayLatency } from '../utils/rtmpRelayLatency.ts';
import { buildLivePreflightChecklist, type LivePreflightStatus } from '../utils/livePreflight.ts';
import {
  MAX_STREAM_SCREEN_COUNTDOWN_SECONDS,
  normalizeStreamScreenConfig,
  type StreamScreenConfig,
  type StreamScreenDraft,
  type StreamScreenKind,
} from '../utils/streamScreens.ts';

interface StreamDestinationsProps {
  destinations: StreamDestination[];
  onAdd: (dest: Omit<StreamDestination, 'id' | 'status' | 'statusMessage'>) => void;
  onUpdate: (id: string, dest: Omit<StreamDestination, 'id' | 'status' | 'statusMessage'>) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
  broadcastOrientation: BroadcastOrientation;
  onBroadcastOrientationChange: (orientation: BroadcastOrientation) => void;
  relayOutputPreset: RtmpRelayOutputPresetId;
  onRelayOutputPresetChange: (preset: RtmpRelayOutputPresetId) => void;
  isLive: boolean;
  relayStats?: RtmpRelayStats;
  relayReadiness?: RtmpRelayReadiness;
  sessionHealth?: SessionHealthSummary;
  sceneCount?: number;
  streamScreenConfig: StreamScreenConfig;
  activeStreamScreenKind: StreamScreenKind | null;
  onStreamScreenConfigChange: (config: StreamScreenConfig) => void;
  onApplyStreamScreen: (kind: StreamScreenKind) => void;
  onClearStreamScreen: () => void;
  onRetryRelayReadiness?: () => void | Promise<unknown>;
  onGoLive: () => void | Promise<void>;
  onStopLive: () => void | Promise<void>;
  onClose: () => void;
}

const STALE_CHUNK_MS = 5_000;
const BITRATE_BAR_COUNT = 24;

const ORIENTATION_OPTIONS: Array<{ value: BroadcastOrientation; label: string; detail: string }> = [
  { value: 'landscape', label: 'Landscape', detail: '16:9 output' },
  { value: 'portrait', label: 'Portrait', detail: '9:16 output' },
];

const PLATFORMS: Array<{ value: StreamDestination['platform']; label: string; color: string; dashUrl?: string }> = [
  { value: 'youtube', label: 'YouTube', color: '#FF0000', dashUrl: 'https://studio.youtube.com/channel/UC/livestreaming' },
  { value: 'facebook', label: 'Facebook', color: '#1877F2', dashUrl: 'https://www.facebook.com/live/producer' },
  { value: 'twitch', label: 'Twitch', color: '#9146FF', dashUrl: 'https://dashboard.twitch.tv/broadcast' },
  { value: 'linkedin', label: 'LinkedIn', color: '#0A66C2', dashUrl: 'https://www.linkedin.com/video/golive/now/' },
  { value: 'instagram', label: 'Instagram', color: '#E4405F', dashUrl: 'https://www.instagram.com/live/producer/' },
  { value: 'custom', label: 'Custom RTMP', color: '#71717a' },
];

export function StreamDestinations({
  destinations,
  onAdd,
  onUpdate,
  onRemove,
  onToggle,
  broadcastOrientation,
  onBroadcastOrientationChange,
  relayOutputPreset,
  onRelayOutputPresetChange,
  isLive,
  relayStats,
  relayReadiness,
  sessionHealth,
  sceneCount = 0,
  streamScreenConfig,
  activeStreamScreenKind,
  onStreamScreenConfigChange,
  onApplyStreamScreen,
  onClearStreamScreen,
  onRetryRelayReadiness,
  onGoLive,
  onStopLive,
  onClose,
}: StreamDestinationsProps) {
  const [showForm, setShowForm] = useState(false);
  const [platform, setPlatform] = useState<StreamDestination['platform']>('youtube');
  const [name, setName] = useState('');
  const [rtmpUrl, setRtmpUrl] = useState('');
  const [streamKey, setStreamKey] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [editingDestinationId, setEditingDestinationId] = useState<string | null>(null);

  const resetForm = () => {
    setShowForm(false);
    setEditingDestinationId(null);
    setPlatform('youtube');
    setName('');
    setRtmpUrl('');
    setStreamKey('');
    setFormError(null);
  };

  const openCreateForm = () => {
    setShowForm(true);
    setEditingDestinationId(null);
    setPlatform('youtube');
    setName('');
    setRtmpUrl(getDefaultRtmpUrl('youtube'));
    setStreamKey('');
    setFormError(null);
  };

  const openEditForm = (destination: StreamDestination) => {
    setShowForm(true);
    setEditingDestinationId(destination.id);
    setPlatform(destination.platform);
    setName(destination.name);
    setRtmpUrl(destination.rtmpUrl);
    setStreamKey('');
    setFormError(null);
  };

  const handleSave = () => {
    const platformInfo = PLATFORMS.find((p) => p.value === platform);
    const existing = editingDestinationId
      ? destinations.find((destination) => destination.id === editingDestinationId)
      : undefined;
    const finalRtmp = rtmpUrl.trim() || getDefaultRtmpUrl(platform);
    const finalStreamKey = streamKey.trim() || existing?.streamKey || '';
    const issue = getStreamDestinationIssue({ rtmpUrl: finalRtmp, streamKey: finalStreamKey });
    if (issue) {
      setFormError(issue);
      return;
    }

    const savedDestination = {
      platform,
      name: name.trim() || platformInfo?.label || 'Stream',
      rtmpUrl: finalRtmp,
      streamKey: finalStreamKey,
      enabled: true,
    };

    if (editingDestinationId) {
      onUpdate(editingDestinationId, {
        ...savedDestination,
        enabled: existing?.enabled ?? true,
      });
    } else {
      onAdd(savedDestination);
    }
    resetForm();
  };

  const enabledDestinations = destinations.filter((d) => d.enabled);
  const enabledIssues = enabledDestinations
    .map((dest) => ({ dest, issue: getStreamDestinationIssue(dest) }))
    .filter((item): item is { dest: StreamDestination; issue: string } => Boolean(item.issue));
  const enabledCount = enabledDestinations.length;
  const selectedOrientation = ORIENTATION_OPTIONS.find((option) => option.value === broadcastOrientation) || ORIENTATION_OPTIONS[0];
  const selectedOutputPreset = getRtmpRelayOutputPreset(relayOutputPreset);
  const selectedOutputSummary = formatRtmpRelayOutputSummary(broadcastOrientation, relayOutputPreset);
  const relayTargetKbps = getRtmpRelayTargetKbps(relayOutputPreset);
  const tooManyEnabled = enabledCount > MAX_ENABLED_DESTINATIONS;
  const relayIssue = getRelayReadinessIssue(relayReadiness);
  const relayStatus = getRelayReadinessStatus(relayReadiness);
  const livePreflight = buildLivePreflightChecklist({
    destinations,
    relayReadiness,
    sessionHealth,
    sceneCount,
    outputSummary: selectedOutputSummary,
  });
  const preflightIssue = livePreflight.blockingIssue || getEnabledDestinationPreflightIssue(destinations, relayIssue);
  const canGoLive = enabledCount > 0 && enabledIssues.length === 0 && !tooManyEnabled && !relayIssue && !livePreflight.blockingIssue;
  const relayQuality = relayStats ? getRelayQuality(relayStats, relayTargetKbps, selectedOutputPreset.label) : null;
  const bitrateBars = relayStats ? buildBitrateBars(relayStats.bitrateHistory, relayTargetKbps, BITRATE_BAR_COUNT) : [];
  const normalizedStreamScreens = normalizeStreamScreenConfig(streamScreenConfig);
  const updateStreamScreen = (kind: StreamScreenKind, patch: Partial<StreamScreenDraft>) => {
    onStreamScreenConfigChange(normalizeStreamScreenConfig({
      ...normalizedStreamScreens,
      [kind]: {
        ...normalizedStreamScreens[kind],
        ...patch,
      },
    }));
  };
  const renderStreamScreenCard = (kind: StreamScreenKind, label: string) => {
    const screen = normalizedStreamScreens[kind];
    const active = activeStreamScreenKind === kind;

    return (
      <div key={kind} style={{ ...styles.screenCard, ...(active ? styles.screenCardActive : {}) }}>
        <div style={styles.screenCardHeader}>
          <span style={styles.screenCardTitle}>{label}</span>
          {active && <span style={styles.screenActiveBadge}>Active</span>}
        </div>
        <input
          style={styles.screenInput}
          value={screen.headline}
          onChange={(event) => updateStreamScreen(kind, { headline: event.target.value })}
          aria-label={`${label} headline`}
        />
        <textarea
          style={styles.screenTextarea}
          value={screen.message}
          onChange={(event) => updateStreamScreen(kind, { message: event.target.value })}
          aria-label={`${label} message`}
          rows={2}
        />
        <div style={styles.screenOptionRow}>
          <button
            type="button"
            style={{
              ...styles.screenModeBtn,
              ...(screen.backgroundMode === 'brand' ? styles.screenModeBtnActive : {}),
            }}
            onClick={() => updateStreamScreen(kind, { backgroundMode: 'brand' })}
          >
            Brand
          </button>
          <button
            type="button"
            style={{
              ...styles.screenModeBtn,
              ...(screen.backgroundMode === 'stage' ? styles.screenModeBtnActive : {}),
            }}
            onClick={() => updateStreamScreen(kind, { backgroundMode: 'stage' })}
          >
            Stage
          </button>
          <label style={styles.screenCheckbox}>
            <input
              type="checkbox"
              checked={screen.showLogo}
              onChange={(event) => updateStreamScreen(kind, { showLogo: event.target.checked })}
            />
            Logo
          </label>
        </div>
        {kind === 'starting' && (
          <label style={styles.screenCountdownLabel}>
            <span>Countdown</span>
            <input
              type="number"
              min={0}
              max={MAX_STREAM_SCREEN_COUNTDOWN_SECONDS}
              step={15}
              style={styles.screenCountdownInput}
              value={screen.countdownSeconds ?? 0}
              onChange={(event) => updateStreamScreen(kind, { countdownSeconds: Number(event.target.value) })}
            />
          </label>
        )}
        <div style={styles.screenActionRow}>
          <button
            type="button"
            className="btn-secondary"
            style={{ ...styles.screenShowBtn, ...(active ? styles.screenShowBtnActive : {}) }}
            onClick={() => onApplyStreamScreen(kind)}
          >
            {active ? 'Refresh Screen' : 'Show Screen'}
          </button>
          {active && (
            <button type="button" className="btn-ghost" style={styles.screenClearBtn} onClick={onClearStreamScreen}>
              Clear
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Stream Destinations</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <p style={styles.subtitle}>{destinations.length} destination{destinations.length !== 1 ? 's' : ''}</p>
            {enabledCount > 1 && (
              <span style={styles.multistreamBadge}>Multistreaming ({enabledCount})</span>
            )}
          </div>
        </div>
        <button className="panel-close-btn" style={styles.closeBtn} onClick={onClose} aria-label="Close destinations panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={styles.body}>
        <div style={styles.orientationCard}>
          <div style={styles.orientationHeader}>
            <span style={styles.orientationTitle}>Output Orientation</span>
            <span style={styles.orientationHint}>{selectedOrientation.detail}</span>
          </div>
          <div style={styles.orientationRow}>
            {ORIENTATION_OPTIONS.map((option) => {
              const active = option.value === broadcastOrientation;
              return (
                <button
                  key={option.value}
                  type="button"
                  style={{
                    ...styles.orientationBtn,
                    ...(active ? styles.orientationBtnActive : {}),
                    ...(isLive ? styles.orientationBtnDisabled : {}),
                  }}
                  onClick={() => onBroadcastOrientationChange(option.value)}
                  disabled={isLive}
                >
                  <span style={styles.orientationLabel}>{option.label}</span>
                  <span style={styles.orientationDetail}>{option.detail}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={styles.outputCard}>
          <div style={styles.outputHeader}>
            <span style={styles.outputTitle}>Output Quality</span>
            <span style={styles.outputHint}>{selectedOutputSummary}</span>
          </div>
          <div style={styles.outputPresetGrid}>
            {RTMP_RELAY_OUTPUT_PRESETS.map((preset) => {
              const active = preset.id === relayOutputPreset;
              return (
                <button
                  key={preset.id}
                  type="button"
                  style={{
                    ...styles.outputPresetBtn,
                    ...(active ? styles.outputPresetBtnActive : {}),
                    ...(isLive ? styles.outputPresetBtnDisabled : {}),
                  }}
                  onClick={() => onRelayOutputPresetChange(preset.id)}
                  disabled={isLive}
                >
                  <span style={styles.outputPresetLabel}>{preset.label}</span>
                  <span style={styles.outputPresetDetail}>{preset.detail}</span>
                </button>
              );
            })}
          </div>
        </div>

        {relayReadiness && (
          <div style={{
            ...styles.relayReadyCard,
            borderColor: relayStatus.border,
            background: relayStatus.background,
          }}>
            <div style={styles.relayReadyTop}>
              <div>
                <span style={styles.relayReadyLabel}>Media Relay</span>
                <p style={styles.relayReadyDetail}>{relayReadiness.message}</p>
              </div>
              <span style={{ ...styles.relayReadyBadge, color: relayStatus.color, borderColor: relayStatus.border }}>
                {relayStatus.label}
              </span>
            </div>
            {relayReadiness.status === 'unavailable' && onRetryRelayReadiness && !isLive && (
              <button
                type="button"
                className="btn-secondary"
                style={styles.retryRelayBtn}
                onClick={onRetryRelayReadiness}
              >
                Retry Check
              </button>
            )}
          </div>
        )}

        {destinations.length > 0 && (
          <div style={{ ...styles.preflight, ...(canGoLive ? styles.preflightReady : styles.preflightWarn) }}>
            <div style={styles.preflightTop}>
              <span style={styles.preflightLabel}>{canGoLive ? 'Ready to stream' : 'Needs setup'}</span>
              <span style={styles.preflightCount}>{enabledCount}/{MAX_ENABLED_DESTINATIONS} enabled</span>
            </div>
            {preflightIssue && <div style={styles.preflightIssue}>{preflightIssue}</div>}
          </div>
        )}

        <div style={styles.checklistCard}>
          <div style={styles.checklistHeader}>
            <div>
              <span style={styles.checklistTitle}>Go Live Checklist</span>
              <p style={styles.checklistSubtitle}>
                {livePreflight.blockedCount > 0
                  ? `${livePreflight.blockedCount} blocked item${livePreflight.blockedCount === 1 ? '' : 's'}`
                  : livePreflight.warningCount > 0
                    ? `${livePreflight.warningCount} item${livePreflight.warningCount === 1 ? '' : 's'} to review`
                    : 'All required checks are ready'}
              </p>
            </div>
            <span style={{
              ...styles.checklistBadge,
              color: getPreflightStatusColor(livePreflight.status),
              borderColor: getPreflightStatusBorder(livePreflight.status),
              background: getPreflightStatusBackground(livePreflight.status),
            }}>
              {livePreflight.label}
            </span>
          </div>
          <div style={styles.checklistList}>
            {livePreflight.items.map((item) => (
              <div key={item.id} style={styles.checklistItem}>
                <span style={{ ...styles.checklistDot, background: getPreflightStatusColor(item.status) }} />
                <div style={styles.checklistBody}>
                  <div style={styles.checklistTopLine}>
                    <span style={styles.checklistItemLabel}>{item.label}</span>
                    <span style={{ ...styles.checklistItemStatus, color: getPreflightStatusColor(item.status) }}>
                      {getPreflightStatusLabel(item.status)}
                    </span>
                  </div>
                  <p style={styles.checklistDetail}>{item.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={styles.screenSection}>
          <div style={styles.screenHeader}>
            <div>
              <span style={styles.screenTitle}>Stream Screens</span>
              <p style={styles.screenSubtitle}>{activeStreamScreenKind ? `${activeStreamScreenKind} screen on stage` : 'No screen on stage'}</p>
            </div>
            {activeStreamScreenKind && (
              <button type="button" className="btn-ghost" style={styles.screenHeaderClearBtn} onClick={onClearStreamScreen}>
                Clear
              </button>
            )}
          </div>
          {renderStreamScreenCard('starting', 'Starting')}
          {renderStreamScreenCard('ending', 'Ending')}
        </div>

        {isLive && relayStats && (
          <div style={styles.healthCard}>
            <div style={styles.healthTop}>
              <div>
                <span style={styles.healthLabel}>Stream Health</span>
                {relayQuality && <p style={styles.healthDetail}>{relayQuality.detail}</p>}
              </div>
              <span style={{
                ...styles.healthStatus,
                background: relayQuality?.background,
                borderColor: relayQuality?.border,
                color: relayQuality?.color,
              }}>
                {relayQuality?.label || relayStats.status}
              </span>
            </div>
            <div style={styles.bitrateGraph} aria-label="Recent upstream bitrate">
              {bitrateBars.map((bar, index) => (
                <span
                  key={`${index}-${bar}`}
                  style={{
                    ...styles.bitrateBar,
                    height: `${bar}%`,
                    background: bar >= 60 ? '#22c55e' : bar >= 25 ? '#f59e0b' : 'rgba(148, 163, 184, 0.7)',
                  }}
                />
              ))}
            </div>
            <div style={styles.healthGrid}>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{formatBitrate(relayStats.bitrateKbps)}</span>
                <span style={styles.healthCaption}>Upstream</span>
              </div>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{formatBytes(relayStats.sentBytes)}</span>
                <span style={styles.healthCaption}>Sent</span>
              </div>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{formatLastChunkAge(relayStats.lastChunkAt, relayStats.updatedAt)}</span>
                <span style={styles.healthCaption}>Last Chunk</span>
              </div>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{formatRelayLatency(relayStats.relayLatencyMs)}</span>
                <span style={styles.healthCaption}>Relay RTT</span>
              </div>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{relayStats.droppedChunks}</span>
                <span style={styles.healthCaption}>Dropped Chunks</span>
              </div>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{relayStats.droppedFrames}</span>
                <span style={styles.healthCaption}>Dropped Frames</span>
              </div>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{relayStats.reconnectAttempts}</span>
                <span style={styles.healthCaption}>Reconnects</span>
              </div>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{relayStats.chunksSent}</span>
                <span style={styles.healthCaption}>Chunks</span>
              </div>
              <div style={styles.healthMetric}>
                <span style={styles.healthValue}>{formatElapsed(relayStats.startedAt)}</span>
                <span style={styles.healthCaption}>Elapsed</span>
              </div>
            </div>
          </div>
        )}

        {/* Destinations list */}
        {destinations.map((dest) => {
          const platformInfo = PLATFORMS.find((p) => p.value === dest.platform);
          const issue = dest.enabled ? getStreamDestinationIssue(dest) : null;
          return (
            <div key={dest.id} className="participant-item" style={styles.destCard}>
              <div style={styles.destHeader}>
                <div style={{ ...styles.platformDot, background: platformInfo?.color }} />
                <div style={styles.destInfo}>
                  <span style={styles.destName}>{dest.name}</span>
                  <span style={styles.destPlatform}>{platformInfo?.label}</span>
                </div>
                <div style={styles.destActions}>
                  <span style={{
                    ...styles.statusBadge,
                    background: dest.status === 'live' ? 'rgba(34,197,94,0.12)' : dest.status === 'connecting' ? 'rgba(96,165,250,0.12)' : dest.status === 'error' || issue ? 'rgba(239,68,68,0.12)' : 'var(--bg-surface)',
                    color: dest.status === 'live' ? '#22c55e' : dest.status === 'connecting' ? '#60a5fa' : dest.status === 'error' || issue ? '#ef4444' : 'var(--text-muted)',
                  }}>
                    {issue ? 'error' : dest.status}
                  </span>
	                  <button
	                    type="button"
	                    style={{ ...styles.toggleBtn, background: dest.enabled ? 'var(--success)' : 'var(--bg-surface)', color: dest.enabled ? 'white' : 'var(--text-muted)', opacity: isLive ? 0.5 : 1, cursor: isLive ? 'not-allowed' : 'pointer' }}
	                    onClick={() => onToggle(dest.id)}
	                    disabled={isLive}
	                  >
	                    {dest.enabled ? 'ON' : 'OFF'}
	                  </button>
                  <button
                    type="button"
                    className="participant-action-btn"
                    style={{ ...styles.editBtn, opacity: isLive ? 0.5 : 1, cursor: isLive ? 'not-allowed' : 'pointer' }}
                    onClick={() => openEditForm(dest)}
                    disabled={isLive}
                    aria-label={`Edit ${dest.name}`}
                    title="Edit destination"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.83 2.83 0 014 4L8 20l-5 1 1-5 13-13z" />
                    </svg>
                  </button>
	                  <button type="button" className="participant-action-btn" style={{ ...styles.removeBtn, opacity: isLive ? 0.5 : 1, cursor: isLive ? 'not-allowed' : 'pointer' }} onClick={() => onRemove(dest.id)} disabled={isLive} aria-label="Remove destination">
	                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
	                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
              <div style={styles.destKey}>
                Key: {maskStreamKey(dest.streamKey)}
              </div>
              <div style={styles.destRtmp}>{dest.rtmpUrl}</div>
              {dest.statusMessage && !issue && <div style={styles.destStatusMessage}>{dest.statusMessage}</div>}
              {issue && <div style={styles.destIssue}>{issue}</div>}
            </div>
          );
        })}

        {/* Add destination form */}
        {showForm ? (
          <form style={styles.form} onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
            <div style={styles.formHeader}>
              <span style={styles.formTitle}>{editingDestinationId ? 'Edit Destination' : 'Add Destination'}</span>
              {editingDestinationId && <span style={styles.formMode}>Session only</span>}
            </div>
            <div style={styles.platformGrid}>
              {PLATFORMS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  className="hover-scale"
                  style={{
                    ...styles.platformBtn,
                    borderColor: platform === p.value ? p.color : 'var(--border)',
                    background: platform === p.value ? p.color + '15' : 'var(--bg-tertiary)',
                    color: platform === p.value ? p.color : 'var(--text-secondary)',
	                  }}
	                  onClick={() => {
	                    setPlatform(p.value);
	                    setRtmpUrl(getDefaultRtmpUrl(p.value));
	                    setFormError(null);
	                  }}
	                >
                  {p.label}
                </button>
              ))}
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Name (optional)</label>
              <input 
                style={styles.input} 
                placeholder={`e.g. My ${PLATFORMS.find(p => p.value === platform)?.label} Channel`} 
                value={name} 
                onChange={(e) => { setName(e.target.value); setFormError(null); }}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>RTMP Server URL</label>
              <input 
                style={{ 
                  ...styles.input, 
                  ...(platform !== 'custom' ? { background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)' } : {}) 
                }} 
                placeholder="rtmp://" 
                value={rtmpUrl || getDefaultRtmpUrl(platform)} 
                onChange={(e) => { setRtmpUrl(e.target.value); setFormError(null); }}
                readOnly={platform !== 'custom'} 
              />
              {platform === 'instagram' && (
                <span style={styles.inputHint}>Instagram Live expects portrait output.</span>
              )}
            </div>

            <div style={styles.inputGroup}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4 }}>
                <label style={{...styles.inputLabel, margin: 0}}>Stream Key</label>
                {PLATFORMS.find(p => p.value === platform)?.dashUrl && (
                  <a 
                    href={PLATFORMS.find(p => p.value === platform)?.dashUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    style={styles.keyLink}
                  >
                    Get {PLATFORMS.find(p => p.value === platform)?.label} Key
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4 }}>
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                )}
              </div>
              <input
                style={styles.input}
                placeholder={editingDestinationId ? 'Leave blank to keep current key' : 'Paste key here'}
                type="password"
                autoComplete="off"
                value={streamKey}
                onChange={(e) => { setStreamKey(e.target.value); setFormError(null); }}
              />
              {editingDestinationId && (
                <span style={styles.inputHint}>Leave blank to keep the current stream key.</span>
              )}
	            </div>

            {formError && <div style={styles.formError}>{formError}</div>}

	            <div style={styles.formActions}>
	              <button type="button" className="btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={resetForm}>Cancel</button>
	              <button type="submit" className="btn-primary" style={{ fontSize: 12, padding: '6px 14px' }} disabled={(!streamKey.trim() && !editingDestinationId) || isLive}>
                  {editingDestinationId ? 'Save Destination' : 'Add Destination'}
                </button>
	            </div>
	          </form>
	        ) : (
	          <button type="button" className="btn-secondary" style={{ ...styles.addBtn, opacity: isLive ? 0.5 : 1, cursor: isLive ? 'not-allowed' : 'pointer' }} onClick={openCreateForm} disabled={isLive}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Destination
          </button>
        )}

        {/* Go Live button */}
        <div style={styles.liveSection}>
          {isLive ? (
            <button className="btn-danger" style={styles.liveBtn} onClick={onStopLive}>
              <span style={styles.liveDotAnim} />
              Stop Streaming ({enabledCount} destination{enabledCount !== 1 ? 's' : ''})
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              style={{ ...styles.liveBtn, background: canGoLive ? '#ef4444' : 'var(--bg-surface)', color: canGoLive ? 'white' : 'var(--text-muted)' }}
              onClick={onGoLive}
              disabled={!canGoLive}
            >
              Go Live to {enabledCount} Destination{enabledCount !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function getRelayReadinessIssue(readiness: RtmpRelayReadiness | undefined): string | null {
  if (!readiness) return 'Media relay readiness has not been checked.';
  if (readiness.status === 'ready') return null;
  if (readiness.status === 'checking') return 'Media relay readiness check is still running.';
  return readiness.message;
}

function getRelayReadinessStatus(readiness: RtmpRelayReadiness | undefined) {
  if (readiness?.status === 'ready') {
    return {
      label: 'Ready',
      color: '#86efac',
      background: 'rgba(34,197,94,0.08)',
      border: 'rgba(34,197,94,0.22)',
    };
  }
  if (readiness?.status === 'unavailable') {
    return {
      label: 'Unavailable',
      color: '#fca5a5',
      background: 'rgba(239,68,68,0.09)',
      border: 'rgba(239,68,68,0.24)',
    };
  }
  return {
    label: 'Checking',
    color: '#93c5fd',
    background: 'rgba(96,165,250,0.08)',
    border: 'rgba(96,165,250,0.22)',
  };
}

function getPreflightStatusColor(status: LivePreflightStatus): string {
  switch (status) {
    case 'good': return '#86efac';
    case 'warning': return '#fcd34d';
    case 'bad': return '#fca5a5';
  }
}

function getPreflightStatusBackground(status: LivePreflightStatus): string {
  switch (status) {
    case 'good': return 'rgba(34, 197, 94, 0.1)';
    case 'warning': return 'rgba(245, 158, 11, 0.1)';
    case 'bad': return 'rgba(239, 68, 68, 0.1)';
  }
}

function getPreflightStatusBorder(status: LivePreflightStatus): string {
  switch (status) {
    case 'good': return 'rgba(34, 197, 94, 0.24)';
    case 'warning': return 'rgba(245, 158, 11, 0.25)';
    case 'bad': return 'rgba(239, 68, 68, 0.26)';
  }
}

function getPreflightStatusLabel(status: LivePreflightStatus): string {
  switch (status) {
    case 'good': return 'Ready';
    case 'warning': return 'Review';
    case 'bad': return 'Blocked';
  }
}

function formatBitrate(kbps: number): string {
  if (kbps <= 0) return '0 kbps';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${kbps} kbps`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatElapsed(startedAt: number | null): string {
  if (!startedAt) return '0:00';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

function formatLastChunkAge(lastChunkAt: number | null, updatedAt: number): string {
  if (!lastChunkAt) return 'waiting';
  const ageSeconds = Math.max(0, Math.floor(((updatedAt || Date.now()) - lastChunkAt) / 1000));
  if (ageSeconds <= 1) return 'now';
  if (ageSeconds < 60) return `${ageSeconds}s`;
  const minutes = Math.floor(ageSeconds / 60);
  const seconds = ageSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function getRelayQuality(stats: RtmpRelayStats, targetKbps: number, outputLabel: string) {
  const now = stats.updatedAt || Date.now();
  const chunkAge = stats.lastChunkAt ? now - stats.lastChunkAt : null;
  const safeTargetKbps = Math.max(1, targetKbps);

  if (stats.status === 'error') {
    return {
      label: 'Error',
      detail: 'Relay connection needs attention.',
      color: '#fca5a5',
      background: 'rgba(239, 68, 68, 0.12)',
      border: 'rgba(239, 68, 68, 0.25)',
    };
  }

  if (stats.status === 'connecting' || !stats.lastChunkAt) {
    return {
      label: 'Starting',
      detail: 'Waiting for browser upload chunks.',
      color: '#93c5fd',
      background: 'rgba(96, 165, 250, 0.12)',
      border: 'rgba(96, 165, 250, 0.25)',
    };
  }

  if (chunkAge !== null && chunkAge > STALE_CHUNK_MS) {
    return {
      label: 'Stalled',
      detail: `No upload chunk for ${formatLastChunkAge(stats.lastChunkAt, now)}.`,
      color: '#fca5a5',
      background: 'rgba(239, 68, 68, 0.12)',
      border: 'rgba(239, 68, 68, 0.25)',
    };
  }

  if ((stats.droppedChunks > 0 || stats.droppedFrames > 0) && stats.bitrateKbps < safeTargetKbps * 0.55) {
    return {
      label: 'Degraded',
      detail: stats.droppedFrames > 0
        ? 'Upload is live but frames were dropped before reaching the relay.'
        : 'Upload is live but chunks are being dropped.',
      color: '#fcd34d',
      background: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.25)',
    };
  }

  if (stats.bitrateKbps >= safeTargetKbps * 0.7) {
    return {
      label: 'Stable',
      detail: `Browser upload is near the ${outputLabel} target.`,
      color: '#86efac',
      background: 'rgba(34, 197, 94, 0.12)',
      border: 'rgba(34, 197, 94, 0.25)',
    };
  }

  if (stats.bitrateKbps > 0) {
    return {
      label: 'Low',
      detail: `Upload is below the ${formatBitrate(safeTargetKbps)} target.`,
      color: '#fcd34d',
      background: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.25)',
    };
  }

  return {
    label: 'Starting',
    detail: 'Preparing the first upload chunks.',
    color: '#93c5fd',
    background: 'rgba(96, 165, 250, 0.12)',
    border: 'rgba(96, 165, 250, 0.25)',
  };
}

function buildBitrateBars(history: RtmpRelayStats['bitrateHistory'], targetKbps: number, count: number): number[] {
  const samples = history.slice(-count);
  const padded = [
    ...Array(Math.max(0, count - samples.length)).fill({ at: 0, kbps: 0 }),
    ...samples,
  ];
  const maxKbps = Math.max(targetKbps, ...padded.map((sample) => sample.kbps), 1);
  return padded.map((sample) => {
    if (sample.kbps <= 0) return 4;
    return Math.max(10, Math.min(100, Math.round((sample.kbps / maxKbps) * 100)));
  });
}

const styles: Record<string, React.CSSProperties> = {
  panel: { width: 320, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border)', height: '100%' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' },
  title: { fontSize: 14, fontWeight: 600, margin: 0 },
  subtitle: { fontSize: 11, color: 'var(--text-muted)', margin: 0 },
  multistreamBadge: { 
    fontSize: 9, 
    fontWeight: 700, 
    background: 'rgba(167, 139, 250, 0.15)', 
    color: '#c4b5fd', 
    padding: '2px 6px', 
    borderRadius: 6, 
    textTransform: 'uppercase',
    letterSpacing: '0.04em'
  },
  closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex' },
  body: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 },
  orientationCard: { background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
  orientationHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  orientationTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  orientationHint: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 },
  orientationRow: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 },
  orientationBtn: {
    minWidth: 0,
    minHeight: 54,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 7,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 3,
    padding: '7px 8px',
    textAlign: 'left',
  },
  orientationBtnActive: { background: 'rgba(96, 165, 250, 0.12)', borderColor: '#60a5fa', color: '#bfdbfe' },
  orientationBtnDisabled: { opacity: 0.58, cursor: 'not-allowed' },
  orientationLabel: { fontSize: 12, fontWeight: 800, color: 'inherit' },
  orientationDetail: { fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  outputCard: { background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
  outputHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  outputTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  outputHint: { minWidth: 0, fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  outputPresetGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 },
  outputPresetBtn: {
    minWidth: 0,
    minHeight: 58,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 7,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    gap: 3,
    padding: '7px 7px',
    textAlign: 'left',
  },
  outputPresetBtnActive: { background: 'rgba(34, 197, 94, 0.1)', borderColor: '#22c55e', color: '#bbf7d0' },
  outputPresetBtnDisabled: { opacity: 0.58, cursor: 'not-allowed' },
  outputPresetLabel: { fontSize: 11, fontWeight: 800, color: 'inherit', lineHeight: 1.15 },
  outputPresetDetail: { fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.2 },
  preflight: { borderRadius: 8, padding: '10px 12px', border: '1px solid', display: 'flex', flexDirection: 'column', gap: 4 },
  preflightReady: { background: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.22)' },
  preflightWarn: { background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.22)' },
  preflightTop: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
  preflightLabel: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  preflightCount: { fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' },
  preflightIssue: { fontSize: 11, color: '#fbbf24', lineHeight: 1.35 },
  checklistCard: { background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 },
  checklistHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  checklistTitle: { fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' },
  checklistSubtitle: { margin: '2px 0 0', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35 },
  checklistBadge: { flexShrink: 0, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', borderRadius: 999, border: '1px solid', padding: '3px 7px', letterSpacing: 0 },
  checklistList: { display: 'flex', flexDirection: 'column', gap: 7 },
  checklistItem: { display: 'grid', gridTemplateColumns: '8px 1fr', gap: 8, alignItems: 'start' },
  checklistDot: { width: 8, height: 8, borderRadius: 999, marginTop: 4 },
  checklistBody: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  checklistTopLine: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  checklistItemLabel: { minWidth: 0, fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  checklistItemStatus: { flexShrink: 0, fontSize: 9, fontWeight: 800, textTransform: 'uppercase' },
  checklistDetail: { margin: 0, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35 },
  relayReadyCard: { borderRadius: 8, padding: '10px 12px', border: '1px solid', display: 'flex', flexDirection: 'column', gap: 8 },
  relayReadyTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  relayReadyLabel: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  relayReadyDetail: { margin: '2px 0 0', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35 },
  relayReadyBadge: { flexShrink: 0, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', borderRadius: 999, border: '1px solid', padding: '3px 7px', letterSpacing: 0 },
  retryRelayBtn: { alignSelf: 'flex-start', fontSize: 11, padding: '6px 10px' },
  screenSection: { background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
  screenHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  screenTitle: { fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' },
  screenSubtitle: { margin: '2px 0 0', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35, textTransform: 'capitalize' },
  screenHeaderClearBtn: { fontSize: 10, padding: '5px 8px', borderRadius: 6 },
  screenCard: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, background: 'rgba(0,0,0,0.12)', padding: 9, display: 'flex', flexDirection: 'column', gap: 7 },
  screenCardActive: { borderColor: 'rgba(96, 165, 250, 0.34)', background: 'rgba(96, 165, 250, 0.08)' },
  screenCardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  screenCardTitle: { fontSize: 11, fontWeight: 800, color: 'var(--text-secondary)' },
  screenActiveBadge: { flexShrink: 0, fontSize: 9, fontWeight: 800, textTransform: 'uppercase', color: '#93c5fd', border: '1px solid rgba(96, 165, 250, 0.28)', borderRadius: 999, padding: '2px 6px', background: 'rgba(96, 165, 250, 0.1)' },
  screenInput: { width: '100%', minWidth: 0, padding: '7px 9px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' },
  screenTextarea: { width: '100%', minWidth: 0, minHeight: 52, padding: '7px 9px', fontSize: 12, lineHeight: 1.35, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical' },
  screenOptionRow: { display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, alignItems: 'center' },
  screenModeBtn: { minWidth: 0, height: 30, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-tertiary)', color: 'var(--text-muted)', fontSize: 11, fontWeight: 800, cursor: 'pointer' },
  screenModeBtnActive: { borderColor: '#60a5fa', background: 'rgba(96, 165, 250, 0.12)', color: '#bfdbfe' },
  screenCheckbox: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, height: 30, padding: '0 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' },
  screenCountdownLabel: { display: 'grid', gridTemplateColumns: '1fr 82px', gap: 8, alignItems: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' },
  screenCountdownInput: { width: '100%', padding: '6px 7px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' },
  screenActionRow: { display: 'flex', alignItems: 'center', gap: 7 },
  screenShowBtn: { flex: 1, minWidth: 0, justifyContent: 'center', fontSize: 11, padding: '7px 9px', borderRadius: 7 },
  screenShowBtnActive: { borderColor: '#60a5fa', color: '#bfdbfe', background: 'rgba(96, 165, 250, 0.12)' },
  screenClearBtn: { fontSize: 11, padding: '7px 9px', borderRadius: 7 },
  healthCard: { background: 'rgba(255,255,255,0.035)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 },
  healthTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  healthLabel: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  healthDetail: { margin: '2px 0 0', fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.35 },
  healthStatus: { flexShrink: 0, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', borderRadius: 999, border: '1px solid', padding: '3px 7px', letterSpacing: 0 },
  bitrateGraph: { height: 38, display: 'flex', alignItems: 'flex-end', gap: 2, padding: '6px 6px 4px', borderRadius: 7, background: 'rgba(0,0,0,0.18)', overflow: 'hidden' },
  bitrateBar: { flex: 1, minWidth: 2, borderRadius: 2, transition: 'height 0.2s ease' },
  healthGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 },
  healthMetric: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, padding: '7px 8px', background: 'rgba(0,0,0,0.16)', borderRadius: 7 },
  healthValue: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  healthCaption: { fontSize: 9, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' },
  destCard: { background: 'var(--bg-tertiary)', borderRadius: 10, padding: '10px 12px', border: '1px solid var(--border)' },
  destHeader: { display: 'flex', alignItems: 'center', gap: 8 },
  platformDot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  destInfo: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  destName: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  destPlatform: { fontSize: 11, color: 'var(--text-muted)' },
  destActions: { display: 'flex', alignItems: 'center', gap: 4 },
  statusBadge: { fontSize: 9, fontWeight: 600, padding: '2px 6px', borderRadius: 4, textTransform: 'uppercase' as const },
  toggleBtn: { fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4, border: 'none', cursor: 'pointer' },
  editBtn: { width: 22, height: 22, borderRadius: 5, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
  removeBtn: { width: 22, height: 22, borderRadius: 5, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 },
  destKey: { fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'monospace' },
  destRtmp: { fontSize: 10, color: 'var(--text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' },
  destStatusMessage: { fontSize: 10, color: '#93c5fd', marginTop: 5, lineHeight: 1.35 },
  destIssue: { fontSize: 10, color: '#ef4444', marginTop: 5, lineHeight: 1.3 },
  form: { background: 'var(--bg-tertiary)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 12, border: '1px solid var(--border)' },
  formHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  formTitle: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  formMode: { fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0 },
  platformGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 },
  platformBtn: { fontSize: 11, fontWeight: 500, padding: '6px 4px', borderRadius: 6, border: '1px solid', cursor: 'pointer', background: 'var(--bg-tertiary)', textAlign: 'center' as const },
  inputGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  inputLabel: { fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' },
  inputHint: { fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.3 },
  keyLink: { fontSize: 10, color: '#60a5fa', textDecoration: 'none', display: 'flex', alignItems: 'center', fontWeight: 500 },
  input: { width: '100%', padding: '7px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none' },
  formError: { fontSize: 11, color: '#fca5a5', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: 6, padding: '7px 9px', lineHeight: 1.35 },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  addBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, padding: '10px', width: '100%' },
  liveSection: { marginTop: 'auto', paddingTop: 8 },
  liveBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14, fontWeight: 600, padding: '12px 16px' },
  liveDotAnim: { width: 10, height: 10, borderRadius: '50%', background: 'white', animation: 'livePulse 1.5s infinite' },
};
