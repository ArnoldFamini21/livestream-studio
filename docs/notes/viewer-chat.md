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
  When the host switches chat on, the watch page list starts empty: nothing
  written before (including public chat lines written in the studio while chat
  was off) is ever shown to viewers. The studio chat itself keeps everything.
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
  host sees them float on the studio preview. They work with chat off: reactions
  only is a valid setup, and viewers still see each other's reactions float.
- **Questions.** "Ask a question" puts the question in the existing Q&A queue,
  marked from a viewer, with the viewer's name. A viewer may have 3 questions
  waiting, one network (one Wi-Fi or one IPv6 /64) 15 waiting, and the room 200
  open viewer questions at most. Only questions still waiting (pending or
  approved) count: when the host answers or dismisses them there is room again.
  Everyone on one church Wi-Fi shares the 15: while 15 of their questions wait,
  the next person there reads "Many questions from your connection are waiting
  for the host" until the host answers or dismisses some.

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
| Questions waiting per viewer, per network, open in the room | 3, 15, 200 |
| Big answers (more than 20 lines: a page with no place yet, or one asking from far back) per network | 120 per minute (a congregation opening the page together fits; a script does not). Past that, the newest 20 lines as a fresh list, not an error |
| Lines in any other answer | 20 at most |
| Reads per address, all kinds | 2,400 per minute (about 160 devices asking every 4 seconds) |

A refused attempt costs nothing, so waiting is always enough. The viewer reads
"Please slow down. You can send again in N seconds." when it is their own limit,
and "Chat is busy right now. Please try again in N seconds." when it is the
network's or the room's limit (not their doing).

One address is one budget for a whole congregation: 30 chat messages and
questions per 30 seconds shared by everyone behind it, so about one message per
second in total. At a "type Amen" moment on a big church Wi-Fi some people will
read "Chat is busy" for a few seconds. That follows the numbers in the brief; it
is a trade between a crowd on one connection and one person using many viewer
ids. Chat and questions share that budget.

A "network" is the request address for IPv4, and the first 64 bits (the /64) for
IPv6, because one home or phone connection owns the whole /64 and can change
address for every message. An IPv4 address written as IPv6 (::ffff:1.2.3.4)
counts as the IPv4 address. The poll vote uses the same key.

The word filter is a short built-in list in English and Tagalog, matched on whole
words after folding case, repeated letters, accents, look-alike characters and
zero-width joiners (sh1t, fuuuck, a joiner hidden between letters). Dots and
spaces between letters (f.u.c.k, f u c k) and swapped letters (fvck) are not
folded: it is a speed bump, not a promise. A match is masked with asterisks, not
dropped. It leaves out words with an ordinary or biblical use, and words that
are ordinary in a Philippine church (leche flan, a Latin "cum", Lady Gaga, "mf"
in music). Two slurs stay on the list even though they have innocent uses ("a
chink in the armor", the name Kike): a wrongly masked word costs a little, a slur
shown on air costs more. The host's remove and block are the real protection.

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
- **Block viewer** (message menu, and on a viewer's question in the Q&A panel, so
  a viewer who only asks questions can be blocked too) asks in plain words: block
  this viewer only (this browser; it says a private window or cleared browsing
  data gets round it), or this viewer and everyone on the same network (it says
  this also blocks other people on the same Wi-Fi, and sometimes other people on
  the same mobile data network, because phone carriers often share one address
  among many customers). The viewer's earlier messages and
  waiting questions are removed, and later messages, reactions and questions are
  refused with "You can no longer post in this broadcast." The list of blocked
  viewers (name, and whether the whole network) has Unblock. Removed messages do
  not come back.
- **A warning when viewers would go straight on air.** If viewer chat is on and
  Chat on screen is on with "All comments", a note under the switches says a
  viewer's message will appear on the broadcast as soon as it is sent, with a
  button "Show only approved comments". The switches panel and the watch page
  hint ("may be shown on the broadcast") say the same. Nothing is changed for the
  host: this follows the host's own existing choice.
- **Who sees the Public chat.** Under the Public chat box a host or co-host reads
  "Visible to everyone in the studio and on the watch page" while viewer chat is
  on. Guests and the pop-out chat read "...and on the watch page if viewer chat
  is on" (they are not told the switches).
- Viewer reactions float on the studio preview only. They are not part of the
  broadcast picture: the studio's own reactions are drawn into the broadcast, and
  these deliberately are not.
- Viewer messages sit in the studio chat's public list and in "Social comments"
  with the other outside comments.

## Load on the server (one small free instance)

Viewers do not hold a connection. Each watch page asks `GET /api/watch/:id/live`
every 4 seconds (15 seconds or more while the tab is hidden) while any switch is
on, and **every 20 seconds while all three are off** (the default), because
there is nothing to show; a page then notices a switch within about 20 seconds.
With nothing new the answer is about 160 bytes of JSON and costs one lookup and a
counter. The watch page's poll card (the existing live polls) also asks
`/poll` every 5 seconds, so both are counted here.

| Viewers | Switches off (20 s + poll card 5 s) | Any switch on (4 s + poll card 5 s) |
| --- | --- | --- |
| 100 | about 25 requests per second | about 45 per second |
| 300 | about 75 per second | about 135 per second |
| 500 | about 125 per second | about 225 per second |

- The server measures its own request rate (only small answers, not big ones) and
  tells pages to ask less often (6 seconds above 40 per second, 10 above 100, 15
  above 250), so the chat load levels off even for several thousand viewers. A
  page that is told 15 seconds sees chat 15 seconds late.
- A page with no place yet, or one that asks from far back, gets a big answer: up
  to 100 lines, about 40 kB when the lines are long and about 9 kB for 100 short
  lines. One network gets 120 big answers a minute, however it asks. Past that it
  gets the newest 20 lines as a fresh list, so a real page still works. Every
  other answer carries at most 20 lines. So the most one hostile address can pull
  is 120 big answers plus 2,400 small ones a minute: about 5 MB plus about 20 MB a
  minute (about 1.5 GB an hour) while chat is on and the list is full of long
  lines, and almost nothing when the chat is quiet or off. For scale, that is
  about what one extra person watching the video uses (the video itself comes
  from the media server, not from this one).
- Memory per room is bounded: about 250 lines at most 340 characters of text and a
  40 character name (under 150 kB), plus the identities (a few hundred kB at the
  3,000 limit). Nothing is written to disk.
- The per-address safety net is 2,400 chat reads and 1,500 posts per minute. More
  than about 160 pages asking every 4 seconds behind one address would reach it
  (fewer once the server asks for slower), and see some answers refused until the
  next minute. The poll card's own net (1,200 a minute, about 100 pages at 5
  seconds) is lower still and was there before this feature. One hostile address
  can still add up to 40 ordinary asks a second to the room's request meter; two or
  more can push the hint to 6 seconds for everyone. That only slows chat, it does
  not stop it.
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
  marked everywhere; the server log holds none of the text, names or ids. After
  the review it also checks: a studio line written before chat was switched on is
  never shown to viewers; the warning (and its one-click button) when viewer
  messages would go straight on air; a viewer who only asks questions is blocked
  from the Q&A panel, their question leaves the queue and other viewers are
  unaffected; with chat off and reactions on, the other watch page still sees a
  reaction float. Screens were looked at at 1440x900 and 390x844.
