import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiRequestError, postJson, requestJson } from '../utils/apiClient.ts';
import {
  getWatchVoterId,
  pollOptionPercent,
  readWatchPollChoice,
  saveWatchPollChoice,
  type WatchPoll,
} from '../utils/watchPollVoting.ts';

const POLL_REFRESH_MS = 5_000;

/** The host's live poll on the watch page: viewers vote here, then see the results. */
export function WatchPollCard({ watchId }: { watchId: string }) {
  const [poll, setPoll] = useState<WatchPoll | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const voterId = useMemo(() => getWatchVoterId(), []);
  const path = `/api/watch/${encodeURIComponent(watchId)}`;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (typeof document === 'undefined' || !document.hidden) {
        try {
          const result = await requestJson<{ poll: WatchPoll | null }>(`${path}/poll`, { timeoutMs: 8_000 });
          if (!stopped) setPoll(result.poll);
        } catch { /* keep the last poll; try again next tick */ }
      }
      if (!stopped) timer = setTimeout(() => void load(), POLL_REFRESH_MS);
    };
    void load();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [path]);

  useEffect(() => {
    setChoice(poll ? readWatchPollChoice(poll.id) : null);
    setError('');
  }, [poll?.id]);

  const vote = useCallback(async (optionId: string) => {
    if (!poll || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await postJson<{ poll: WatchPoll }>(`${path}/poll-votes`, { pollId: poll.id, optionId, voterId });
      saveWatchPollChoice(poll.id, optionId);
      setChoice(optionId);
      setPoll(result.poll);
    } catch (err) {
      setError(err instanceof ApiRequestError && err.status === 409
        ? 'This poll just closed.'
        : err instanceof ApiRequestError && err.status === 429
          ? 'Too many votes from this network right now. Try again in a minute.'
          : 'Your vote did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  }, [busy, path, poll, voterId]);

  if (!poll) return null;
  const showResults = Boolean(choice);

  return (
    <section className="watch-poll" aria-label="Live poll">
      <div className="watch-poll-head">
        <span className="watch-kicker">Live poll</span>
        <span className="watch-poll-count">{poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}</span>
      </div>
      <h2 className="watch-poll-question">{poll.question}</h2>
      <div className="watch-poll-options">
        {poll.options.map((option, index) => {
          const percent = pollOptionPercent(poll, option.id);
          const chosen = choice === option.id;
          return (
            <button
              key={option.id}
              type="button"
              className={`watch-poll-option${chosen ? ' is-chosen' : ''}`}
              onClick={() => void vote(option.id)}
              disabled={busy}
              aria-pressed={chosen}
            >
              {showResults && <span className="watch-poll-bar" style={{ width: `${percent}%` }} aria-hidden="true" />}
              <span className="watch-poll-index">{index + 1}</span>
              <span className="watch-poll-text">{option.text}</span>
              {showResults && <span className="watch-poll-percent">{percent}%</span>}
            </button>
          );
        })}
      </div>
      <p className="watch-poll-note" role="status">
        {error || (showResults ? 'Thanks for voting. Tap another answer to change your vote.' : 'Tap an answer to vote.')}
      </p>
    </section>
  );
}
