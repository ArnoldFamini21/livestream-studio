import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../utils/clientErrorReporter.ts';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
    reportClientError('react', error);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.container}>
          <div style={styles.card}>
            <div style={styles.iconWrapper}>
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ef4444"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h1 style={styles.title}>Something went wrong</h1>
            <p style={styles.message}>
              An unexpected error occurred. Please try again or refresh the page.
            </p>
            {this.state.error && (
              <pre style={styles.errorDetail}>
                {this.state.error.message}
              </pre>
            )}
            <button
              style={styles.button}
              onClick={this.handleReset}
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export type PanelErrorPlacement = 'floating' | 'inline' | 'overlay';

interface PanelErrorBoundaryProps {
  /** What crashed, for the report and the screen reader ("Chat", "Recording"). */
  label: string;
  /** Changing it clears the error, e.g. the active sidebar tab. */
  resetKey?: string | number | boolean | null;
  /** Floating card (default, for modal and side panels), in the layout, or a small stage badge. */
  placement?: PanelErrorPlacement;
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  error: Error | null;
  /** Bumped by "Reload panel" so the panel mounts afresh. */
  generation: number;
}

/**
 * Keeps a crash inside one studio panel, dialog or overlay layer from
 * reaching the root boundary. The root boundary unmounts StudioRoom, which
 * ends the live relay, stops the recorders and drops every guest; this one
 * replaces only the broken panel with a "Reload panel" card. The media hooks
 * and the stage live outside these boundaries.
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<PanelErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[PanelErrorBoundary] ${this.props.label} crashed:`, error, errorInfo);
    const labelled = new Error(`[${this.props.label} panel] ${error?.message || String(error)}`);
    if (error?.stack) labelled.stack = error.stack;
    reportClientError('react', labelled);
  }

  componentDidUpdate(previous: PanelErrorBoundaryProps) {
    if (this.state.error && !Object.is(previous.resetKey, this.props.resetKey)) {
      this.setState((state) => ({ error: null, generation: state.generation + 1 }));
    }
  }

  handleReload = () => {
    this.setState((state) => ({ error: null, generation: state.generation + 1 }));
  };

  render() {
    if (!this.state.error) {
      // A new key after "Reload panel" remounts the panel with fresh state.
      return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
    }
    const placement = this.props.placement ?? 'floating';
    return (
      <div
        role="alert"
        aria-label={`${this.props.label} had a problem`}
        data-panel-error={this.props.label}
        style={{ ...styles.panelCard, ...panelPlacementStyles[placement] }}
      >
        <span style={styles.panelMessage}>This panel had a problem</span>
        <button type="button" style={styles.panelButton} onClick={this.handleReload}>
          Reload panel
        </button>
      </div>
    );
  }
}

const panelPlacementStyles: Record<PanelErrorPlacement, React.CSSProperties> = {
  floating: { position: 'fixed', right: 16, bottom: 96, zIndex: 1200, maxWidth: 'calc(100vw - 32px)' },
  inline: { margin: 12 },
  overlay: { position: 'absolute', top: 8, left: 8, zIndex: 30 },
};

const styles: Record<string, React.CSSProperties> = {
  panelCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    background: 'var(--bg-surface, #18181b)',
    border: '1px solid var(--border, rgba(255,255,255,0.12))',
    borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    color: 'var(--text-primary, #fafafa)',
    fontSize: 13,
  },
  panelMessage: {
    fontWeight: 600,
  },
  panelButton: {
    padding: '6px 12px',
    background: 'var(--accent, #a78bfa)',
    color: 'white',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    width: '100%',
    background: '#09090b',
    padding: 20,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    maxWidth: 440,
    padding: '40px 32px',
    background: '#111114',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 14,
  },
  iconWrapper: {
    marginBottom: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: '#fafafa',
    margin: '0 0 8px 0',
  },
  message: {
    fontSize: 14,
    color: '#a1a1aa',
    lineHeight: 1.5,
    margin: '0 0 20px 0',
  },
  errorDetail: {
    width: '100%',
    padding: '10px 14px',
    marginBottom: 20,
    background: '#18181b',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 8,
    fontSize: 12,
    color: '#71717a',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    textAlign: 'left',
    maxHeight: 120,
    overflowY: 'auto',
  },
  button: {
    padding: '10px 28px',
    background: '#a78bfa',
    color: 'white',
    border: 'none',
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
