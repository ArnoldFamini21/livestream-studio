import { useEffect, useState, type CSSProperties } from 'react';
import {
  LOCAL_AI_REQUIREMENT_NOTE,
  getLocalAiStatus,
  loadCloudAiFallback,
  saveCloudAiFallback,
  type LocalAiFeature,
  type LocalAiStatus,
} from '../utils/localAi.ts';

interface LocalAiStatusNoteProps {
  /** Which built-in APIs this panel uses. */
  features: LocalAiFeature[];
  /** What happens without them, e.g. "chapters come from topic shifts". */
  fallbackLabel: string;
  /** Shown after a run, e.g. why the offline fallback was used. */
  notice?: string | null;
}

let statusPromise: Promise<LocalAiStatus> | null = null;

function loadStatusOnce(): Promise<LocalAiStatus> {
  statusPromise ||= getLocalAiStatus();
  return statusPromise;
}

const FEATURE_LABELS: Record<LocalAiFeature, string> = {
  summarizer: 'Summarizer',
  translator: 'Translator',
  languageDetector: 'Language detector',
  languageModel: 'Prompt API',
};

/**
 * Says whether Chrome's free on-device AI will handle this panel, what
 * happens without it, and lets the owner opt into the studio server's OpenAI
 * key as a fallback.
 */
export function LocalAiStatusNote({ features, fallbackLabel, notice }: LocalAiStatusNoteProps) {
  const [status, setStatus] = useState<LocalAiStatus | null>(null);
  const [cloudFallback, setCloudFallback] = useState(() => loadCloudAiFallback());

  useEffect(() => {
    let active = true;
    void loadStatusOnce().then((value) => {
      if (active) setStatus(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const usable = status ? features.filter((feature) => status[feature] !== 'unavailable') : [];
  const needsDownload = status ? usable.some((feature) => status[feature] !== 'available') : false;
  let summary: string;
  if (!status) summary = 'Checking for on-device AI...';
  else if (usable.length === 0) summary = `On-device AI is not available in this browser, so ${fallbackLabel}. ${LOCAL_AI_REQUIREMENT_NOTE}`;
  else if (needsDownload) summary = `Chrome built-in AI (${usable.map((feature) => FEATURE_LABELS[feature]).join(', ')}) will download its model once on first use, then runs free on this computer.`;
  else summary = `Chrome built-in AI (${usable.map((feature) => FEATURE_LABELS[feature]).join(', ')}) runs free on this computer.`;

  return (
    <div style={styles.box}>
      <span style={styles.text}>{summary}</span>
      {notice && <span style={styles.notice}>{notice}</span>}
      <label style={styles.toggle}>
        <input
          type="checkbox"
          checked={cloudFallback}
          onChange={(event) => {
            setCloudFallback(event.target.checked);
            saveCloudAiFallback(event.target.checked);
          }}
        />
        <span>Fall back to the studio server&apos;s OpenAI key (only if one is configured)</span>
      </label>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  box: {
    display: 'grid',
    gap: 5,
    padding: '7px 9px',
    borderRadius: 7,
    border: '1px solid rgba(168, 85, 247, 0.24)',
    background: 'rgba(168, 85, 247, 0.07)',
  },
  text: { fontSize: 10, lineHeight: 1.4, color: 'var(--text-secondary)' },
  notice: { fontSize: 10, lineHeight: 1.4, color: '#fde68a' },
  toggle: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--text-muted)', cursor: 'pointer' },
};
