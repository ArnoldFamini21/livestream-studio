import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatMessage, WatchChatMessage, WatchLiveResponse } from '@studio/shared';
import { VIEWER_FEED_VISIBLE, VIEWER_NAME_MAX } from '@studio/shared';
import {
  addSentMessage,
  applyLiveResponse,
  emptyChatView,
  liveQuery,
  MAX_FLOATING_REACTIONS_PER_ANSWER,
  reactionsToFloat,
  readViewerName,
  saveViewerName,
  sendFailureLine,
  tidyViewerName,
} from '../src/utils/watchViewerChat.ts';
import { selectOverlayComments, CHAT_OVERLAY_VIEWER_PREFIX } from '../src/utils/chatOverlayComments.ts';
import { questionAuthorLabel } from '../src/utils/viewerQuestionLabel.ts';
import { getCommentSourceLabel, createHighlightedCommentFromChatMessage } from '../src/components/CommentHighlight.tsx';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}

const line = (id: string, text = id): WatchChatMessage => ({ id, from: 'viewer', name: 'Ana', text, at: 1 });
const answer = (overrides: Partial<WatchLiveResponse> = {}): WatchLiveResponse => ({
  epoch: 'e1',
  cursor: 5,
  reset: false,
  switches: { chat: true, reactions: true, questions: true },
  messages: [],
  removed: [],
  reactions: {},
  pollMs: 4000,
  ...overrides,
});

describe('the viewer name kept in the browser', () => {
  it('tidies spaces and cuts to the name limit', () => {
    assert.equal(tidyViewerName('  Ana    Cruz  '), 'Ana Cruz');
    assert.equal(Array.from(tidyViewerName('x'.repeat(100))).length, VIEWER_NAME_MAX);
  });

  it('uses the registration name only until the viewer chooses one', () => {
    const storage = memoryStorage();
    assert.equal(readViewerName('Maria Santos', storage), 'Maria Santos');
    saveViewerName('Ate Mia', storage);
    assert.equal(readViewerName('Maria Santos', storage), 'Ate Mia');
  });

  it('works when the browser blocks storage', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.equal(readViewerName('Maria', blocked), 'Maria');
    assert.doesNotThrow(() => saveViewerName('Maria', blocked));
    assert.equal(readViewerName('', null), '');
  });
});

describe('what the page asks for', () => {
  it('asks for the recent list when it has nothing, and only the new part after that', () => {
    assert.equal(liveQuery(emptyChatView()), '');
    assert.equal(liveQuery({ epoch: 'a b', cursor: 7 }), '?after=7&epoch=a%20b');
  });
});

describe('reading the answer', () => {
  it('starts over when the server says reset', () => {
    const view = { epoch: 'old', cursor: 1, messages: [line('x')] };
    const next = applyLiveResponse(view, answer({ reset: true, cursor: 9, messages: [line('a'), line('b')] }));
    assert.deepEqual(next.messages.map((m) => m.id), ['a', 'b']);
    assert.equal(next.cursor, 9);
  });

  it('adds new messages once, drops removed ones, and keeps the last 100', () => {
    let view = applyLiveResponse(emptyChatView(), answer({ reset: true, messages: [line('a'), line('b')] }));
    view = applyLiveResponse(view, answer({ cursor: 6, messages: [line('b'), line('c')], removed: ['a'] }));
    assert.deepEqual(view.messages.map((m) => m.id), ['b', 'c']);
    const many = Array.from({ length: VIEWER_FEED_VISIBLE + 20 }, (_, i) => line(`m${i}`));
    view = applyLiveResponse(view, answer({ cursor: 7, messages: many }));
    assert.equal(view.messages.length, VIEWER_FEED_VISIBLE);
    assert.equal(view.messages[view.messages.length - 1].id, `m${VIEWER_FEED_VISIBLE + 19}`);
  });

  it('gives back the same object when nothing changed', () => {
    const view = applyLiveResponse(emptyChatView(), answer({ reset: true, messages: [line('a')] }));
    assert.equal(applyLiveResponse(view, answer()), view);
  });

  it('shows nothing while chat is off but keeps its place, so reactions still reach the page', () => {
    const view = applyLiveResponse(emptyChatView(), answer({ reset: true, messages: [line('a')] }));
    const noChat = { chat: false, reactions: true, questions: false };
    const off = applyLiveResponse(view, answer({ cursor: 6, switches: noChat }));
    assert.deepEqual(off, { epoch: 'e1', cursor: 6, messages: [] });
    assert.equal(liveQuery(off), '?after=6&epoch=e1', 'the next ask holds a place, so it is not a full reset');
    const stillOff = applyLiveResponse(off, answer({ cursor: 6, switches: noChat }));
    assert.equal(stillOff, off);
    const first = applyLiveResponse(emptyChatView(), answer({ reset: true, cursor: 2, switches: noChat }));
    assert.equal(liveQuery(first), '?after=2&epoch=e1');
  });

  it('starts over with the fresh list when chat comes back on', () => {
    const off = { epoch: 'e1', cursor: 6, messages: [] as WatchChatMessage[] };
    const back = applyLiveResponse(off, answer({ reset: true, cursor: 7, messages: [] }));
    assert.deepEqual(back, { epoch: 'e1', cursor: 7, messages: [] });
    const next = applyLiveResponse(back, answer({ cursor: 8, messages: [line('x')] }));
    assert.deepEqual(next.messages.map((m) => m.id), ['x']);
  });

  it('shows the viewer\'s own message at once and does not repeat it when the server sends it', () => {
    let view = addSentMessage(emptyChatView(), line('mine'));
    assert.equal(addSentMessage(view, line('mine')), view);
    view = applyLiveResponse({ ...view, epoch: 'e1', cursor: 4 }, answer({ cursor: 5, messages: [line('mine'), line('theirs')] }));
    assert.deepEqual(view.messages.map((m) => m.id), ['mine', 'theirs']);
  });
});

