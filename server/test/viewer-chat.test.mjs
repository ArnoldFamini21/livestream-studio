import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

process.env.SIGNALING_RESUME_GRACE_MS = '300';

const { watchRouter } = await import('../dist/routes/watch.js');
const { createRoom, getRooms, setupSignalingServer } = await import('../dist/services/signaling.js');
const { ViewerChatError, ViewerChatRoom, networkGroupOf, networkKeyFor, viewerSenderId } = await import('../dist/services/viewerChat.js');

// ---------------------------------------------------------------------------
// The rules alone, with a fake studio and the clock passed in
// ---------------------------------------------------------------------------

function fakeHost() {
  const log = { chat: [], removed: [], questions: [], dismissed: [], reactions: [], states: [] };
  const questions = [];
  const host = {
    log,
    chat: new Map(),
    addChatMessage(message) { log.chat.push(message); host.chat.set(message.id, message); },
    removeChatMessages(ids) { for (const id of ids) { log.removed.push(id); host.chat.delete(id); } },
    findChatMessage: (id) => host.chat.get(id),
    chatMessageIdsBySender: (senders) => Array.from(host.chat.values()).filter((m) => senders.has(m.senderId)).map((m) => m.id),
    addQuestion(question) { log.questions.push(question); questions.push(question); },
    questions,
    findQuestion: (id) => questions.find((q) => q.id === id),
    countViewerQuestions: (authorIds) => {
      const open = questions.filter((q) => q.status === 'pending' || q.status === 'approved');
      return { waiting: open.filter((q) => authorIds.has(q.authorId)).length, open: open.length };
    },
    dismissViewerQuestions(authorIds) { log.dismissed.push([...authorIds]); for (const q of questions) if (authorIds.has(q.authorId)) q.status = 'dismissed'; },
    sendReactionCounts(counts) { log.reactions.push(counts); },
    sendState(state) { log.states.push(state); },
  };
  return host;
}

const viewer = (n) => `viewer-${String(n).padStart(10, '0')}`;
const turnOnEverything = (room) => room.applySwitches({ chat: true, reactions: true, questions: true });
const code = (error) => error instanceof ViewerChatError && error.code;

