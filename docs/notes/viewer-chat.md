# Viewer chat, reactions and questions on the watch page (P1.7)

## What it does

People on the public watch page can write in a chat, send a reaction, and ask
the host a question. This is the first time anonymous members of the public can
write into a live church broadcast, so the host decides, and the server (never
the watch page) enforces every rule.

- **Three switches, all off.** In the studio chat panel, under the on-screen chat
  controls: "Viewers can chat", "Viewers can react", "Viewers can ask
  questions". Hosts and co-hosts can change them. While a switch is off the
  watch page hides that part, and the server refuses a hand-made request for it
  (403 with a plain line). They are kept in memory for the life of the room, so
  they survive a reload of the studio or the watch page but not a restart of the
  signaling server (the same as the on-screen chat settings and the blocks).
- **Chat.** A list (about the last 100 messages, newest at the bottom) and an
  input. A viewer picks a name once (kept in their browser; the registration name
  is the default). Name 40 characters, message 300. Everything is plain text:
  trimmed, control and direction-changing characters removed, never read as HTML,
  links are not clickable. Too long is refused with a plain line, not cut.
- **What viewers see from the studio.** Only the studio's own public messages,
  by one pure rule (`isWatchPublicStudioMessage` in `shared/src/viewerChat.ts`):
  not backstage, not a private message, not from someone still in the green room
  (the on-screen chat's rule, `isPublicChatCandidate`), and written in the studio
  itself. Comments imported from YouTube or Facebook are not repeated to this
  audience. Each line carries a tag set by the server: "Studio" or "Viewer".
- **Reactions.** Like, love, clap and wow (the studio's set without the laughing
  face). Counts only, never names. Viewers see them float on the watch page. The
  host sees them float on the studio preview.
- **Questions.** "Ask a question" puts the question in the existing Q&A queue,
  marked from a viewer, with the viewer's name. A viewer may have 3 questions
  waiting; the room holds 200 viewer questions at most.

## The numbers

| What | Limit |
| --- | --- |
| Per viewer id, chat and questions | 1 per 2 seconds, 5 per 30 seconds |
| Per network (one church Wi-Fi), chat and questions | 30 per 30 seconds |
| Whole room, chat and questions | 120 per 30 seconds |
| Reactions per viewer | 1 per 0.4 seconds, 20 per 30 seconds |
| Reactions per network, per room | 300 and 600 per 30 seconds |
| The same message twice in a row | refused (case, spaces and end punctuation ignored) |
| Request body | 2 kB; 415 for another content type, 400 for bad JSON, 413 for too big |
| Messages kept per room | about the last 200 from viewers (250 lines with the studio's) |
| Removals kept for pages that were away | 200; reactions 120 |
| Viewers remembered per room (to trace a message back) | 3,000, oldest first |

A refused attempt costs nothing, so waiting is always enough. The viewer reads
"Please slow down. You can send again in N seconds."

The word filter is a short built-in list in English and Tagalog, matched on whole
words after folding case, repeated letters, accents and look-alike characters
(f.u.c.k, sh1t, fuuuck). A match is masked with asterisks, not dropped. It leaves
out words with an ordinary or biblical use. It is a speed bump: the host's remove
and block are the real protection.

## Who is who (privacy)

- The viewer id is made in the browser. The network key is an HMAC of the request
  address with a random salt made at each server start. The address is never
  stored or logged. Neither is ever sent to another viewer or to the studio: the
  studio gets an opaque handle inside the chat sender id.
- Logs hold no message text, names, addresses, ids or keys. The browser check reads
  the server log after a full run and looks for them.
- The watch page never learns who moderated.
- The poll vote that already tells viewers apart now uses the same network key.

## What the host sees

- **A viewer's message in the studio chat** has a teal "Viewer" mark and the
  words "Watch page", whatever name the viewer typed. A viewer who calls
  themselves "Host" or uses the host's real name is still marked.
- **On the on-screen chat** it shows as "Viewer · name", with its own colour. The
  existing "All comments / Approved only" choice applies: in "Approved only" a
  viewer message appears only after the host stars it or shows it on stage.
  Nothing else reaches the broadcast picture.
- **A viewer's question** shows as "name (viewer)" in the Q&A panel, on the
  preview and on the broadcast when highlighted.
- **Remove** (message menu): the message goes from the studio chat, the on-screen
  chat, the stage (if it was featured) and every watch page.
- **Block viewer** (message menu) asks in plain words: block this viewer only (this
  browser), or this viewer and everyone on the same network (it says this also
  blocks other people on the same Wi-Fi). The viewer's earlier messages and
  waiting questions are removed, and later messages, reactions and questions are
  refused with "You can no longer post in this broadcast." The list of blocked
  viewers (name, and whether the whole network) has Unblock. Removed messages do
  not come back.
- Viewer reactions float on the studio preview only. They are not part of the
  broadcast picture: the studio's own reactions are drawn into the broadcast, and
  these deliberately are not.
- Viewer messages sit in the studio chat's public list and in "Social comments"
  with the other outside comments.

## Load on the server (one small free instance)

Viewers do not hold a connection. Each watch page asks `GET /api/watch/:id/live`
every 4 seconds (15 seconds or more while the tab is hidden). With nothing new the
answer is about 250 bytes of JSON and costs one lookup and a counter.

- 100 viewers: about 25 requests per second.
- 500 viewers: about 125 per second at 4 seconds. The server measures its own
  request rate and tells pages to ask less often (6 seconds above 40 per second,
  10 above 100, 15 above 250), so the load levels off near 100 to 250 per second
  even for several thousand viewers. A page that is told 15 seconds sees chat 15
  seconds late.
- Memory per room is bounded: about 250 lines at most 340 characters of text and a
  40 character name (under 150 kB), plus the identities (a few hundred kB at the
  3,000 limit). Nothing is written to disk.
- The per-address safety net is 6,000 chat reads and 1,500 posts per minute. A
  congregation of more than about 400 pages behind one address would reach it and
  see some answers refused until the next minute.
- A chat message is one small write. At most 120 chat messages and questions per
  30 seconds are accepted for the whole room.

None of this was load tested. The numbers come from the limits in the code, not
from a measurement with real traffic.

## What was verified

- Unit tests: `shared/test/viewer-chat.test.mjs` (limits, filter, sanitising,
  feed and cursor, which studio messages are public), `server/test/viewer-chat.test.mjs`
  (routes, switches, blocks, removal, limits, privacy of the answers, 415/400/413),
  `client/test/watchViewerChat.test.ts` (the page's list and cursor, names,
  reactions, the "Viewer" marking on the on-screen chat, featured comment and Q&A).
- A real Chromium check (`output/viewer-chat-check/check.mjs`, built app under the
  production security policy, one host and two watch pages): everything off at
  first and refused by hand; 415, 400 and 413; chat both ways; a studio message
  reaches viewers while a backstage one does not; the on-screen chat with a viewer
  message and the "Approved only" choice; the slow-down line and the repeat
  refusal; the filter; remove; block one viewer and block a whole network, then
  Unblock; reactions; a question in the queue; each switch off hides the control
  and the server refuses a hand-made request; a viewer named like the host is
  marked everywhere; the server log holds none of the text, names or ids. Screens
  were looked at at 1440x900 and 390x844.

## What was not verified

- A co-host's browser (the co-host uses the same messages as the host; the server
  tests cover the permission check).
- A guest on stage seeing viewer messages in their chat panel (the same message
  and component as other outside comments; not opened in a browser).
- Real traffic: many viewers, a busy congregation behind one address, a slow phone
  connection, or the load numbers above.
- The pop-out chat window: it shows viewer messages with the Viewer mark but has
  no Remove or Block (use the studio chat panel).
- A viewer on a very old browser, a screen reader pass on the watch page, and
  what happens when the server restarts in the middle of a service (the switches,
  blocks and chat start over; pages notice at their next ask and start fresh).
- The word filter against real text from a real congregation. It is small on
  purpose.
- Publishing this restarts the signaling server, which ends any studio that is open
  at that moment.
