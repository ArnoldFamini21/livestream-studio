import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveCaptionSegment } from '../hooks/useLiveCaptions.ts';
import {
  CAPTION_TRANSLATION_LANGUAGES,
  requestCaptionTranslation,
} from '../utils/captionTranslation.ts';

interface LiveCaptionsPanelProps {
  enabled: boolean;
  listening: boolean;
  supported: boolean;
  language: string;
  error: string | null;
  segments: LiveCaptionSegment[];
  roomName?: string;
  onToggle: () => void;
  onLanguageChange: (language: string) => void;
  onClear: () => void;
  onClose: () => void;
}

interface LiveCaptionOverlayProps {
  caption: LiveCaptionSegment | null;
  brandColor: string;
  bottomOffset?: number;
}

const CAPTION_LANGUAGES = [
  { value: 'en-US', label: 'English US' },
  { value: 'en-GB', label: 'English UK' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'ko-KR', label: 'Korean' },
  { value: 'fil-PH', label: 'Filipino' },
];

function formatCaptionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sanitizeFileName(value: string, fallback: string): string {
  const cleaned = value
    .split(/[\\/]/)
    .pop()
    ?.replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function getLanguageLabel(language: string): string {
  return CAPTION_LANGUAGES.find((option) => option.value === language)?.label || language;
}

function getSortedFinalSegments(segments: LiveCaptionSegment[]): LiveCaptionSegment[] {
  return segments
    .filter((segment) => !segment.interim && segment.text.trim())
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function makeTranscriptFileName(roomName: string | undefined, extension: 'txt' | 'vtt'): string {
  const prefix = sanitizeFileName(roomName || 'studio', 'studio');
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${prefix}_live_captions_${timestamp}.${extension}`;
}

function buildPlainTranscript(segments: LiveCaptionSegment[], language: string, roomName?: string): string {
  const lines = [
    'LiveStream Studio Captions',
    `Room: ${roomName || 'Studio'}`,
    `Language: ${getLanguageLabel(language)}`,
    `Exported: ${new Date().toISOString()}`,
    '',
  ];

  for (const segment of segments) {
    const timestamp = new Date(segment.timestamp);
    const time = Number.isNaN(timestamp.getTime()) ? '' : timestamp.toLocaleString();
    lines.push(`[${time}] ${segment.speakerName}`);
    lines.push(segment.text.trim());
    lines.push('');
  }

  return lines.join('\n');
}

function formatVttTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function sanitizeVttText(value: string): string {
  return value.replace(/-->/g, '->').replace(/[<>]/g, '');
}

function buildWebVttTranscript(segments: LiveCaptionSegment[], language: string, roomName?: string): string {
  const firstTime = Date.parse(segments[0]?.timestamp || '');
  const origin = Number.isFinite(firstTime) ? firstTime : Date.now();
  const lines = [
    'WEBVTT',
    `NOTE Room: ${roomName || 'Studio'}`,
    `NOTE Language: ${getLanguageLabel(language)}`,
    '',
  ];

  segments.forEach((segment, index) => {
    const startTime = Date.parse(segment.timestamp);
    const nextTime = Date.parse(segments[index + 1]?.timestamp || '');
    const start = Number.isFinite(startTime) ? startTime - origin : index * 3500;
    const end = Number.isFinite(nextTime)
      ? Math.max(start + 1200, nextTime - origin)
      : start + Math.max(2500, Math.min(6000, segment.text.length * 65));
    lines.push(String(index + 1));
    lines.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`);
    lines.push(`<v ${sanitizeVttText(segment.speakerName)}>${sanitizeVttText(segment.text.trim())}`);
    lines.push('');
  });

  return lines.join('\n');
}