describe('viewer chat rules', () => {
  it('starts with chat, reactions and questions all off, and refuses each with a plain line', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    assert.deepEqual(room.getSwitches(), { chat: false, reactions: false, questions: false });
    assert.throws(() => room.postMessage({ viewerId: viewer(1), text: 'hi' }, 'net', 1000), (e) => code(e) === 'CHAT_OFF' && e.statusCode === 403 && /turned off/.test(e.message));
    assert.throws(() => room.postQuestion({ viewerId: viewer(1), text: 'why?' }, 'net', 1000), (e) => code(e) === 'QUESTIONS_OFF');
    assert.throws(() => room.postReaction({ viewerId: viewer(1), reaction: 'like' }, 'net', 1000), (e) => code(e) === 'REACTIONS_OFF');
    assert.equal(host.log.chat.length, 0);
  });

  it('enforces each switch on its own, and the page is told which are on', () => {
    const room = new ViewerChatRoom(fakeHost());
    room.applySwitches({ questions: true });
    assert.deepEqual(room.live({}, 1000).switches, { chat: false, reactions: false, questions: true });
    assert.throws(() => room.postMessage({ viewerId: viewer(1), text: 'hi' }, 'n', 1), (e) => code(e) === 'CHAT_OFF');
    assert.equal(room.postQuestion({ viewerId: viewer(1), text: 'Is there a study?' }, 'n', 1).questionId.length > 0, true);
    assert.equal(room.applySwitches({ chat: 'yes' }), false, 'only real booleans count');
    assert.equal(room.applySwitches(null), false);
  });

  it('cleans, filters and bounds what a viewer sends, and the studio gets a viewer-marked message', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    const result = room.postMessage({ viewerId: viewer(1), name: '  Host  ', text: '  God is   good, you gago  ' }, 'net', 5000);
    assert.equal(result.message.name, 'Host');
    assert.equal(result.message.text, 'God is good, you ****');
    assert.equal(result.message.from, 'viewer');
    const studio = host.log.chat[0];
    assert.equal(studio.id, result.message.id, 'the studio and the watch pages share the message id');
    assert.equal(studio.source.platform, 'watch');
    assert.equal(studio.senderName, 'Host');
    assert.ok(studio.senderId.startsWith('external:watch:'), 'never the id of a person in the studio');
    assert.equal(studio.isBackstage, false);
    assert.equal(studio.recipientId, undefined);
    assert.equal(studio.content, 'God is good, you ****');
    assert.ok(!JSON.stringify(studio).includes(viewer(1)), 'the viewer id never reaches the studio');
    assert.ok(!JSON.stringify(studio).includes(networkKeyFor('net')));
  });

  it('answers bad input plainly', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    const bad = (input, expected) => assert.throws(() => room.postMessage(input, 'n', 10_000), (e) => e instanceof ViewerChatError && e.statusCode === 400 && (expected ? e.message.includes(expected) : true));
    bad({ viewerId: 'x', text: 'hi' }, 'reload');
    bad({ text: 'hi' });
    bad({ viewerId: viewer(1), text: 'x'.repeat(301) }, '300');
    bad({ viewerId: viewer(1), text: '   ' }, 'write a message');
    bad({ viewerId: viewer(1), text: 5 });
    bad({ viewerId: viewer(1), name: 'n'.repeat(41), text: 'hi' }, '40');
    bad({ viewerId: viewer(1), name: { a: 1 }, text: 'hi' });
    assert.equal(room.postMessage({ viewerId: viewer(1), name: 'n'.repeat(40), text: 'x'.repeat(300) }, 'n', 10_000).message.text.length, 300);
    assert.equal(room.postMessage({ viewerId: viewer(2), name: '', text: 'a name is optional' }, 'n', 10_000).message.name, 'Viewer');
    assert.equal(room.postMessage({ viewerId: viewer(3), name: String.fromCodePoint(0x3164), text: 'an invisible name' }, 'n', 10_000).message.name, 'Viewer');
  });

  it('keeps messages as plain text: nothing is turned into markup or a link', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    const text = '<img src=x onerror=alert(1)> https://evil.example/click <a href="x">y</a>';
    assert.equal(room.postMessage({ viewerId: viewer(1), name: '<b>Pastor</b>', text }, 'n', 1000).message.text, text, 'stored as typed, shown as text by the page');
  });

  it('refuses the same message twice in a row, and asks a fast sender to slow down', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    room.postMessage({ viewerId: viewer(1), text: 'Amen!' }, 'n', 10_000);
    assert.throws(() => room.postMessage({ viewerId: viewer(1), text: 'amen' }, 'n', 10_500), (e) => code(e) === 'DUPLICATE_MESSAGE' && e.statusCode === 409);
    assert.throws(() => room.postMessage({ viewerId: viewer(1), text: 'Glory' }, 'n', 10_500), (e) => code(e) === 'RATE_LIMITED' && e.statusCode === 429 && /slow down/i.test(e.message) && e.retryAfterMs === 1500);
    assert.equal(room.postMessage({ viewerId: viewer(1), text: 'Glory' }, 'n', 12_000).message.text, 'Glory');
    assert.equal(room.postMessage({ viewerId: viewer(1), text: 'Amen' }, 'n', 14_000).message.text, 'Amen', 'not in a row any more');
  });

  it('allows 5 messages in 30 seconds per viewer', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    for (let i = 0; i < 5; i += 1) room.postMessage({ viewerId: viewer(1), text: `line ${i}` }, 'n', 10_000 + i * 2000);
    assert.throws(() => room.postMessage({ viewerId: viewer(1), text: 'line 5' }, 'n', 20_000), (e) => code(e) === 'RATE_LIMITED');
    assert.equal(room.postMessage({ viewerId: viewer(1), text: 'line 6' }, 'n', 40_001).message.text, 'line 6');
  });

  it('lets a congregation behind one network write (30 in 30 s), and stops a flood past that', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    for (let i = 0; i < 30; i += 1) room.postMessage({ viewerId: viewer(i), text: `hello ${i}` }, 'church-wifi', 10_000 + i);
    assert.throws(() => room.postMessage({ viewerId: viewer(40), text: 'one more' }, 'church-wifi', 10_100), (e) => code(e) === 'RATE_LIMITED' && /busy/i.test(e.message) && !/slow down/i.test(e.message));
    assert.equal(room.postMessage({ viewerId: viewer(40), text: 'one more' }, 'home', 10_100).message.name, 'Viewer');
  });

  it('has a room-wide ceiling that many networks together cannot get past', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    let accepted = 0;
    for (let i = 0; i < 160; i += 1) {
      try { room.postMessage({ viewerId: viewer(i), text: `msg ${i}` }, `net-${i}`, 50_000 + i); accepted += 1; } catch (error) { assert.equal(code(error), 'RATE_LIMITED'); }
    }
    assert.equal(accepted, 120);
  });

  it('keeps reactions on their own budget and sends counts, not names', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    room.postReaction({ viewerId: viewer(1), reaction: 'love' }, 'n', 1000);
    room.postReaction({ viewerId: viewer(2), reaction: 'love' }, 'n', 1001);
    room.postReaction({ viewerId: viewer(3), reaction: 'clap' }, 'n', 1002);
    assert.throws(() => room.postReaction({ viewerId: viewer(1), reaction: 'love' }, 'n', 1100), (e) => code(e) === 'RATE_LIMITED');
    assert.throws(() => room.postReaction({ viewerId: viewer(1), reaction: 'laugh' }, 'n', 9000), (e) => e.statusCode === 400, 'only the offered reactions');
    assert.throws(() => room.postReaction({ viewerId: viewer(1), reaction: '<b>' }, 'n', 9000), (e) => e.statusCode === 400);
    room.flushReactions();
    assert.deepEqual(host.log.reactions, [{ love: 2, clap: 1 }]);
    assert.equal(JSON.stringify(host.log.reactions).includes('viewer'), false);
    assert.deepEqual(room.live({}, 2000).reactions, {}, 'a fresh page does not replay old reactions');
    room.dispose();
  });

  it('serves messages, removals and reactions in one small answer with a cursor', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    const first = room.live({}, 1000);
    assert.deepEqual([first.reset, first.messages], [true, []]);
    room.postMessage({ viewerId: viewer(1), name: 'Ana', text: 'Hello' }, 'n', 2000);
    const next = room.live({ after: String(first.cursor), epoch: first.epoch }, 3000);
    assert.equal(next.reset, false);
    assert.deepEqual(next.messages.map((m) => [m.name, m.text, m.from]), [['Ana', 'Hello', 'viewer']]);
    const quiet = room.live({ after: String(next.cursor), epoch: next.epoch }, 4000);
    assert.deepEqual([quiet.messages, quiet.removed, quiet.reactions, quiet.reset], [[], [], {}, false]);
    assert.ok(Object.keys(quiet).sort().join() === 'cursor,epoch,messages,pollMs,reactions,removed,reset,switches');
    assert.ok(quiet.pollMs >= 4000);
  });

  it('hides the messages while chat is off, and starts the list empty when chat is turned back on', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    room.postMessage({ viewerId: viewer(1), text: 'Hello' }, 'n', 2000);
    const seen = room.live({}, 3000);
    room.applySwitches({ chat: false });
    const off = room.live({ after: String(seen.cursor), epoch: seen.epoch }, 5000);
    assert.deepEqual([off.messages, off.removed, off.reset, off.switches.chat], [[], [], false, false], 'the page keeps its place');
    assert.deepEqual(room.live({}, 5100).messages, [], 'a new page sees nothing while chat is off');
    room.applySwitches({ chat: true });
    const back = room.live({ after: String(off.cursor), epoch: off.epoch }, 6000);
    assert.deepEqual([back.reset, back.messages], [true, []], 'a page that was there starts over with an empty list');
    assert.deepEqual(room.live({}, 6100).messages, [], 'and a new page does not see what was said before either');
    room.postMessage({ viewerId: viewer(2), text: 'Fresh start' }, 'n', 7000);
    assert.deepEqual(room.live({ after: String(back.cursor), epoch: back.epoch }, 8000).messages.map((m) => m.text), ['Fresh start']);
  });

  it('does not show studio lines written before chat was switched on, or while it was off', () => {
    const room = new ViewerChatRoom(fakeHost());
    const guest = { senderId: 'g1', senderName: 'Rosa', timestamp: new Date(1000).toISOString(), isBackstage: false };
    room.noteStudioMessage({ ...guest, id: 'before-1', content: 'Pastor, please mute Sis Rosa, she is coughing' }, false, 1000);
    room.applySwitches({ chat: true });
    assert.deepEqual(room.live({}, 2000).messages, [], 'the line was written when viewers could see nothing');
    room.noteStudioMessage({ ...guest, id: 'during-1', content: 'Welcome everyone' }, false, 3000);
    assert.deepEqual(room.live({}, 3100).messages.map((m) => m.id), ['during-1']);
    room.applySwitches({ chat: false });
    room.noteStudioMessage({ ...guest, id: 'crisis-1', content: 'Team: cut the music now' }, false, 4000);
    room.applySwitches({ chat: true });
    assert.deepEqual(room.live({}, 5000).messages, [], 'chat off, team talk, chat on: none of it shows');
  });

  it('lets pages see other viewers\' reactions when only reactions are on', () => {
    const room = new ViewerChatRoom(fakeHost());
    room.applySwitches({ reactions: true });
    const first = room.live({}, 1000, 'net-b');
    assert.equal(first.switches.chat, false);
    room.postReaction({ viewerId: viewer(1), reaction: 'love' }, 'net-a', 2000);
    room.postReaction({ viewerId: viewer(2), reaction: 'clap' }, 'net-a', 2001);
    const next = room.live({ after: String(first.cursor), epoch: first.epoch }, 3000, 'net-b');
    assert.equal(next.reset, false);
    assert.deepEqual(next.reactions, { love: 1, clap: 1 });
    assert.deepEqual([next.messages, next.removed], [[], []]);
    const quiet = room.live({ after: String(next.cursor), epoch: next.epoch }, 7000, 'net-b');
    assert.deepEqual(quiet.reactions, {});
  });

  it('does not show reaction counts when the reactions switch is off', () => {
    const room = new ViewerChatRoom(fakeHost());
    room.applySwitches({ reactions: true });
    const first = room.live({}, 1000);
    room.postReaction({ viewerId: viewer(1), reaction: 'love' }, 'n', 2000);
    room.applySwitches({ reactions: false });
    assert.deepEqual(room.live({ after: String(first.cursor), epoch: first.epoch }, 3000).reactions, {});
  });

  it('asks pages to come back slowly while all three switches are off', () => {
    const room = new ViewerChatRoom(fakeHost());
    assert.equal(room.live({}, 1000).pollMs, 20_000);
    room.applySwitches({ questions: true });
    assert.equal(room.live({}, 2000).pollMs, 4000);
    room.applySwitches({ questions: false });
    assert.equal(room.live({}, 3000).pollMs, 20_000);
  });

  it('lets one network ask for the whole list only so often, and never holds back a page that has its place', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    room.postMessage({ viewerId: viewer(1), text: 'Hello' }, 'n', 500);
    for (let i = 0; i < 120; i += 1) room.live({}, 1000 + i, 'script');
    assert.throws(() => room.live({}, 2000, 'script'), (e) => code(e) === 'READ_BUSY' && e.statusCode === 429 && /busy/i.test(e.message) && e.retryAfterMs > 0);
    assert.equal(room.live({}, 2000, 'church').messages.length, 1, 'another network is not affected');
    const place = room.live({}, 2100, 'church');
    for (let i = 0; i < 500; i += 1) assert.equal(room.live({ after: String(place.cursor), epoch: place.epoch }, 2200 + i, 'script').reset, false);
    assert.equal(room.live({}, 62_500, 'script').messages.length, 1, 'allowed again a minute later');
  });

  it('does not count full-list asks against a network while the list is empty or chat is off', () => {
    const room = new ViewerChatRoom(fakeHost());
    room.applySwitches({ chat: true });
    for (let i = 0; i < 300; i += 1) room.live({}, 1000 + i, 'script');
    room.postMessage({ viewerId: viewer(1), text: 'Hello' }, 'n', 2000);
    room.applySwitches({ chat: false });
    for (let i = 0; i < 300; i += 1) room.live({}, 3000 + i, 'script');
  });

  it('shows the studio\'s public messages to viewers, and only those, filtered and bounded', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    const base = { senderId: 'p1', senderName: 'Pastor Arnold', timestamp: new Date(5000).toISOString() };
    room.noteStudioMessage({ ...base, id: 's1', content: 'Welcome, everyone!', isBackstage: false }, false, 5000);
    room.noteStudioMessage({ ...base, id: 's2', content: 'Backstage note', isBackstage: true }, false, 5001);
    room.noteStudioMessage({ ...base, id: 's3', content: 'Private note', isBackstage: false, recipientId: 'p2', recipientName: 'X' }, false, 5002);
    room.noteStudioMessage({ ...base, id: 's4', content: 'Waiting in green room', isBackstage: false }, true, 5003);
    room.noteStudioMessage({ ...base, id: 's5', content: 'A YouTube comment', isBackstage: false, source: { platform: 'youtube', externalId: 'x' } }, false, 5004);
    room.noteStudioMessage({ ...base, id: 's6', content: 'shit '.repeat(300), isBackstage: false }, false, 5005);
    const messages = room.live({}, 6000).messages;
    assert.deepEqual(messages.map((m) => m.id), ['s1', 's6']);
    assert.equal(messages[0].from, 'studio');
    assert.equal(messages[0].name, 'Pastor Arnold');
    assert.ok(messages[1].text.length <= 500);
    assert.ok(!/shit/i.test(messages[1].text));
  });

  it('never gives a viewer another viewer\'s id, handle or network key', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    const posted = room.postMessage({ viewerId: viewer(7), name: 'Ana', text: 'Hello' }, 'net-secret', 1000);
    for (const text of [JSON.stringify(posted), JSON.stringify(room.live({}, 2000)), JSON.stringify(room.statePayload())]) {
      assert.ok(!text.includes(viewer(7)));
      assert.ok(!text.includes('net-secret'));
      assert.ok(!text.includes(networkKeyFor('net-secret')));
      assert.ok(!text.includes('external:watch'));
    }
  });

  it('removes one message from the studio chat and from every watch page', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    const keep = room.postMessage({ viewerId: viewer(1), text: 'Good morning' }, 'n', 1000).message;
    const bad = room.postMessage({ viewerId: viewer(2), text: 'Something unwelcome' }, 'n', 1001).message;
    const seen = room.live({}, 1500);
    assert.equal(room.removeMessage(bad.id), true);
    assert.deepEqual(host.log.removed, [bad.id]);
    const after = room.live({ after: String(seen.cursor), epoch: seen.epoch }, 2000);
    assert.deepEqual(after.removed, [bad.id]);
    assert.deepEqual(room.live({}, 2100).messages.map((m) => m.id), [keep.id], 'a new page never sees it');
    assert.equal(room.removeMessage(bad.id), false, 'already gone');
    assert.equal(room.removeMessage('studio-message'), false, 'only viewer messages can be removed this way');
  });

  it('blocks one viewer by id: removes their earlier messages and questions, refuses the next ones, leaves others', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    const first = room.postMessage({ viewerId: viewer(1), name: 'Troll', text: 'first' }, 'wifi', 1000).message;
    room.postMessage({ viewerId: viewer(1), name: 'Troll', text: 'second' }, 'wifi', 3000);
    room.postQuestion({ viewerId: viewer(1), name: 'Troll', text: 'a question' }, 'wifi', 5000);
    const other = room.postMessage({ viewerId: viewer(2), name: 'Ana', text: 'kind words' }, 'wifi', 6000).message;
    const block = room.blockViewer(first.id, 'viewer', 7000);
    assert.deepEqual(Object.keys(block).sort(), ['blockedAt', 'id', 'name', 'scope']);
    assert.equal(block.name, 'Troll');
    assert.equal(block.scope, 'viewer');
    assert.equal(host.log.removed.length, 2, 'both earlier messages');
    assert.deepEqual(room.live({}, 7100).messages.map((m) => m.id), [other.id]);
    assert.equal(host.log.questions[0].status, 'dismissed');
    for (const attempt of [
      () => room.postMessage({ viewerId: viewer(1), text: 'again' }, 'wifi', 20_000),
      () => room.postQuestion({ viewerId: viewer(1), text: 'again?' }, 'wifi', 20_000),
      () => room.postReaction({ viewerId: viewer(1), reaction: 'like' }, 'wifi', 20_000),
    ]) assert.throws(attempt, (e) => code(e) === 'VIEWER_BLOCKED' && e.statusCode === 403 && /no longer/.test(e.message));
    assert.equal(room.postMessage({ viewerId: viewer(2), text: 'still welcome' }, 'wifi', 20_000).message.text, 'still welcome', 'same Wi-Fi, other viewer: fine');
    assert.equal(room.statePayload().blocks.length, 1);
    assert.deepEqual(host.log.states.at(-1).blocks.map((b) => b.name), ['Troll']);
  });

  it('blocks a whole network when asked, and unblocking lets them back (earlier messages stay removed)', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    const a = room.postMessage({ viewerId: viewer(1), name: 'Troll', text: 'a' }, 'cafe', 1000).message;
    room.postMessage({ viewerId: viewer(2), name: 'Friend of troll', text: 'b' }, 'cafe', 1500);
    room.postMessage({ viewerId: viewer(3), name: 'Elsewhere', text: 'c' }, 'home', 1600);
    const block = room.blockViewer(a.id, 'network', 3000);
    assert.equal(block.scope, 'network');
    assert.equal(host.log.removed.length, 2, 'everything from that network');
    assert.deepEqual(room.live({}, 3100).messages.map((m) => m.name), ['Elsewhere']);
    assert.throws(() => room.postMessage({ viewerId: viewer(9), text: 'new person, same Wi-Fi' }, 'cafe', 9000), (e) => code(e) === 'VIEWER_BLOCKED');
    assert.equal(room.postMessage({ viewerId: viewer(9), text: 'other network' }, 'home', 9000).message.text, 'other network');
    assert.equal(room.unblock(block.id), true);
    assert.equal(room.unblock(block.id), false);
    assert.equal(room.postMessage({ viewerId: viewer(1), text: 'back again' }, 'cafe', 20_000).message.text, 'back again');
    assert.deepEqual(room.live({}, 21_000).messages.map((m) => m.name).includes('Friend of troll'), false);
  });

  it('blocks a viewer who only asks questions, from the question', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    room.postQuestion({ viewerId: viewer(1), name: 'Prayer spammer', text: 'first question' }, 'cafe', 1000);
    room.postQuestion({ viewerId: viewer(1), name: 'Prayer spammer', text: 'second question' }, 'cafe', 3000);
    room.postQuestion({ viewerId: viewer(2), name: 'Ana', text: 'an honest question' }, 'cafe', 4000);
    const bad = host.questions[0];
    const block = room.blockViewer(bad.id, 'viewer', 5000);
    assert.equal(block.name, 'Prayer spammer');
    assert.deepEqual(host.questions.map((q) => q.status), ['dismissed', 'dismissed', 'pending'], 'only that viewer questions are taken off the queue');
    assert.throws(() => room.postQuestion({ viewerId: viewer(1), text: 'again?' }, 'cafe', 20_000), (e) => code(e) === 'VIEWER_BLOCKED');
    assert.equal(room.postQuestion({ viewerId: viewer(2), text: 'one more' }, 'cafe', 20_000).questionId.length > 0, true);
    const wholeNetwork = room.blockViewer(host.questions[2].id, 'network', 21_000);
    assert.equal(wholeNetwork.scope, 'network');
    assert.throws(() => room.postQuestion({ viewerId: viewer(3), text: 'new person' }, 'cafe', 40_000), (e) => code(e) === 'VIEWER_BLOCKED');
  });

  it('refuses a block it cannot trace or does not understand, and a second click on a gone message', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    const a = room.postMessage({ viewerId: viewer(1), text: 'a' }, 'n', 1000).message;
    assert.throws(() => room.blockViewer('nope', 'viewer', 4000), (e) => code(e) === 'VIEWER_NOT_FOUND');
    assert.throws(() => room.blockViewer(a.id, 'everyone', 4000), (e) => e.statusCode === 400);
    room.blockViewer(a.id, 'viewer', 5000);
    assert.throws(() => room.blockViewer(a.id, 'viewer', 6000), (e) => code(e) === 'VIEWER_NOT_FOUND', 'the message is gone, so is the way back to its writer');
    assert.equal(room.statePayload().blocks.length, 1, 'still just one block');
  });

  it('limits questions: three waiting per viewer, and a room-wide count', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    for (let i = 0; i < 3; i += 1) room.postQuestion({ viewerId: viewer(1), name: 'Ana', text: `question ${i}` }, 'n', 10_000 + i * 2000);
    assert.throws(() => room.postQuestion({ viewerId: viewer(1), text: 'question 4' }, 'n', 20_000), (e) => code(e) === 'QUESTION_LIMIT');
    const q = host.log.questions[0];
    assert.deepEqual([q.fromViewer, q.status, q.authorName, q.highlighted, q.upvotes], [true, 'pending', 'Ana', false, 0]);
    assert.ok(q.authorId.startsWith('external:watch:'));
    assert.throws(() => room.postQuestion({ viewerId: viewer(2), text: 'x'.repeat(301) }, 'n', 20_000), (e) => e.statusCode === 400);
  });

  it('frees room in the question list when the host answers or dismisses questions', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    // Every question from a new viewer id on a new network: only the room-wide count can stop it.
    for (let i = 0; i < 200; i += 1) room.postQuestion({ viewerId: viewer(i), name: `Stranger ${i}`, text: `question ${i}` }, `net-${i}`, 1000 + i * 1000);
    assert.throws(() => room.postQuestion({ viewerId: viewer(500), text: 'Please pray for my mother' }, 'honest-home', 300_000), (e) => code(e) === 'QUESTIONS_FULL');
    for (const q of host.questions) q.status = 'dismissed';
    assert.equal(room.postQuestion({ viewerId: viewer(500), text: 'Please pray for my mother' }, 'honest-home', 301_000).questionId.length > 0, true, 'the host cleared the list, so there is room again');
    host.questions[0].status = 'answered';
  });

  it('limits the questions waiting from one network, even when every question has a new viewer id', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    for (let i = 0; i < 15; i += 1) room.postQuestion({ viewerId: viewer(i), text: `question ${i}` }, 'one-address', 1000 + i * 1000);
    assert.throws(() => room.postQuestion({ viewerId: viewer(99), text: 'sixteenth' }, 'one-address', 20_000), (e) => code(e) === 'QUESTION_LIMIT' && /connection/.test(e.message));
    assert.equal(room.postQuestion({ viewerId: viewer(98), text: 'from home' }, 'other-address', 20_000).questionId.length > 0, true, 'another network is not affected');
    host.questions[0].status = 'dismissed';
    assert.equal(room.postQuestion({ viewerId: viewer(97), text: 'room again' }, 'one-address', 21_000).questionId.length > 0, true);
  });

  it('masks a profane name too, before it reaches the studio or the page', () => {
    const host = fakeHost();
    const room = new ViewerChatRoom(host);
    turnOnEverything(room);
    const message = room.postMessage({ viewerId: viewer(1), name: 'gago ka', text: 'hello' }, 'n', 1000).message;
    assert.equal(message.name, '**** ka');
    assert.equal(host.log.chat[0].senderName, '**** ka');
    room.postQuestion({ viewerId: viewer(2), name: 'shit', text: 'why?' }, 'n', 2000);
    assert.equal(host.questions[0].authorName, '****');
    assert.equal(room.statePayload().blocks.length, 0);
  });

  it('counts every address on one IPv6 /64 as one network, and an IPv4-mapped address as the IPv4 one', () => {
    assert.equal(networkGroupOf('203.0.113.9'), '203.0.113.9');
    assert.equal(networkGroupOf('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(networkGroupOf('::ffff:cb00:7109'), '203.0.113.9');
    assert.equal(networkGroupOf('2001:db8:abcd:12:aaaa:bbbb:cccc:dddd'), networkGroupOf('2001:DB8:abcd:12::1'));
    assert.equal(networkGroupOf('2001:db8:abcd:12:1:2:3:4%eth0'), networkGroupOf('2001:db8:abcd:12::99'));
    assert.notEqual(networkGroupOf('2001:db8:abcd:12::1'), networkGroupOf('2001:db8:abcd:13::1'));
    assert.notEqual(networkGroupOf('2001:db8:abcd:12::1'), networkGroupOf('203.0.113.9'));
    assert.equal(networkKeyFor('2001:db8:abcd:12:1:2:3:4'), networkKeyFor('2001:db8:abcd:12:ffff:eeee:dddd:cccc'));
    assert.equal(networkKeyFor('::ffff:203.0.113.9'), networkKeyFor('203.0.113.9'));
    assert.notEqual(networkKeyFor('2001:db8:abcd:12::1'), networkKeyFor('2001:db8:abcd:13::1'));
    assert.equal(networkGroupOf(undefined), 'unknown');
    assert.equal(networkGroupOf('not an address'), 'not an address');
  });

  it('a blocked network stays blocked when the troll changes address inside the same IPv6 /64', () => {
    const room = new ViewerChatRoom(fakeHost());
    turnOnEverything(room);
    const first = room.postMessage({ viewerId: viewer(1), name: 'Troll', text: 'a' }, networkKeyFor('2001:db8:abcd:12:1:1:1:1'), 1000).message;
    room.blockViewer(first.id, 'network', 2000);
    assert.throws(() => room.postMessage({ viewerId: viewer(2), text: 'b' }, networkKeyFor('2001:db8:abcd:12:9:9:9:9'), 3000), (e) => code(e) === 'VIEWER_BLOCKED');
  });

  it('hashes the address with a salt: stable, short, and not the address', () => {
    const salt = Buffer.from('salt-one');
    assert.equal(networkKeyFor('203.0.113.9', salt), networkKeyFor('203.0.113.9', salt));
    assert.notEqual(networkKeyFor('203.0.113.9', salt), networkKeyFor('203.0.113.10', salt));
    assert.notEqual(networkKeyFor('203.0.113.9', salt), networkKeyFor('203.0.113.9', Buffer.from('salt-two')), 'another salt, another key');
    assert.equal(networkKeyFor('203.0.113.9').length, 22);
    assert.ok(!networkKeyFor('203.0.113.9').includes('203'));
    assert.notEqual(networkKeyFor('203.0.113.9'), Buffer.from(JSON.stringify('x')).toString('base64url'));
    assert.equal(viewerSenderId('abc'), 'external:watch:abc');
  });

  it('never writes to the console while viewers post, are refused or are moderated', () => {
    const calls = [];
    const originals = ['log', 'info', 'warn', 'error', 'debug'].map((name) => [name, console[name]]);
    for (const [name] of originals) console[name] = (...args) => calls.push([name, args]);
    try {
      const room = new ViewerChatRoom(fakeHost());
      turnOnEverything(room);
      const posted = room.postMessage({ viewerId: viewer(1), name: 'Secret Name', text: 'secret words' }, 'secret-network', 1000).message;
      for (const attempt of [
        () => room.postMessage({ viewerId: viewer(1), text: 'secret words' }, 'secret-network', 1100),
        () => room.postMessage({ viewerId: 'bad', text: 'x' }, 'secret-network', 1100),
        () => room.postReaction({ viewerId: viewer(1), reaction: 'zzz' }, 'secret-network', 1100),
      ]) assert.throws(attempt);
      room.blockViewer(posted.id, 'network', 2000);
      room.removeMessage(posted.id);
      room.dispose();
    } finally {
      for (const [name, fn] of originals) console[name] = fn;
    }
    assert.deepEqual(calls, []);
  });
});


