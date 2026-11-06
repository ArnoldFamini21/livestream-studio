import { useCallback, useEffect, useRef, useState } from 'react';
import { useMicPlaybackTest } from '../hooks/useMicPlaybackTest.ts';
import { describeMicTestPhase } from '../utils/micPlaybackTest.ts';
import { runConnectionCheck, type ConnectionCheckResult } from '../utils/connectionCheck.ts';

interface PreJoinChecksProps {
  stream: MediaStream | null;
  applyAudioOutput: (element: HTMLMediaElement) => Promise<void>;
  onPlaySpeakerTest: () => void;
  speakerTestPlaying: boolean;
}

const LEVEL_LABEL: Record<ConnectionCheckResult['level'], string> = {
  good: 'Good',
  warning: 'OK',
  bad: 'Problem',
};

/** Mic playback, speaker tone and a quick network check before a guest joins. */
export function PreJoinChecks({ stream, applyAudioOutput, onPlaySpeakerTest, speakerTestPlaying }: PreJoinChecksProps) {
  const micTest = useMicPlaybackTest(stream, applyAudioOutput);
  const [connection, setConnection] = useState<ConnectionCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const checkConnection = useCallback(async () => {
    setChecking(true);
    try {
      const result = await runConnectionCheck();
      if (mountedRef.current) setConnection(result);
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkConnection();
  }, [checkConnection]);

  const micBusy = micTest.phase === 'recording' || micTest.phase === 'playing';

  return (
    <section className="prejoin-checks" aria-label="Check your setup">
      <div className="prejoin-check-row">
        <div className="prejoin-check-text">
          <strong>Microphone</strong>
          <span aria-live="polite">
            {micTest.supported ? describeMicTestPhase(micTest.phase, micTest.secondsLeft) : 'Turn on your microphone to test it.'}
          </span>
        </div>
        <button
          type="button"
          className="prejoin-check-btn"
          onClick={micBusy ? micTest.stop : micTest.start}
          disabled={!micTest.supported}
        >
          {micTest.phase === 'recording' ? 'Stop' : micTest.phase === 'playing' ? 'Stop' : micTest.phase === 'done' ? 'Record again' : 'Record & play back'}
        </button>
      </div>
      <div className="prejoin-check-row">
        <div className="prejoin-check-text">
          <strong>Speakers</strong>
          <span>Play a short tone to check you can hear the studio.</span>
        </div>
        <button type="button" className="prejoin-check-btn" onClick={onPlaySpeakerTest} disabled={speakerTestPlaying}>
          {speakerTestPlaying ? 'Playing…' : 'Play test sound'}
        </button>
      </div>
      <div className="prejoin-check-row prejoin-check-row--stack">
        <div className="prejoin-check-text">
          <strong>
            Connection
            {connection && !checking && (
              <span className={`prejoin-level prejoin-level--${connection.level}`}>{LEVEL_LABEL[connection.level]}</span>
            )}
          </strong>
          <span aria-live="polite">{checking ? 'Checking your connection…' : connection?.summary || 'Not checked yet.'}</span>
        </div>
        <button type="button" className="prejoin-check-btn" onClick={() => void checkConnection()} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
        {connection && !checking && (
          <ul className="prejoin-check-items">
            {connection.items.map((item) => (
              <li key={item.id} className={`prejoin-check-item prejoin-check-item--${item.level}`}>
                <span className="prejoin-check-dot" aria-hidden="true" />
                <span><strong>{item.label}:</strong> {item.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
