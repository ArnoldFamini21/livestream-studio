import type { SessionHealthSummary } from '../hooks/useSessionHealth.ts';
import { summarizeHealthChecks, type HealthAudience } from '../utils/sessionHealthSummary.ts';

interface SessionHealthPillProps {
  summary: SessionHealthSummary;
  audience: HealthAudience;
  onClick: () => void;
}

/** "Health: Good" / "Check mic": a labelled status instead of an unexplained number. */
export function SessionHealthPill({ summary, audience, onClick }: SessionHealthPillProps) {
  const view = summarizeHealthChecks(summary.checks, audience);
  const prefix = audience === 'guest' ? 'Setup' : 'Health';
  return (
    <button
      type="button"
      className={`studio-health-pill studio-health-pill--${view.status}`}
      onClick={onClick}
      title={audience === 'guest' ? 'Check your connection, microphone and camera' : 'Open session health'}
      aria-label={`${prefix}: ${view.label}. Open details`}
    >
      <span className="studio-health-pill-dot" aria-hidden="true" />
      <span className="studio-health-pill-prefix">{prefix}:</span>
      <span>{view.label}</span>
    </button>
  );
}
