/** Watch-page poll voting: an anonymous id per browser and the choice made per poll. */

export interface WatchPollOption { id: string; text: string; votes: number }
export interface WatchPoll {
  id: string;
  question: string;
  options: WatchPollOption[];
  status: 'open' | 'closed';
  totalVotes: number;
}

const VOTER_ID_KEY = 'livestream-studio:watch-voter-id';
const choiceKey = (pollId: string) => `livestream-studio:watch-poll-choice:${pollId}`;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function randomVoterId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A random id kept in this browser so a viewer votes once (voting again changes the vote). */
export function getWatchVoterId(storage: StorageLike | null = defaultStorage()): string {
  try {
    const existing = storage?.getItem(VOTER_ID_KEY);
    if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  } catch { /* storage blocked: a fresh id for this page view */ }
  const id = randomVoterId();
  try { storage?.setItem(VOTER_ID_KEY, id); } catch { /* not persisted */ }
  return id;
}

export function readWatchPollChoice(pollId: string, storage: StorageLike | null = defaultStorage()): string | null {
  try { return storage?.getItem(choiceKey(pollId)) ?? null; } catch { return null; }
}

export function saveWatchPollChoice(pollId: string, optionId: string, storage: StorageLike | null = defaultStorage()): void {
  try { storage?.setItem(choiceKey(pollId), optionId); } catch { /* not persisted */ }
}

export function pollOptionPercent(poll: WatchPoll, optionId: string): number {
  const option = poll.options.find((item) => item.id === optionId);
  if (!option || poll.totalVotes <= 0) return 0;
  return Math.round((option.votes / poll.totalVotes) * 100);
}
