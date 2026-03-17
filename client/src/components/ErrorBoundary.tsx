import { Component, type ErrorInfo, type ReactNode } from 'react';

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

const styles: Record<string, React.CSSProperties> = {
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
    background: '#7c3aed',
    color: 'white',
    border: 'none',
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
