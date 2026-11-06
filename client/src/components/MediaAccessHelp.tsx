import '../styles/media-access-help.css';
import { useMemo, useState } from 'react';
import {
  detectBrowserFamily,
  getMediaAccessHelpSteps,
  type MediaAccessProblem,
} from '../utils/mediaAccessErrors.ts';

interface MediaAccessHelpProps {
  problem: MediaAccessProblem;
  /** Ask for the devices again. Resolves true when everything that was missing started. */
  onRetry: () => Promise<boolean> | void;
  /** Smaller layout for the studio, with the steps folded away. */
  compact?: boolean;
  onDismiss?: () => void;
}

/** What went wrong with the camera or mic, how to fix it in this browser, and a Try again button. */
export function MediaAccessHelp({ problem, onRetry, compact = false, onDismiss }: MediaAccessHelpProps) {
  const [retrying, setRetrying] = useState(false);
  const steps = useMemo(() => getMediaAccessHelpSteps(problem.kind, detectBrowserFamily()), [problem.kind]);
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  const stepList = steps.length > 0 && (
    <ol className="media-help-steps">
      {steps.map((step) => <li key={step}>{step}</li>)}
    </ol>
  );
  return (
    <div className={`media-help${compact ? ' media-help--compact' : ''}`} role="alert">
      <div className="media-help-head">
        <span className="media-help-icon" aria-hidden="true">!</span>
        <p className="media-help-message">{problem.message}</p>
      </div>
      {stepList && (compact
        ? <details className="media-help-details"><summary>How to fix this</summary>{stepList}</details>
        : stepList)}
      <div className="media-help-actions">
        <button type="button" className="media-help-retry" onClick={() => void retry()} disabled={retrying}>
          {retrying ? 'Trying…' : 'Try again'}
        </button>
        {onDismiss && (
          <button type="button" className="media-help-dismiss" onClick={onDismiss}>Dismiss</button>
        )}
      </div>
    </div>
  );
}