function downloadTextFile(content: string, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

export function LiveCaptionsPanel({
  enabled,
  listening,
  supported,
  language,
  error,
  segments,
  roomName,
  onToggle,
  onLanguageChange,
  onClear,
  onClose,
}: LiveCaptionsPanelProps) {
  const statusLabel = !supported ? 'Unsupported' : listening ? 'Listening' : enabled ? 'Starting' : 'Off';
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const finalSegments = useMemo(() => getSortedFinalSegments(segments), [segments]);
  const exportDisabled = finalSegments.length === 0;
  const [translateLanguage, setTranslateLanguage] = useState(CAPTION_TRANSLATION_LANGUAGES[1]?.value || 'es');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const transcriptText = useMemo(
    () => buildPlainTranscript(finalSegments, language, roomName),
    [finalSegments, language, roomName]
  );

  const handleCopyTranscript = async () => {
    if (exportDisabled) return;
    await copyText(transcriptText);
    setCopied(true);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
  };

  const handleDownloadText = () => {
    if (exportDisabled) return;
    downloadTextFile(transcriptText, makeTranscriptFileName(roomName, 'txt'), 'text/plain;charset=utf-8');
  };

  const handleDownloadVtt = () => {
    if (exportDisabled) return;
    downloadTextFile(
      buildWebVttTranscript(finalSegments, language, roomName),
      makeTranscriptFileName(roomName, 'vtt'),
      'text/vtt;charset=utf-8'
    );
  };

  const handleTranslateVtt = async () => {
    if (exportDisabled || isTranslating) return;
    setIsTranslating(true);
    setTranslateError(null);
    try {
      const result = await requestCaptionTranslation({
        segments: finalSegments,
        targetLanguage: translateLanguage,
      });
      const languageLabel = CAPTION_TRANSLATION_LANGUAGES.find((option) => option.value === result.targetLanguage)?.label
        || result.targetLanguage;
      const fileName = makeTranscriptFileName(roomName, 'vtt').replace(/\.vtt$/, `_${result.targetLanguage}.vtt`);
      downloadTextFile(
        buildWebVttTranscript(result.segments, `${languageLabel} (translated)`, roomName),
        fileName,
        'text/vtt;charset=utf-8'
      );
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : 'Caption translation failed.');
    } finally {
      setIsTranslating(false);
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>Live Captions</h3>
          <div style={styles.statusRow}>
            <span style={{
              ...styles.statusDot,
              background: listening ? 'var(--success)' : enabled ? 'var(--warning)' : 'var(--text-muted)',
            }} />
            <span style={styles.statusText}>{statusLabel}</span>
          </div>
        </div>
        <button type="button" className="panel-close-btn" style={styles.closeBtn} onClick={onClose} aria-label="Close captions panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={styles.controls}>
        <label style={styles.field}>
          <span style={styles.label}>Language</span>
          <select
            value={language}
            onChange={(event) => onLanguageChange(event.target.value)}
            style={styles.select}
            disabled={enabled}
          >
            {CAPTION_LANGUAGES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <button
          type="button"
          style={{
            ...styles.primaryBtn,
            ...(enabled ? styles.stopBtn : {}),
            opacity: supported ? 1 : 0.55,
          }}
          onClick={onToggle}
          disabled={!supported}
          aria-pressed={enabled}
        >
          {enabled ? 'Stop Captions' : 'Start Captions'}
        </button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.transcriptHeader}>
        <span>Transcript</span>
        <div style={styles.transcriptActions}>
          <button type="button" style={styles.actionBtn} onClick={handleCopyTranscript} disabled={exportDisabled}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" style={styles.actionBtn} onClick={handleDownloadText} disabled={exportDisabled}>TXT</button>
          <button type="button" style={styles.actionBtn} onClick={handleDownloadVtt} disabled={exportDisabled}>VTT</button>
          <button type="button" style={styles.clearBtn} onClick={onClear} disabled={segments.length === 0}>Clear</button>
        </div>
      </div>

      <div style={styles.translateRow}>
        <span style={styles.translateLabel}>Translate</span>
        <select
          style={styles.translateSelect}
          value={translateLanguage}
          onChange={(event) => setTranslateLanguage(event.target.value)}
          disabled={isTranslating}
          aria-label="Caption translation language"
        >
          {CAPTION_TRANSLATION_LANGUAGES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <button
          type="button"
          style={styles.translateBtn}
          onClick={handleTranslateVtt}
          disabled={exportDisabled || isTranslating}
          title="Translate the captions and download a subtitle VTT in the chosen language"
        >
          {isTranslating ? 'Translating...' : 'Translate VTT'}
        </button>
      </div>
      {translateError && <div style={styles.translateError}>{translateError}</div>}

      <div style={styles.transcriptList}>
        {segments.length === 0 ? (
          <div style={styles.emptyState}>No captions yet</div>
        ) : (
          [...segments].reverse().map((segment) => (
            <div key={segment.id} style={styles.transcriptItem}>
              <div style={styles.transcriptMeta}>
                <span>{segment.speakerName}</span>
                <span>{formatCaptionTime(segment.timestamp)}</span>
              </div>
              <p style={styles.transcriptText}>{segment.text}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function LiveCaptionOverlay({ caption, brandColor, bottomOffset = 24 }: LiveCaptionOverlayProps) {
  if (!caption?.text) return null;

  return (
    <div style={{ ...styles.overlay, bottom: bottomOffset }}>
      <div style={{ ...styles.overlayInner, borderTopColor: brandColor }}>
        <span style={{ ...styles.ccBadge, background: brandColor }}>CC</span>
        <div style={styles.overlayCopy}>
          <span style={styles.overlaySpeaker}>{caption.speakerName}</span>
          <span style={{ ...styles.overlayText, opacity: caption.interim ? 0.78 : 1 }}>{caption.text}</span>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    right: 16,
    bottom: 74,
    width: 360,
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'min(620px, calc(100vh - 120px))',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    boxShadow: 'var(--shadow-lg)',
    zIndex: 60,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 16px',
    borderBottom: '1px solid var(--border)',
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 800,
    lineHeight: 1.25,
    color: 'var(--text-primary)',
  },
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
  },
  statusText: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-secondary)',
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  controls: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 10,
    padding: 16,
    borderBottom: '1px solid var(--border)',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
  },
  label: {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-secondary)',
  },
  select: {
    height: 36,
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    padding: '0 10px',
    outline: 'none',
  },
  primaryBtn: {
    alignSelf: 'end',
    height: 36,
    padding: '0 14px',
    borderRadius: 8,
    border: '1px solid var(--accent)',
    background: 'var(--accent-solid)',
    color: 'white',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  stopBtn: {
    borderColor: 'rgba(239, 68, 68, 0.72)',
    background: 'rgba(239, 68, 68, 0.16)',
    color: '#fecaca',
  },
  error: {
    margin: '12px 16px 0',
    padding: '9px 10px',
    borderRadius: 8,
    border: '1px solid rgba(239, 68, 68, 0.3)',
    background: 'rgba(239, 68, 68, 0.12)',
    color: '#fecaca',
    fontSize: 12,
    lineHeight: 1.35,
  },
  transcriptHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '14px 16px 8px',
    fontSize: 12,
    fontWeight: 800,
    color: 'var(--text-secondary)',
  },
  transcriptActions: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    flexWrap: 'wrap',
  },
  actionBtn: {
    minWidth: 34,
    height: 24,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 10,
    fontWeight: 800,
    cursor: 'pointer',
    padding: '0 7px',
  },
  clearBtn: {
    height: 24,
    borderRadius: 6,
    border: '1px solid rgba(239, 68, 68, 0.24)',
    background: 'rgba(239, 68, 68, 0.08)',
    color: '#fecaca',
    fontSize: 12,
    fontWeight: 800,
    cursor: 'pointer',
    padding: '0 7px',
  },
  translateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 0 2px',
  },
  translateLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
  },
  translateSelect: {
    flex: 1,
    height: 26,
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    fontSize: 11,
    padding: '0 6px',
  },
  translateBtn: {
    height: 26,
    borderRadius: 6,
    border: '1px solid var(--accent)',
    background: 'var(--accent-subtle)',
    color: 'var(--accent)',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    padding: '0 10px',
  },
  translateError: {
    fontSize: 11,
    color: '#fca5a5',
    padding: '2px 0',
  },
  transcriptList: {
    flex: 1,
    minHeight: 180,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '0 16px 16px',
  },
  emptyState: {
    minHeight: 120,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontSize: 13,
  },
  transcriptItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '9px 10px',
    borderRadius: 8,
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
  },
  transcriptMeta: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    fontSize: 10,
    fontWeight: 800,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
  },
  transcriptText: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.4,
    color: 'var(--text-primary)',
    wordBreak: 'break-word',
  },
  overlay: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'min(76%, 780px)',
    zIndex: 28,
    pointerEvents: 'none',
  },
  overlayInner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '9px 12px 10px',
    borderRadius: 9,
    borderTop: '3px solid',
    background: 'rgba(2, 6, 23, 0.78)',
    color: 'white',
    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.28)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  },
  ccBadge: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 30,
    height: 22,
    borderRadius: 5,
    padding: '0 6px',
    color: 'white',
    fontSize: 11,
    fontWeight: 900,
  },
  overlayCopy: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  overlaySpeaker: {
    color: 'rgba(255, 255, 255, 0.74)',
    fontSize: 11,
    fontWeight: 800,
    lineHeight: 1.1,
  },
  overlayText: {
    color: 'white',
    fontSize: 16,
    lineHeight: 1.25,
    fontWeight: 700,
    wordBreak: 'break-word',
  },
};
