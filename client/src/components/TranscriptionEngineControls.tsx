import type { CSSProperties } from 'react';
import type { TranscriptionProgress } from '../utils/localTranscription.ts';
import {
  BROWSER_WHISPER_MODELS,
  getBrowserWhisperModel,
  type BrowserWhisperModelId,
  type TranscriptionEngine,
  type TranscriptionSettings,
} from '../utils/transcriptionSettings.ts';

interface TranscriptionEngineControlsProps {
  settings: TranscriptionSettings;
  onChange: (settings: TranscriptionSettings) => void;
  progress: TranscriptionProgress | null;
  busy: boolean;
  onCancel: () => void;
}

/** Engine and model choice for transcripts, plus the running job's progress and cancel. */
export function TranscriptionEngineControls({ settings, onChange, progress, busy, onCancel }: TranscriptionEngineControlsProps) {
  const model = getBrowserWhisperModel(settings.model);
  const percent = progress ? Math.round(Math.min(1, Math.max(0, progress.fraction)) * 100) : 0;
  return (
    <div style={styles.card}>
      <div style={styles.row}>
        <label style={styles.label} htmlFor="transcription-engine">Transcript engine</label>
        <select
          id="transcription-engine"
          style={styles.select}
          value={settings.engine}
          disabled={busy}
          onChange={(event) => onChange({ ...settings, engine: event.target.value as TranscriptionEngine })}
        >
          <option value="browser">In this browser (free, private)</option>
          <option value="cloud">Studio server (needs an OpenAI key)</option>
        </select>
      </div>
      {settings.engine === 'browser' ? (
        <>
          <div style={styles.row}>
            <label style={styles.label} htmlFor="transcription-model">Speed vs accuracy</label>
            <select
              id="transcription-model"
              style={styles.select}
              value={settings.model}
              disabled={busy}
              onChange={(event) => onChange({ ...settings, model: event.target.value as BrowserWhisperModelId })}
            >
              {BROWSER_WHISPER_MODELS.map((option) => (
                <option key={option.id} value={option.id}>{option.label} · ~{option.approxDownloadMb} MB</option>
              ))}
            </select>
          </div>
          <span style={styles.note}>
            {model.description} The model downloads once and is cached by this browser; audio never leaves this computer.
            Uses the GPU (WebGPU) when available.
          </span>
        </>
      ) : (
        <span style={styles.note}>
          Sends the track to the studio server, which needs OPENAI_API_KEY. Long tracks are sent in 10 minute parts.
        </span>
      )}
      {progress && (
        <div style={styles.progressBox} role="status" aria-live="polite">
          <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${percent}%` }} />
          </div>
          <div style={styles.progressRow}>
            <span style={styles.progressText}>{progress.detail}</span>
            <button type="button" style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: 6,
    padding: '8px 9px',
    borderRadius: 8,
    border: '1px solid rgba(168, 85, 247, 0.26)',
    background: 'rgba(168, 85, 247, 0.08)',
  },
  row: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 },
  label: { fontSize: 10, fontWeight: 800, color: '#e9d5ff', textTransform: 'uppercase' },
  select: {
    width: '100%',
    minHeight: 32,
    borderRadius: 7,
    border: '1px solid rgba(216, 180, 254, 0.34)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    padding: '0 9px',
    fontSize: 12,
    outline: 'none',
  },
  note: { fontSize: 10, color: '#e9d5ff', lineHeight: 1.35 },
  progressBox: { display: 'grid', gap: 5 },
  progressTrack: { height: 6, borderRadius: 999, background: 'rgba(255, 255, 255, 0.12)', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 999, background: '#a855f7', transition: 'width 0.3s ease' },
  progressRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  progressText: { fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.35, minWidth: 0 },
  cancelBtn: {
    flexShrink: 0,
    padding: '3px 10px',
    borderRadius: 999,
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