// ---------------------------------------------------------------------------
// The whole thing: HTTP routes and the studio connection
// ---------------------------------------------------------------------------

async function startWebServers() {
  const wss = new WebSocketServer({ port: 0 });
  setupSignalingServer(wss);
  if (!wss.address()) await new Promise((resolve) => wss.once('listening', resolve));
  const app = express();
  app.set('trust proxy', true);
  // Only the watch routes: their own body handling must stand on its own.
  app.use('/api/watch', watchRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return {
    wsUrl: `ws://127.0.0.1:${wss.address().port}`,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}

function waitFor(ws, type, predicate = () => true, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

function expectNone(ws, type, predicate = () => true, timeoutMs = 400) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); resolve(); }, timeoutMs);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(new Error(`Unexpected ${type}: ${JSON.stringify(message.payload).slice(0, 200)}`));
    }
    ws.on('message', onMessage);
  });
}

function sendMessage(ws, type, payload) { ws.send(JSON.stringify({ type, payload })); }

async function join(url, payload) {
  const ws = await connect(url);
  const joined = waitFor(ws, 'room-joined');
  sendMessage(ws, 'join-room', payload);
  const message = await joined;
  return { ws, joined: message, id: message.payload.participant.id };
}

async function studio(servers, label) {
  const created = createRoom(`${label} test`, 'Arnold Famini', { creatorIp: `${label}-${Date.now()}-${Math.random()}` });
  const state = getRooms().get(created.room.id);
  state.room.settings.greenRoomEnabled = false;
  const host = await join(servers.wsUrl, { roomId: created.room.id, name: 'Arnold Famini', role: 'host', hostToken: created.hostToken });
  const guest = await join(servers.wsUrl, { roomId: created.room.id, name: 'Maria', role: 'guest', joinSessionId: `${label}-guest` });
  return { room: created.room, state, watchId: state.watchId, host, guest, api: `${servers.baseUrl}/api/watch/${state.watchId}` };
}