- After the review the unit tests also cover: the feed starting empty when chat is
  switched on, reactions with chat off, the question caps (a host dismissing all
  questions frees the room), blocking from a question id, IPv6 /64 and
  IPv4-mapped addresses, the big-answer budget (a page with no place and a place
  far back alike; past it, the newest 20 lines as a fresh list), big answers not
  slowing every page down, the room limit of 200 questions counted by the real
  studio (answering or dismissing frees room), the 20 second idle hint, the
  "Chat is busy" wording, a masked name, the filter with zero-width joiners and
  with the words that were taken off the list, and a guest not being sent the
  switches.

## What was not verified

- A co-host's browser (the co-host uses the same messages as the host; the server
  tests cover the permission check).
- A guest on stage seeing viewer messages in their chat panel (the same message
  and component as other outside comments; not opened in a browser).
- Real traffic: many viewers, a busy congregation behind one address, a slow phone
  connection, or the load numbers above.
- The pop-out chat window: it shows viewer messages with the Viewer mark but has
  no Remove or Block (use the studio chat panel). It never styles a viewer's
  message as the host's own, even for the same name.
- The IPv6 grouping with a real address behind Render's proxy: it is tested with
  address strings only, not with real IPv6 traffic.
- The 20 second wait while all switches are off, with a real host turning a switch
  on mid-service: pages follow within about 20 seconds (the browser check waited
  for that).
- A viewer on a very old browser, a screen reader pass on the watch page, and
  what happens when the server restarts in the middle of a service (the switches,
  blocks and chat start over; pages notice at their next ask and start fresh).
- The word filter against real text from a real congregation. It is small on
  purpose.

## Known limits that were left as they are

- After "block this viewer only" the message is gone, so the host cannot widen
  the block to the whole network from that message; they wait for the next one
  (or block the network the first time).
- A flood of more than 3,000 different accepted viewer ids can push out the
  record that traces an old message to its writer (then Block says the viewer can
  no longer be found; block from their next message). Viewer messages also share
  the studio's 500 line chat history.
- A server restart restores rooms without the viewer chat: switches are off
  (safe) and the blocked list starts empty. The switches panel says so.
- Dots between letters (f.u.c.k) and swapped letters (fvck) pass the filter.
- Publishing this restarts the signaling server, which ends any studio that is open
  at that moment.
