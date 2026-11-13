import type { TestStreamControls } from '../hooks/useTestStream.ts';
import { TEST_BANNER_LABEL, describeTestPhase } from '../utils/testStreamMachine.ts';
import type { TestCheckStatus } from '../utils/testStreamVerdict.ts';

interface TestStreamPanelProps {
  controls: TestStreamControls;
  /** Opens the private output player. */
  onWatchOutput: () => void;
  /** Number of enabled destinations, so "Go live now" says where the broadcast will go. */
  enabledDestinationCount: number;
}

const STATUS_COLOR: Record<TestCheckStatus, string> = {
  ok: 'var(--success)',
  warn: 'var(--warning-text, #fbbf24)',
  fail: '#f87171',
  pending: 'var(--text-muted)',
};
const STATUS_MARK: Record<TestCheckStatus, string> = { ok: 'OK', warn: 'Note', fail: 'Problem', pending: '...' };

/**
 * The private test: check picture and sound before the service, with nothing
 * sent to any platform. Lives beside Go Live in the stream panel.
 */
export function TestStreamPanel({ controls, onWatchOutput, enabledDestinationCount }: TestStreamPanelProps) {
  const { state, health, notice, startBlocker } = controls;
  const phase = describeTestPhase(state);
  const busy = state.phase === 'starting' || state.phase === 'ending' || state.phase === 'switching';

  if (state.phase === 'idle' || state.phase === 'error' || state.phase === 'live') {
    return (
      <section style={styles.card} aria-label="Test stream" data-testid="test-stream-panel">
        <div style={styles.top}>
          <span style={styles.title}>Test first</span>
          <span style={styles.private}>Private</span>
        </div>
        <p style={styles.text}>
          Run a private test to check your picture and sound. Nothing goes to YouTube, Facebook or any other platform, and the public watch page stays offline.
        </p>
        <button
          type="button"
          className="btn-secondary"
          style={styles.button}
          onClick={() => { void controls.startTest(); }}
          disabled={Boolean(startBlocker)}
          data-testid="test-stream-start"
        >
          Test stream (private)
        </button>
        {startBlocker && state.phase !== 'live' && <p style={styles.note} data-testid="test-stream-unavailable">{startBlocker}</p>}
        {state.phase === 'live' && <p style={styles.note}>A live broadcast is running, so a test cannot run.</p>}
        {notice && state.phase !== 'live' && notice !== startBlocker && (
          <p style={styles.error} role="alert" data-testid="test-stream-notice">{notice}</p>
        )}
        {(state.phase === 'error' || (state.phase === 'idle' && state.message)) && (
          <button type="button" className="btn-secondary" style={styles.smallButton} onClick={controls.dismiss}>Dismiss</button>
        )}
      </section>
    );
  }

  const verdictBox = health ? (
    <div
      style={{ ...styles.verdict, ...(health.kind === 'ready' ? styles.verdictReady : health.kind === 'problem' ? styles.verdictProblem : styles.verdictChecking) }}
      role="status"
      aria-live="polite"
    >
      <strong data-testid="test-stream-verdict">{health.headline}</strong>
      <span style={styles.verdictDetail}>{health.detail}</span>
    </div>
  ) : (
    <p style={styles.text}>{state.phase === 'starting' ? 'Connecting to the media server (waking it can take up to a minute)...' : phase.label}</p>
  );

  return (
    <section style={{ ...styles.card, ...styles.cardActive }} aria-label="Test stream running" data-testid="test-stream-panel" data-phase={state.phase}>
      <div style={styles.top}>
        <span style={styles.testBadge} data-testid="test-stream-badge">{state.phase === 'testing' ? TEST_BANNER_LABEL : phase.label}</span>
        <span style={styles.private}>Nothing is sent anywhere</span>
      </div>

      <div data-testid="test-stream-health" data-verdict={health?.kind ?? 'starting'}>
        {verdictBox}
      </div>

      {notice && <p style={styles.error} role="alert" data-testid="test-stream-notice">{notice}</p>}

      <div style={styles.actions}>
        <button type="button" className="btn-secondary" style={styles.button} onClick={onWatchOutput} disabled={state.phase !== 'testing' || !state.watchId} data-testid="test-stream-watch">
          Watch and listen to the test output
        </button>
        <button type="button" className="btn-secondary" style={styles.button} onClick={controls.endTest} disabled={state.phase === 'ending' || state.phase === 'switching'} data-testid="test-stream-end">
          End test
        </button>
        <button
          type="button"
          className="btn-primary"
          style={{ ...styles.button, background: '#ef4444', color: 'white' }}
          onClick={() => { void controls.goLiveNow(); }}
          disabled={state.phase !== 'testing' || busy || enabledDestinationCount === 0}
          data-testid="test-stream-go-live"
        >
          Go live now to {enabledDestinationCount} destination{enabledDestinationCount === 1 ? '' : 's'}
        </button>
        {enabledDestinationCount === 0 && state.phase === 'testing' && (
          <p style={styles.note}>Turn on at least one destination above before going live.</p>
        )}
      </div>

      {health && (
        <ul style={styles.checks} aria-label="Health checks">
          {health.checks.map((check) => (
            <li key={check.id} style={styles.check} data-check={check.id} data-status={check.status}>
              <span style={{ ...styles.mark, color: STATUS_COLOR[check.status] }}>{STATUS_MARK[check.status]}</span>
              <span>
                <span style={styles.checkLabel}>{check.label}</span>
                <span style={styles.checkDetail}>{check.detail}</span>
                {check.status !== 'ok' && check.status !== 'pending' && check.action && <span style={styles.checkAction}>{check.action}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { borderRadius: 8, padding: '10px 12px', border: '1px solid var(--border)', background: 'rgba(255,255,255,0.035)', display: 'flex', flexDirection: 'column', gap: 8 },
  cardActive: { borderColor: 'rgba(245,158,11,0.5)', background: 'rgba(245,158,11,0.07)' },
  top: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  title: { fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' },
  private: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' },
  testBadge: { background: '#b45309', color: 'white', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, letterSpacing: 0 },
  text: { margin: 0, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 },
  note: { margin: 0, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 },
  error: { margin: 0, fontSize: 12, color: '#fca5a5', lineHeight: 1.4 },
  button: { width: '100%', justifyContent: 'center', padding: '9px 12px', fontSize: 13, fontWeight: 600 },
  smallButton: { alignSelf: 'flex-start', fontSize: 11, padding: '4px 10px' },
  verdict: { display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 10px', borderRadius: 8, border: '1px solid', fontSize: 13 },
  verdictReady: { background: 'rgba(34,197,94,0.1)', borderColor: 'rgba(34,197,94,0.35)', color: 'var(--text-primary)' },
  verdictProblem: { background: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.4)', color: 'var(--text-primary)' },
  verdictChecking: { background: 'rgba(255,255,255,0.05)', borderColor: 'var(--border)', color: 'var(--text-primary)' },
  verdictDetail: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 },
  checks: { listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  check: { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 },
  mark: { flex: '0 0 52px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', paddingTop: 2 },
  checkLabel: { display: 'block', fontWeight: 600, color: 'var(--text-primary)' },
  checkDetail: { display: 'block', color: 'var(--text-secondary)', lineHeight: 1.35 },
  checkAction: { display: 'block', color: 'var(--warning-text, #fbbf24)', lineHeight: 1.35 },
  actions: { display: 'flex', flexDirection: 'column', gap: 6 },
};