let viewerCounter = 0;
const newViewer = () => `viewer-http-${String(++viewerCounter).padStart(8, '0')}`;
let networkCounter = 0;
const newNetwork = () => `198.51.100.${++networkCounter % 250}`;

async function post(api, path, body, { network = newNetwork(), contentType = 'application/json', raw = false } = {}) {
  const response = await fetch(`${api}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'X-Forwarded-For': network },
    body: raw ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function live(api, query = '') {
  const response = await fetch(`${api}/live${query}`);
  return { status: response.status, json: await response.json() };
}

const switchOn = (host, patch) => sendMessage(host.ws, 'viewer-chat-settings-update', patch);

describe('viewer chat over HTTP and the studio connection', () => {
  it('is all off by default: the page sees the switches off and hand-made requests are refused', async () => {
    const servers = await startWebServers();
    try {
      const { api, host, guest, state } = await studio(servers, 'vc-off');
      assert.deepEqual(host.joined.payload.viewerChat, { switches: { chat: false, reactions: false, questions: false }, blocks: [] });
      assert.equal(host.joined.payload.features.viewerChat, true);
      const answer = (await live(api)).json;
      assert.deepEqual(answer.switches, { chat: false, reactions: false, questions: false });
      const viewerId = newViewer();
      const chat = await post(api, 'chat', { viewerId, name: 'Ana', text: 'hello' });
      assert.equal(chat.status, 403);
      assert.equal(chat.json.code, 'CHAT_OFF');
      assert.equal((await post(api, 'questions', { viewerId, name: 'Ana', text: 'why?' })).json.code, 'QUESTIONS_OFF');
      assert.equal((await post(api, 'reactions', { viewerId, reaction: 'like' })).json.code, 'REACTIONS_OFF');
      assert.equal(state.chatMessages.size, 0);
      assert.equal(state.qaQuestions.size, 0);
      assert.equal(guest.joined.payload.viewerChat, undefined, 'a guest is never told the switches or the blocked names');
    } finally { await servers.close(); }
  });

  it('answers a missing broadcast and bad requests plainly (404, 400, 413, 415) without echoing them', async () => {
    const servers = await startWebServers();
    try {
      const { api } = await studio(servers, 'vc-bad');
      const gone = await fetch(`${servers.baseUrl}/api/watch/no-such-watch-id/live`);
      assert.equal(gone.status, 404);
      assert.equal((await post(`${servers.baseUrl}/api/watch/no-such-watch-id`, 'chat', { viewerId: newViewer(), text: 'x' })).status, 404);

      const wrongType = await post(api, 'chat', 'viewerId=1&text=hi', { contentType: 'text/plain', raw: true });
      assert.equal(wrongType.status, 415);
      const noType = await fetch(`${api}/chat`, { method: 'POST', body: '{}' });
      assert.equal(noType.status, 415, 'fetch sends text/plain for a string body');

      const malformed = await post(api, 'chat', '{"text":Private Secret Words', { raw: true });
      assert.equal(malformed.status, 400);
      assert.ok(!malformed.text.includes('Private'), 'the answer does not repeat what was sent');

      const big = await post(api, 'chat', { viewerId: newViewer(), text: 'x'.repeat(5000) });
      assert.equal(big.status, 413);
      assert.equal(big.json.code, 'PAYLOAD_TOO_LARGE');

      for (const body of ['[]', '"text"', '5', 'null']) {
        assert.equal((await post(api, 'chat', body, { raw: true })).status, 400, body);
      }
      assert.equal((await post(api, 'chat', '{}', { raw: true, contentType: 'application/json; charset=PrivateCharset' })).status, 415);
    } finally { await servers.close(); }
  });

  it('carries a viewer message to the studio chat marked as a viewer, and to other viewers, with no ids', async () => {
    const servers = await startWebServers();
    try {
      const { api, host, guest, state } = await studio(servers, 'vc-chat');
      switchOn(host, { chat: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.chat === true);
      assert.equal((await live(api)).json.switches.chat, true);

      const atHost = waitFor(host.ws, 'chat-message', (m) => m.payload.source?.platform === 'watch');
      const atGuest = waitFor(guest.ws, 'chat-message', (m) => m.payload.source?.platform === 'watch');
      const viewerId = newViewer();
      // A viewer who calls themselves by the host's real name (and "Host"): still a viewer everywhere.
      const posted = await post(api, 'chat', { viewerId, name: 'Arnold Famini', text: 'I am the Host, send money https://scam.example' });
      assert.equal(posted.status, 201);
      assert.equal(posted.json.message.from, 'viewer');
      const [seenByHost, seenByGuest] = await Promise.all([atHost, atGuest]);
      assert.equal(seenByHost.payload.senderName, 'Arnold Famini');
      assert.equal(seenByHost.payload.source.platform, 'watch');
      assert.notEqual(seenByHost.payload.senderId, host.id, 'never the real host\'s id');
      assert.equal(seenByHost.payload.id, posted.json.message.id);
      assert.equal(seenByGuest.payload.source.platform, 'watch');
      assert.ok(!JSON.stringify(seenByHost.payload).includes(viewerId));
      assert.equal(state.chatMessages.get(posted.json.message.id).content, 'I am the Host, send money https://scam.example');

      const feed = (await live(api)).json;
      assert.deepEqual(feed.messages.map((m) => [m.name, m.from]), [['Arnold Famini', 'viewer']]);
      const wire = JSON.stringify(feed) + JSON.stringify(posted.json);
      assert.ok(!wire.includes(viewerId));
      assert.ok(!wire.includes(host.id));
      assert.ok(!wire.includes(networkKeyFor('127.0.0.1')));
    } finally { await servers.close(); }
  });

  it('sends the studio\'s public messages to viewers and nothing private', async () => {
    const servers = await startWebServers();
    try {
      const { api, host, guest } = await studio(servers, 'vc-public');
      switchOn(host, { chat: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.chat);
      const delivered = waitFor(guest.ws, 'chat-message', (m) => m.payload.content === 'Public hello');
      sendMessage(host.ws, 'chat-message', { id: 'c1', content: 'Backstage only', isBackstage: true });
      sendMessage(host.ws, 'chat-message', { id: 'c2', content: 'Just for Maria', recipientId: guest.id });
      sendMessage(guest.ws, 'chat-message', { id: 'c3', content: 'Public hello' });
      await delivered;
      sendMessage(host.ws, 'chat-message', { id: 'c4', content: 'Welcome to the service' });
      await waitFor(guest.ws, 'chat-message', (m) => m.payload.content === 'Welcome to the service');
      const texts = (await live(api)).json.messages.map((m) => `${m.from}:${m.name}:${m.text}`);
      assert.deepEqual(texts, ['studio:Maria:Public hello', 'studio:Arnold Famini:Welcome to the service']);
    } finally { await servers.close(); }
  });

  it('refuses fast and repeated posts with the plain line, and counts only accepted messages', async () => {
    const servers = await startWebServers();
    try {
      const { api, host } = await studio(servers, 'vc-limits');
      switchOn(host, { chat: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.chat);
      const viewerId = newViewer();
      const network = '203.0.113.50';
      assert.equal((await post(api, 'chat', { viewerId, text: 'first line' }, { network })).status, 201);
      const dup = await post(api, 'chat', { viewerId, text: 'First   LINE' }, { network });
      assert.equal(dup.status, 409);
      assert.match(dup.json.error, /write something new/);
      const fast = await post(api, 'chat', { viewerId, text: 'second line' }, { network });
      assert.equal(fast.status, 429);
      assert.match(fast.json.error, /slow down/i);
      assert.ok(Number(fast.headers.get('retry-after')) >= 1);
      assert.equal(fast.json.code, 'RATE_LIMITED');
      assert.equal((await live(api)).json.messages.length, 1);
    } finally { await servers.close(); }
  });

  it('puts a question in the queue marked as from a viewer, for hosts only', async () => {
    const servers = await startWebServers();
    try {
      const { api, host, guest, state } = await studio(servers, 'vc-qa');
      switchOn(host, { questions: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.questions);
      const atHost = waitFor(host.ws, 'qa-question-updated');
      const quiet = expectNone(guest.ws, 'qa-question-updated');
      const posted = await post(api, 'questions', { viewerId: newViewer(), name: 'Rosa from Ohio', text: 'Will the sermon be shared? gago' });
      assert.equal(posted.status, 201);
      const question = (await atHost).payload;
      assert.equal(question.fromViewer, true);
      assert.equal(question.status, 'pending');
      assert.equal(question.authorName, 'Rosa from Ohio');
      assert.equal(question.content, 'Will the sermon be shared? ****');
      assert.equal(question.highlighted, false);
      await quiet;
      assert.equal(state.qaQuestions.size, 1);
    } finally { await servers.close(); }
  });

  it('shows reactions to hosts as counts only (studio preview, never names) and to viewers on the page', async () => {
    const servers = await startWebServers();
    try {
      const { api, host, guest } = await studio(servers, 'vc-react');
      switchOn(host, { reactions: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.reactions);
      const first = (await live(api)).json;
      const atHost = waitFor(host.ws, 'viewer-reactions');
      const quiet = expectNone(guest.ws, 'viewer-reactions');
      for (const reaction of ['love', 'love', 'clap']) {
        assert.equal((await post(api, 'reactions', { viewerId: newViewer(), reaction })).status, 200);
      }
      const counts = (await atHost).payload.counts;
      assert.deepEqual(counts, { love: 2, clap: 1 });
      await quiet;
      const next = (await live(api, `?after=${first.cursor}&epoch=${first.epoch}`)).json;
      assert.deepEqual(next.reactions, { love: 2, clap: 1 });
      assert.equal((await post(api, 'reactions', { viewerId: newViewer(), reaction: 'laugh' })).status, 400);
    } finally { await servers.close(); }
  });

  it('removes a viewer message from the studio, the on-screen chat list and every watch page', async () => {
    const servers = await startWebServers();
    try {
      const { api, host, guest, state } = await studio(servers, 'vc-remove');
      switchOn(host, { chat: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.chat);
      const posted = (await post(api, 'chat', { viewerId: newViewer(), name: 'Ana', text: 'something unwelcome' })).json.message;
      const first = (await live(api)).json;
      const gone = waitFor(guest.ws, 'chat-message-removed', (m) => m.payload.messageId === posted.id);
      sendMessage(host.ws, 'viewer-chat-remove', { messageId: posted.id });
      await gone;
      assert.equal(state.chatMessages.has(posted.id), false);
      assert.deepEqual((await live(api, `?after=${first.cursor}&epoch=${first.epoch}`)).json.removed, [posted.id]);
      assert.deepEqual((await live(api)).json.messages, []);
    } finally { await servers.close(); }
  });

  it('blocks a viewer or a whole network, lists them without ids, and lets the host unblock', async () => {
    const servers = await startWebServers();
    try {
      const { api, host, guest, state } = await studio(servers, 'vc-block');
      switchOn(host, { chat: true, reactions: true, questions: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.chat && m.payload.switches.questions);
      const troll = newViewer();
      const wifi = '192.0.2.77';
      const earlier = (await post(api, 'chat', { viewerId: troll, name: 'Troll', text: 'bad words' }, { network: wifi })).json.message;
      const friend = newViewer();
      assert.equal((await post(api, 'chat', { viewerId: friend, name: 'Neighbour', text: 'hello all' }, { network: wifi })).status, 201);

      const guestNoState = expectNone(guest.ws, 'viewer-chat-state');
      const stateAfterBlock = waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.blocks.length === 1);
      sendMessage(host.ws, 'viewer-chat-block', { messageId: earlier.id, scope: 'viewer' });
      const blocks = (await stateAfterBlock).payload.blocks;
      await guestNoState;
      assert.deepEqual(Object.keys(blocks[0]).sort(), ['blockedAt', 'id', 'name', 'scope']);
      assert.equal(blocks[0].name, 'Troll');
      assert.ok(!JSON.stringify(blocks).includes(troll));
      assert.equal(state.chatMessages.has(earlier.id), false, 'earlier message gone from the studio');

      for (const [path, body] of [['chat', { name: 'Troll', text: 'again' }], ['questions', { text: 'again?' }], ['reactions', { reaction: 'like' }]]) {
        const refused = await post(api, path, { viewerId: troll, ...body }, { network: wifi });
        assert.equal(refused.status, 403, path);
        assert.equal(refused.json.code, 'VIEWER_BLOCKED');
      }
      // Same Wi-Fi, another browser: fine while only the viewer is blocked.
      assert.equal((await post(api, 'reactions', { viewerId: newViewer(), reaction: 'like' }, { network: wifi })).status, 200);

      // Block everyone on that network (from the neighbour's message).
      const neighbourMessage = (await live(api)).json.messages.find((m) => m.name === 'Neighbour');
      const stateNetwork = waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.blocks.length === 2);
      sendMessage(host.ws, 'viewer-chat-block', { messageId: neighbourMessage.id, scope: 'network' });
      const both = (await stateNetwork).payload.blocks;
      assert.deepEqual(both.map((b) => b.scope).sort(), ['network', 'viewer']);
      const strangerSameWifi = await post(api, 'chat', { viewerId: newViewer(), text: 'a stranger on that Wi-Fi' }, { network: wifi });
      assert.equal(strangerSameWifi.status, 403);
      assert.equal((await post(api, 'chat', { viewerId: newViewer(), text: 'someone elsewhere' }, { network: '192.0.2.78' })).status, 201);
      assert.deepEqual((await live(api)).json.messages.map((m) => m.name), ['Viewer']);

      const stateUnblock = waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.blocks.length === 0);
      for (const block of both) sendMessage(host.ws, 'viewer-chat-unblock', { blockId: block.id });
      await stateUnblock;
      // Back in (a reaction, since a chat message from this viewer would still have to wait out the 2 second gap).
      assert.equal((await post(api, 'reactions', { viewerId: troll, reaction: 'like' }, { network: wifi })).status, 200);
    } finally { await servers.close(); }
  });

  it('lets only hosts and co-hosts change switches or moderate, and ignores junk', async () => {
    const servers = await startWebServers();
    try {
      const { api, host, guest, state } = await studio(servers, 'vc-guard');
      for (const [type, payload] of [['viewer-chat-settings-update', { chat: true }], ['viewer-chat-remove', { messageId: 'x' }], ['viewer-chat-block', { messageId: 'x', scope: 'network' }], ['viewer-chat-unblock', { blockId: 'x' }]]) {
        const refused = waitFor(guest.ws, 'error', (m) => m.payload.code === 'UNAUTHORIZED');
        sendMessage(guest.ws, type, payload);
        await refused;
      }
      assert.deepEqual(state.viewerChat.getSwitches(), { chat: false, reactions: false, questions: false });
      for (const payload of [{}, { chat: 'true' }, { bogus: true }]) {
        const invalid = waitFor(host.ws, 'error', (m) => m.payload.code === 'INVALID_PAYLOAD');
        sendMessage(host.ws, 'viewer-chat-settings-update', payload);
        await invalid;
      }
      for (const [type, payload] of [['viewer-chat-remove', { messageId: 5 }], ['viewer-chat-block', { scope: 'viewer' }], ['viewer-chat-block', { messageId: 'x', scope: 'everyone' }]]) {
        const error = waitFor(host.ws, 'error');
        sendMessage(host.ws, type, payload);
        assert.ok(['INVALID_PAYLOAD', 'VIEWER_NOT_FOUND', 'VALIDATION_ERROR'].includes((await error).payload.code));
      }
      const missing = waitFor(host.ws, 'error', (m) => m.payload.code === 'NOT_FOUND');
      sendMessage(host.ws, 'viewer-chat-unblock', { blockId: 'nope' });
      await missing;
      assert.equal((await live(api)).json.switches.chat, false);
    } finally { await servers.close(); }
  });

  it('keeps the switches for the life of the room when the host reloads, and a co-host gets them too', async () => {
    const servers = await startWebServers();
    try {
      const { room, host, state } = await studio(servers, 'vc-reload');
      switchOn(host, { chat: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.chat);
      host.ws.terminate();
      const again = await join(servers.wsUrl, { roomId: room.id, name: 'Arnold Famini', role: 'host', hostToken: state.hostToken });
      assert.deepEqual(again.joined.payload.viewerChat.switches, { chat: true, reactions: false, questions: false });
    } finally { await servers.close(); }
  });

  it('writes nothing about viewers to the server log', async () => {
    const calls = [];
    const originals = ['log', 'info', 'warn', 'error', 'debug'].map((name) => [name, console[name]]);
    const servers = await startWebServers();
    try {
      const { api, host } = await studio(servers, 'vc-log');
      switchOn(host, { chat: true, reactions: true, questions: true });
      await waitFor(host.ws, 'viewer-chat-state', (m) => m.payload.switches.chat && m.payload.switches.questions);
      for (const name of ['log', 'info', 'warn', 'error', 'debug']) console[name] = (...args) => calls.push(args.join(' '));
      const viewerId = newViewer();
      await post(api, 'chat', { viewerId, name: 'Secret Name', text: 'secret words' }, { network: '203.0.113.200' });
      await post(api, 'chat', { viewerId, name: 'Secret Name', text: 'secret words' }, { network: '203.0.113.200' });
      await post(api, 'chat', '{"broken":Secret', { raw: true, network: '203.0.113.200' });
      await post(api, 'questions', { viewerId, name: 'Secret Name', text: 'a secret question' }, { network: '203.0.113.200' });
      await post(api, 'reactions', { viewerId, reaction: 'love' }, { network: '203.0.113.200' });
      await live(api, '?after=zzz');
    } finally {
      for (const [name, fn] of originals) console[name] = fn;
      await servers.close();
    }
    const logged = calls.join('\n');
    for (const secret of ['Secret', 'secret', 'viewer-http', '203.0.113']) assert.ok(!logged.includes(secret), `the log never mentions ${secret}`);
  });
});