describe('floating reactions', () => {
  it('floats other people\'s reactions and not the ones this viewer already floated', () => {
    const { floats, ownLeft } = reactionsToFloat({ like: 3, love: 1 }, { like: 2 });
    assert.deepEqual(floats.filter((type) => type === 'like').length, 1);
    assert.deepEqual(floats.filter((type) => type === 'love').length, 1);
    assert.equal(ownLeft.like, 0);
  });

  it('keeps what is still owed when the server has not reported it yet', () => {
    const { floats, ownLeft } = reactionsToFloat({}, { clap: 2 });
    assert.deepEqual(floats, []);
    assert.equal(ownLeft.clap, 2);
  });

  it('never floats more than a handful from one answer, and mixes the types', () => {
    const { floats } = reactionsToFloat({ like: 500, love: 500, clap: 1 });
    assert.equal(floats.length, MAX_FLOATING_REACTIONS_PER_ANSWER);
    assert.ok(floats.includes('clap'));
  });

  it('ignores counts that are not real numbers', () => {
    const bad = { like: Number.NaN, love: -4, clap: Infinity, wow: 2.9 } as never;
    const { floats } = reactionsToFloat(bad);
    assert.ok(floats.length <= MAX_FLOATING_REACTIONS_PER_ANSWER);
    assert.equal(floats.filter((type) => type === 'wow').length, 2);
  });
});

describe('the line shown when a send fails', () => {
  it('uses the server\'s own plain words', () => {
    assert.equal(sendFailureLine(Object.assign(new Error('Please slow down. You can send again in 2 seconds.'), { status: 429 })), 'Please slow down. You can send again in 2 seconds.');
  });

  it('has plain words when there is no answer', () => {
    assert.match(sendFailureLine(new Error('Failed to fetch')), /did not go through/);
    assert.match(sendFailureLine(Object.assign(new Error(''), { status: 429 })), /slow down/i);
  });
});

describe('a viewer is never mistaken for the host', () => {
  const viewerMessage = (name: string): ChatMessage => ({
    id: 'v1',
    senderId: 'external:watch:abc',
    senderName: name,
    content: 'Hello everyone',
    timestamp: new Date(Date.UTC(2026, 10, 1, 10, 0, 0)).toISOString(),
    isBackstage: false,
    source: { platform: 'watch', externalId: 'abc' },
  });
  const settings = { mode: 'all' as const, paused: false, pausedIds: [], hiddenIds: [], shownIds: [] };

  it('puts the word Viewer before the name on the on-screen chat', () => {
    const [comment] = selectOverlayComments({ messages: [viewerMessage('Host')], settings, greenRoomIds: new Set() });
    assert.equal(comment.source, 'watch');
    assert.equal(comment.author, `${CHAT_OVERLAY_VIEWER_PREFIX}Host`);
    assert.ok(comment.author.startsWith('Viewer'));
  });

  it('follows the "approved only" choice like every other outside comment', () => {
    const approved = { ...settings, mode: 'approved' as const };
    assert.equal(selectOverlayComments({ messages: [viewerMessage('Ana')], settings: approved, greenRoomIds: new Set() }).length, 0);
    const shown = { ...approved, shownIds: ['v1'] };
    assert.equal(selectOverlayComments({ messages: [viewerMessage('Ana')], settings: shown, greenRoomIds: new Set() }).length, 1);
  });

  it('marks a featured comment and a question as from a viewer', () => {
    assert.equal(getCommentSourceLabel('watch'), 'Viewer');
    assert.equal(createHighlightedCommentFromChatMessage(viewerMessage('Pastor John'))?.sourcePlatform, 'watch');
    assert.equal(questionAuthorLabel({ authorName: 'Host', fromViewer: true }), 'Host (viewer)');
    assert.equal(questionAuthorLabel({ authorName: 'Maria' }), 'Maria');
  });
});
