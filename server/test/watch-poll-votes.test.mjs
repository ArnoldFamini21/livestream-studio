import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  castWatchPollVote,
  createRoom,
  getRooms,
  getWatchPoll,
  parseExternalChatPollVote,
  WatchPollVoteError,
} from '../dist/services/signaling.js';

function roomWithPoll(label, overrides = {}) {
  const { room } = createRoom(`Watch poll ${label}`, 'Arnold', { creatorIp: `watch-poll-${label}-${Date.now()}` });
  const roomState = getRooms().get(room.id);
  const poll = {
    id: `poll-${label}`,
    question: 'Which topic first?',
    options: [{ id: 'a', text: 'Grace', votes: 0 }, { id: 'b', text: 'Law', votes: 0 }],
    status: 'open',
    highlighted: true,
    createdAt: new Date().toISOString(),
    createdBy: 'host',
    createdByName: 'Arnold',
    totalVotes: 0,
    ...overrides,
  };
  roomState.polls.set(poll.id, poll);
  roomState.pollVotes.set(poll.id, new Map());
  return { roomId: room.id, roomState, poll };
}

const voter = (n) => `viewer${String(n).padStart(12, '0')}`;

describe('watch-page poll voting', () => {
  it('shows the open poll without who voted', () => {
    const { roomId } = roomWithPoll('show');
    const poll = getWatchPoll(roomId);
    assert.equal(poll.question, 'Which topic first?');
    assert.deepEqual(Object.keys(poll).sort(), ['id', 'options', 'question', 'status', 'totalVotes']);
    assert.equal(getWatchPoll('no-such-room'), null);
  });

  it('counts one vote per browser and lets a viewer change it', () => {
    const { roomId, roomState, poll } = roomWithPoll('vote');
    let result = castWatchPollVote(roomId, { pollId: poll.id, optionId: 'a', voterId: voter(1), networkKey: 'net1' });
    assert.equal(result.totalVotes, 1);
    result = castWatchPollVote(roomId, { pollId: poll.id, optionId: 'b', voterId: voter(1), networkKey: 'net1' });
    assert.equal(result.totalVotes, 1, 'same browser: vote changed, not added');
    assert.equal(result.options[1].votes, 1);
    result = castWatchPollVote(roomId, { pollId: poll.id, optionId: 'b', voterId: voter(2), networkKey: 'net1' });
    assert.equal(result.totalVotes, 2);
    assert.equal(roomState.polls.get(poll.id).totalVotes, 2, 'the studio sees the same totals');
  });

  it('rejects closed polls, wrong options and malformed voter ids', () => {
    const { roomId, poll } = roomWithPoll('reject');
    const expectCode = (input, code) => assert.throws(
      () => castWatchPollVote(roomId, { pollId: poll.id, optionId: 'a', voterId: voter(9), networkKey: 'n', ...input }),
      (err) => err instanceof WatchPollVoteError && err.code === code
    );
    expectCode({ optionId: 'zzz' }, 'VALIDATION_ERROR');
    expectCode({ voterId: 'short' }, 'VALIDATION_ERROR');
    expectCode({ pollId: 'other-poll' }, 'POLL_NOT_OPEN');
    const closed = roomWithPoll('closed', { status: 'closed' });
    assert.throws(
      () => castWatchPollVote(closed.roomId, { pollId: closed.poll.id, optionId: 'a', voterId: voter(1), networkKey: 'n' }),
      (err) => err.code === 'POLL_NOT_OPEN'
    );
    assert.throws(
      () => castWatchPollVote('no-such-room', { pollId: 'x', optionId: 'a', voterId: voter(1), networkKey: 'n' }),
      (err) => err.statusCode === 404
    );
  });

  it('caps distinct browsers per network per poll, but lets them change their votes', () => {
    const { roomId, poll } = roomWithPoll('cap');
    for (let i = 0; i < 50; i += 1) {
      castWatchPollVote(roomId, { pollId: poll.id, optionId: 'a', voterId: voter(i), networkKey: 'venue' });
    }
    assert.throws(
      () => castWatchPollVote(roomId, { pollId: poll.id, optionId: 'a', voterId: voter(50), networkKey: 'venue' }),
      (err) => err.code === 'POLL_VOTE_LIMIT'
    );
    const changed = castWatchPollVote(roomId, { pollId: poll.id, optionId: 'b', voterId: voter(3), networkKey: 'venue' });
    assert.equal(changed.totalVotes, 50);
    const other = castWatchPollVote(roomId, { pollId: poll.id, optionId: 'b', voterId: voter(50), networkKey: 'home' });
    assert.equal(other.totalVotes, 51);
  });
});

describe('YouTube/Facebook chat poll votes', () => {
  it('reads plain numbers and vote commands, and ignores ordinary chat', () => {
    assert.equal(parseExternalChatPollVote('1'), 0);
    assert.equal(parseExternalChatPollVote(' 2 '), 1);
    assert.equal(parseExternalChatPollVote('#3'), 2);
    assert.equal(parseExternalChatPollVote('2!'), 1);
    assert.equal(parseExternalChatPollVote('vote 4'), 3);
    assert.equal(parseExternalChatPollVote('!vote b'), 1);
    assert.equal(parseExternalChatPollVote('/vote 6'), 5);
    assert.equal(parseExternalChatPollVote('7'), null);
    assert.equal(parseExternalChatPollVote('0'), null);
    assert.equal(parseExternalChatPollVote('12'), null);
    assert.equal(parseExternalChatPollVote('1 Corinthians 13 is my favourite'), null);
    assert.equal(parseExternalChatPollVote('amen'), null);
  });
});
