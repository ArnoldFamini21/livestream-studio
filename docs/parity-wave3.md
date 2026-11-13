# StreamYard / Riverside parity — wave 3

## Backlog checklist

Unchecked items are not qualified or shipped. Partial work is recorded below;
unit coverage alone does not complete a browser acceptance criterion.

- [x] **P0.1** Browser end-to-end qualification in Linux CI (PR #352 merged)
- [ ] **P0.2** Three-participant recording soak (20+ minutes, reconnect, transfer, packet timing)
- [ ] **P0.3** Free production error grouping, release tags, no PII
- [x] **P1.4** Configurable multistream destinations, health and presets (PR #360, verified locally; see below)
- [ ] **P1.5** Simultaneous landscape and portrait streaming
- [x] **P1.6** Merged on-screen chat overlay, questions and export (PR #361, verified locally; see below)
- [ ] **P1.7** Moderated viewer chat, reactions and Q&A
- [ ] **P1.8** Signed watch-page registration and HLS authorization
- [ ] **P1.9** Audience call-ins through the green room
- [ ] **P1.10** Reusable studios, synced scenes and scene folders
- [ ] **P1.11** Automatic intros/outros, banner folders, movable overlays and QR widget
- [ ] **P1.12** Stage tile controls, backstage reordering and people audio controls
- [ ] **P1.13** Private mentions, shared notes and teleprompter collaboration
- [ ] **P1.14** Phone/desktop secondary camera seats and ISO recording
- [ ] **P1.15** Camera controls, smoothing and same-origin MediaPipe assets
- [x] **P1.16** Screen-share mix volume and music transport controls (accepted limit: the slider sets the level for viewers and the recording; the host's own speakers play the host's own shared tab straight from the browser)
- [x] **P1.17** Private test stream before public broadcast
- [ ] **P1.18** Scheduled prerecorded premieres within free-tier limits
- [ ] **P1.19** Viewer captions and CC control
- [ ] **P2.20** Non-destructive transcript/timeline editor and export
- [ ] **P2.21** Offline audio enhancement and loudness normalization
- [ ] **P2.22** Marker-driven smart clips, face crop and fast export
- [ ] **P2.23** Multilingual transcription and custom dictionary
- [ ] **P2.24** YouTube publishing and podcast RSS
- [ ] **P3.25** Public-domain scripture lower thirds and verse queue
- [ ] **P3.26** Lyrics/hymn slides and remote advance
- [ ] **P3.27** Ministry service scene packs and private prayer requests
- [ ] **P4.28** Incremental StudioRoom/signaling extraction alongside feature changes
- [ ] **P4.29** Stable pinned transcription dependencies
- [ ] **P4.30** Account verification, Google sign-in, deletion and email env declarations
- [x] **P4.31** Root Dockerfile/.dockerignore trigger media deployment

## Qualification plan — 2026-11-08

Baseline: `f00242de` (PR #351). Production deployment of that baseline succeeded.

The first change groups P0.1 and P0.2 because the short browser checks and long
recording rehearsal share real browser startup, fake-device, studio admission,
local CSP hosting and artifact handling. Production ownership, TURN admission,
green-room privacy and HMAC authorization remain unchanged.

1. Replace machine-specific ad hoc browser scripts with a portable suite and
   Linux CI job. Exercise host/guest admission, stage transitions, departure,
   watch-page voting, OPFS recording, layouts, portrait, return and talkback.
2. Reuse those fixtures for a three-seat recording soak with guest reconnect,
   completed peer transfers and measured encoded packet integrity.
3. Inspect screenshots at 1000×625, 1440×900 and a 390-pixel phone viewport.
4. Run all workspace typechecks/tests, deployment-script tests and builds;
   report exact totals, artifacts, bundle differences and remaining limits.
5. Merge only after local gates and Linux CI succeed, then verify deployed
   service commits and the static release before starting the next item.

No new paid service or hosting-setting change is planned. Synthetic devices
cannot establish real-camera quality, cross-continent connectivity, TURN-only
networks, mobile browser support or a public broadcast's reliability.

## Qualification evidence (in progress)

- All four workspace typechecks and the root build pass. The build emits no
  `.mjs` assets. The browser harness adds a development-only Apache-2.0
  Playwright dependency; it changes no shipped client code or bundle size.
- Local unit gates: client **1,412 passed**; server **261 passed, 2 skipped**
  (PostgreSQL integration requires a database); media server **291 passed**;
  shared **22 passed**; scripts **32 passed**. Total: **2,018 passed, 2 skipped**.
- The short real-Chrome suite passed **9 scenarios plus its parent test** in
  85.8 seconds with zero uncaught application errors or CSP violations.
  Explicit Leave removed the guest in **869 ms**; tab close in **8,397 ms**.
  Program, host ISO/audio and guest ISO/audio all committed non-empty OPFS
  media in the 30-second take.
- Screenshots were inspected at **1440×900**, **1000×625** and **390×844**.
  The custom layout reserves its empty left content slot as designed. The
  initial guest phone screenshot preceded the remote video's first painted
  frame after a responsive remount. Follow-up diagnostics show both cameras
  playing. Playback assertions now track each video element's own clock and
  require advancing, nonblack frames after admission, talkback, recording and
  phone resize. No production video-lifecycle change was needed.
- The long recording runner exercises real peer transfer with separate browser
  profiles and a native OPFS directory standing in for the directory picker.
  Short reconnect rehearsals are development checks only; the 20-minute result
  is still pending. Concurrent builds/tests caused filesystem contention, so
  timing qualification runs exclusively, without other builds or browsers.
- Linux CI is a required merge gate. The sustained soak remains incomplete;
  short runs and successful reconnect alone do not qualify recording integrity.

Evidence is generated under `output/e2e` and `output/recording-soak` on X9 Pro;
CI publishes only screenshots, accessibility snapshots, JSON evidence and logs,
not browser profiles or recording payloads.

## Canvas background (owner request, PR #357)

The host sets a canvas colour or picture from the Background button beside the
layout controls (host only; co-hosts and guests paint the host's). Colours,
gradients and https URLs ride studio branding as before. Pictures are
normalized in the browser to 1920 px / 400 KiB, uploaded to the existing
authorized `/api/rooms/:id/stage-images` route with the stage upload token,
and branding carries only `{ type: 'image', value: '', imageId }`
(about 400 bytes, far below the unchanged 64 KiB WebSocket cap). The server
relays an id only if the studio holds it and it is at most 512 KiB, never
evicts the current background, and drops the id when restoring a snapshot
after a restart; the host's browser keeps the picture and re-uploads it on
every join. Guests and co-hosts fetch it with their stage read token (waiting
guests cannot), so the DOM stage, the phone stage and the program compositor
(stream, program recording, program return) all paint it. Drawing lives in
`client/src/utils/compositorBackground.ts` with unit coverage.

Evidence (2026-11-08, local, real Chrome, production CSP): host colour
`#c0392b` appeared in a backstage guest's program return with no upload; a
2.5 MB PNG uploaded as a 316,620-byte WebP (201), the program return showed it
(edge pixels blue/yellow), the staged guest's canvas painted it, and both host
and guest reloads kept it (the host re-uploaded once). Largest branding frame:
408 bytes. Screenshots at 1440×900, 1000×625 and 390×844 were inspected; no
page errors or CSP violations. Not verified: a real broadcast to an RTMP
destination, a recorded file's pixels, and a server restart with a live host.
Logos were still sent inline at this point; see the logo section below.

## Logo sharing through the image store (fix for the 47 KB logo disconnect)

Bug: the host's logo travelled inline in the `studio-branding-updated` message,
but the signaling socket closes any message over 64 KiB (code 1009). A logo of
roughly 47 KB to 450 KB disconnected the host, who reconnected, resent it and
was cut off again, even after a reload; a bigger one was silently never shared.

What it does now:

- The logo is scaled in the browser to at most 1024 px on its long edge
  (transparency kept; a small file that already fits is uploaded as it is),
  then uploaded once as a stage image of kind `logo` (header
  `x-stage-image-kind`, cap 768 KiB). Branding carries only `logoImageId`.
  A file the browser cannot decode, or one that cannot be made small enough,
  is refused with a visible message in the Brand panel.
- Access: every participant, the green room included, gets a
  `brandingReadToken` that opens logo images only. Slides, stage pictures and
  backgrounds still need the stage read token, so the green room gains nothing
  else. Co-hosts, stage guests, the waiting room (show-logo on), the backstage
  Live program monitor and a co-host's compositor all load the logo by id.
- Saved state (localStorage, scenes, brand kits and their cloud copy) still
  holds data-URL logos. When one is restored or applied it is uploaded once per
  join (same picture, no second upload) and shared by id. An https logo URL is
  sent as before. Non-host participants paint the logo with default
  placement/size/opacity (placement is not part of branding).
- Defence in depth: `useSignaling.send()` measures the encoded message in bytes
  and refuses anything above `SIGNALING_SAFE_MESSAGE_BYTES` (56 KiB, in
  `shared`, below the 64 KiB server cap `SIGNALING_MAX_PAYLOAD_BYTES`), reports
  once per message type through client error reporting and does not send it.
  The server accepts inline branding pictures only up to
  `MAX_INLINE_BRANDING_DATA_URL_LENGTH` (16,000 characters, for tiny old
  logos); a longer one is never stored or relayed and gets an error message
  (`BRANDING_IMAGE_TOO_LARGE`), with the rest of the branding applied.
- Upload robustness (logo and background pictures): 15 s limit per attempt, up
  to 3 attempts with a 1 s then 2 s pause, a visible "Could not share this
  logo ... Retry" state, and after the attempts fail the branding goes out
  without the picture, so colour and waiting-room text are never held back
  for good.
- No flash on air: the compositor keeps the previous logo and background until
  the new picture has loaded. Logos are loaded through the same CORS-safe path
  as backgrounds (object URL from an authorized fetch), so the canvas is never
  tainted.

Code: `client/src/utils/{logoImage,logoSync,pictureUpload,signalingSendGuard}.ts`,
`client/src/hooks/{useStudioBrandingShare,useSharedPictureUpload,useLoadedSharedImage}.ts`;
server: `signaling.ts` (`kind: 'logo'`, `brandingReadToken`, inline cap).

Verification (local, real Chromium, production CSP, e2e harness):

- Before (origin/main build): a 146,749-byte PNG logo made the host socket
  open and close 19 times in 20 s and "Reconnecting to studio server" stayed
  visible.
- After: the same logo and a 1.5 MB (2400x1600) one: the host socket never
  closed; a stage guest, a green-room guest (waiting room, show-logo on), a
  backstage guest's Live program monitor and a co-host all showed the logo (the
  big one scaled to 1024x683); after a host reload the logo was back with no
  disconnect; removing it removed it for everyone. No page errors or CSP
  violations. Screenshots were inspected.
- Tests: client 1,535, server 279 (2 skipped), media-server 293, shared 48,
  scripts 45, e2e 13, all passing; new unit tests (payload builder, send guard,
  scale decision, upload helper with fake fetch and timers) and server tests
  (id accepted and relayed, inline cap error with the socket still open, who
  can and cannot read a logo).

Not verified: a real RTMP broadcast or recorded file containing the logo,
a server restart while a host is live (the logo is re-uploaded on the next join
by design), SVG/GIF logos in browsers other than Chromium, and a real phone.

## P1.4 — more stream destinations (PR #360)

A broadcast can now send to up to **8** destinations (was 3). The client cap is
`MAX_ENABLED_DESTINATIONS` in `client/src/utils/streamDestinations.ts` (the
Go Live handler in StudioRoom no longer hard-codes 3). The media server cap is
`RTMP_MAX_DESTINATIONS` (1 to 8, default 8, `getMaxRtmpDestinations` in
`media-server/src/rtmp.ts`), reported as `capabilities.liveRelay.maxDestinations`
on `/health`. With `RTMP_ENCODE_ONCE=false` (one encode per destination) the cap
stays 3. Per-destination reconnect and backpressure are unchanged.

Presets: YouTube, Facebook, Twitch, **Kick**, LinkedIn, **X**, **TikTok**,
Instagram, **Vimeo** and Custom RTMP, each with a server URL template, help on
where to find the URL, setup steps and any account/plan requirement. LinkedIn
and TikTok issue a URL per event, so they have no prefilled URL; Kick, X,
Instagram and Vimeo are prefilled but editable. TikTok is portrait-first.

Stream Health lists each enabled destination (Connected / Connecting /
Reconnecting / Failed, what the server sends it, and any server warning) and
the total upload to destinations in Mbps and GB per hour
(`client/src/utils/destinationHealth.ts`, `DestinationHealthList.tsx`). Before
going live the panel estimates the server upload (destinations × preset
bitrate) and points at Render's bandwidth usage.

Evidence (2026-11-08, local, real Chrome, production CSP, real signaling and
media servers, encode-once): **8 local RTMP listeners** (and an earlier 5-listener
run) all reached Connected in about 5.3 s with
`browser H.264 copied (1920x1080@30), audio to AAC`. Killing listener 3 mid-stream
showed Reconnecting, then Connecting, then Connected again 11.7 s later (its
listener was restarted after 5.1 s, the first retry hit the closed port). The
other seven stayed Connected throughout and each received byte-identical files
(6,055,434 bytes, 1,262 video packets, 43.75 s, largest video gap 74 ms, no
backwards timestamps); listener 3 received 15.4 s, then 17.6 s after reconnecting.
Per copy-only push: about 13 MB memory footprint; a 4.7 Mbps push used about 5%
of an Apple-silicon core (mostly network I/O). Screenshots at 1440×900, 1000×625
and 390×844 inspected; no page errors, CSP violations or horizontal overflow.

Not verified: real platform ingests (preset URLs come from the platforms'
public setup pages and should be checked with a private test), RTMPS to Kick,
X, Vimeo or TikTok, and whether a Render free (0.1 CPU) instance keeps up with
eight 4.7 Mbps pushes. Watch Server Speed and per-destination warnings, and
lower `RTMP_MAX_DESTINATIONS` if it falls behind.

## P1.6 — on-screen chat overlay, questions, shown comments, export (PR #361)

"Chat on screen" (chat panel, hosts and co-hosts) puts the latest public
comments on the program: the studio's public chat and imported YouTube/Facebook
comments (`source` is `studio | youtube | facebook`, so watch-page chat can be
added as another value). Settings: on/off, size S/M/L, layout regular/tall/wide,
side left/right (bottom-anchored), mode `all` (default) or `approved` (starred or
shown-on-screen), pause, and hide one comment (message actions).

- **One layout, two renderers.** `layoutChatOverlay` (`client/src/utils/chatOverlayLayout.ts`)
  turns comments + settings + canvas size into rectangles and text lines in output
  pixels (1920x1080 and 1080x1920 scale from the 1080 short side). The stage preview
  (`ChatOverlayPreview`, an SVG with the canvas as viewBox) and the compositor
  (`drawChatOverlay` in `useCompositor`) only replay those primitives. Text is measured
  and wrapped only when comments, settings, canvas, bottom inset or fonts change
  (`createChatOverlayLayoutCache`); the 30 fps loop draws a cached layout.
- **Settings sync.** `chat-overlay-update` (a patch) is validated by the server
  (`normalizeChatOverlayPatch`), limited to admitted hosts/co-hosts, rate-limited
  (`CHAT_OVERLAY_RATE_LIMIT_MAX` per 10 s) and answered with the full
  `chat-overlay-updated` to admitted operators only. `room-joined` carries the state
  to operators and advertises `features.chatOverlay`. The client uses the new messages
  only when that flag is present; otherwise the overlay works locally. The host's
  browser also keeps the settings (`studio-chat-overlay:<room>`), so a reload, or a
  server that restarted, brings them back, except Pause (its comment ids belong to an
  earlier session). Once per join, when the server sent no state, only the host
  publishes its browser copy; everyone else shows the defaults
  (`decideChatOverlayOnJoin`). Anyone who becomes an admitted host or co-host after
  joining is sent the room state. Each change carries a `seq` that the server returns
  as `ack` to the sender only, and the sender keeps unanswered changes applied on top
  of the server state for up to 3 seconds (`reconcileChatOverlay`). Server state is in
  memory only.
- **Privacy.** Backstage chat, direct messages and anything sent by someone still in
  the green room never reach the overlay (`selectOverlayComments`). Comment text is
  reduced to plain single-line text: controls, bidi and zero-width characters removed (a joiner between two visible
  characters stays, so emoji sequences and Persian or Indic words survive), at most 4
  combining marks in a row, 200 characters cut between whole characters (never inside
  an emoji), at most 8 rows and 3 lines per comment, 40 comments buffered.
- **Questions.** `isQuestion` (`questionDetection.ts`): trailing `?`, English question
  words, Tagalog/Taglish words, and `ba` within the first four words, with guards for
  exclamations and statements. Marked in the chat list and in the overlay.
- **Shown.** A comment put on screen with "Show on stage" is dimmed in the list with a
  "Shown" label, counts for approved mode, and fills the export column.
- **Export.** The existing chat transcript export (`chatTranscript.ts`) now writes
  CSV and TXT from the chat options menu. CSV columns: Time (ISO 8601), Source,
  Author, Message, Question, Shown on screen, then the earlier producer columns.
  Cells starting with `=`, `+`, `-`, `@` (or tab/CR) get a leading single quote.

Verification and what is left are in the PR description. Not covered by a
browser check: real YouTube/Facebook comments, a real RTMP/HLS viewer of the
output, and a co-host's browser (the server relay is covered by server tests).

## P1.17 — private test stream before going live

The host gets a **Test stream (private)** button in the Go Live panel, above the
checklist. It starts the same program relay with no destination at all, so
nothing reaches YouTube, Facebook or any other platform, whatever is enabled in
the destination list (the list is left as it was).

- **Media server** (`media-server/src/testStream.ts`, `index.ts`): a start
  message marked `test` must carry no destination or it is refused
  (`TEST_NOT_ALLOWED`); the session refuses destinations for its whole life
  (also on a reconnect start, and a test is never resumed as a broadcast); no
  backup recording is made; the program is published as HLS under a random
  unguessable id (`t-` plus 144 random bits, returned only to the studio that
  started the test), never under the studio's public watch id. Its playlist and
  segments are removed as soon as the test ends. A second session is refused
  with a plain message that names the test. `/health` advertises
  `capabilities.testStream`; the studio offers the test only when it is there
  (a new studio meeting the old media server during a deploy says so).
- **Signaling** (`test-stream-state-changed`): host/co-host only, in memory, never
  touches the live state or the room status, sent to late joiners, ends when the
  host goes live or leaves, refused while the room is live.
- **Studio**: "TEST - not public" badge in the header for host, co-hosts and
  guests (backstage guests see it on the live program monitor); the Go Live
  button in the control bar reads TEST. Nothing keyed to going live fires: no
  LIVE badge, no live state for guests, no backup recording. "Go live now" first
  checks the destination list (so a mistake does not cost the test), then ends
  the test and runs the normal Go Live path with all its checks.
- **Health panel**: connection, picture (resolution, kbps), frame rate, sound
  (program mix meter, not silent), lost frames and backlog. One pure, tested
  function (`client/src/utils/testStreamVerdict.ts`) holds the thresholds and
  gives the verdict after 15 seconds: "Ready to go live" or the specific problem
  and what to do. "Watch and listen to the test output" opens the private output
  in a player (wear headphones).
- **State machine** (`client/src/utils/testStreamMachine.ts`): idle, starting,
  testing, ending, switching, live, error; a test and a broadcast never overlap.

Verification: see the PR for the exact counts. Real Chromium with a local media
server on port 3012 and two destinations pointed at a counting local listener:
zero connections during the test, the verdict reached "Ready to go live", the
private output played real frames, the public watch address stayed offline, host,
stage guest and backstage guest showed TEST and never LIVE, End test removed the
private output, and "Go live now" ended the test and started a real session that
connected to both destinations. Screenshots at 1440x900 and 390x844 were looked at.
`e2e/studio.test.mjs` gained one short scenario that needs no media server (the
test is disabled with a reason when the media server does not advertise it).

Not verified: a co-host browser (it uses the same signal as a guest), the old
media server in a browser (covered by unit tests of the capability check), a
real camera and a real internet uplink (the verdict thresholds come from the
design, not from field data), and a signaling reconnect in the middle of a test
(the room would lose the TEST badge until the test is restarted).

## P1.16 — screen-share volume and music transport controls

**Screen-share volume.** In the People panel (where the host already sets each
person's broadcast volume) a "Screen share volume" slider (0 to 100 percent,
default 100) appears while a screen share is on the program. It changes what
viewers and the recording hear (the shared sound is one input of the program
mix, `screen:local` and `screen:<id>`), the backstage guests' program return
(remote shares), and the host's own monitor of a guest's separate screen tile.
It is applied once: the mix gain is set only in `buildProgramAudioInputs`, the
tile monitor volume is set only on the tile, and the two never feed each other.
Changes ride the mixer's existing 50 ms gain smoothing, so there are no clicks.
When the share carries no sound the panel says so ("The shared screen has no
sound...") instead of a dead slider. The value is kept per room in
`sessionStorage` (survives a reload, not a new browser session).

- Co-hosts: the program is mixed in the browser of the stage owner (the host, or
  the first co-host while the host is away), so the volume that applies is the
  one set in that browser. A co-host who is not running the program sees a line
  saying so instead of a slider, and their own stored value is ignored.
- Limits: a guest's share that arrives inside their camera stream (SFU
  screen-replaces-camera) has its sound mixed into their voice at the source and
  cannot be turned down separately; it shows no slider. The browser keeps playing
  a shared tab's own sound on the host's computer: that part is not ours to
  change, only the monitor of a guest's separate screen tile is. Accepted limit
  (decided by the project lead): the slider sets how loud the share is for
  viewers and in the recording; the host's own speakers play the host's own
  shared tab straight from the browser, at the tab's own volume.

**Music transport.** The background music panel shows the track name, elapsed
time, total length and time remaining, and a scrub bar that seeks while playing
or paused (`BackgroundMusicPlayer.seek`, on the same element that feeds the
program mix). A track without a known length (still loading, a live stream)
shows elapsed time only and no bar. The player publishes time at most four times
a second.

Helpers (`client/src/audio/mixControls.ts`): percent to gain, clamping, clock
formatting, seek clamping, the transport view and the rule for which control
shows, tested in `client/test/mixControls.test.ts`, `screenVolumeStore.test.ts`,
`programAudioMixer.test.ts` and `backgroundMusicPlayer.test.ts`.

Verification: see the PR for the exact counts. Real Chromium (fake media): a
shared source with a 440 Hz test tone, local recording to lease the program mix,
an analyser on the mix output. Net level at 100, 50 and 0 percent: 0.354, 0.176,
and only the fake microphone beep left at 0 (ratio 0.496 at 50 percent); arrow
keys, Home and End move the slider; a 60 s music file shows 0:30 / 1:00 / -0:30
after a seek to the middle by pointer, 0:58 / 1:00 / -0:02 near the end, and
seeks while paused; reload restores the volume; a silent share shows the plain
message; at 390x844 there is no horizontal scroll and the slider is 32 px tall.
Screenshots at 1440x900 and 390x844 were looked at.

Not verified: a real browser-tab or system-audio capture (the fake share is a
canvas plus oscillator), a co-host browser running the program (covered by the
stage-owner unit tests), a live-stream music source (covered by unit tests of
the unknown-length view), a screen reader. No e2e scenario was added: the share
needs a faked `getDisplayMedia`, which the shared e2e harness does not provide.

## Fix — a test stream never ends a held broadcast

**The risk.** When the studio's connection to the media server drops during a
real broadcast, the media server holds the destinations on the "we will be
right back" slate for 3 minutes, and a returning studio that presses Go Live
with the same setup continues the same broadcast. After a full reload the
studio does not show LIVE, so "Go Live" and "Test stream (private)" are both
offered. A test start used to run the "same studio restarting with new settings
replaces its own held broadcast" loop, and a test is never the same setup as a
broadcast, so pressing the test button during the hold ended the public
broadcast on YouTube and Facebook.

**What it does now.**

- Media server: a test start is refused, before any state of the new session
  exists, while the same room has a held real broadcast. The error code is
  `TEST_BLOCKED_BY_HELD_BROADCAST` and the message reads "Your broadcast is
  still on the air, waiting for you. Press Go Live to continue it. A test can
  run after the broadcast ends." The decision is the pure
  `getHeldBroadcastRefusal` and `isHeldRealBroadcast` in
  `media-server/src/testStream.ts`. The held broadcast keeps its slate, the
  3-minute limit still applies, a following Go Live with the same setup resumes
  it on the same destination connections, and a normal Go Live with new
  settings still replaces it. A held broadcast of a different room keeps the
  existing capacity refusal.
- Test panel: the refusal shows in the panel in the server's words and the
  panel returns to idle (the test button is usable, a Dismiss button clears the
  message). Nothing is announced to the room for a refused start, so guests see
  no "TEST - not public".
- Follow-up A: after the host's signaling connection drops and returns during a
  test, the host announces the test again (as a real broadcast already does), so
  guests and co-hosts get "TEST - not public" back within a few seconds. The
  decision is `shouldReannounceTest` (`client/src/utils/testStreamReannounce.ts`):
  only the host that runs the test in this browser, only while its media
  connection is up, never while the room is live, and not if the server already
  lists a test.
- Follow-up B: when "Go live now" ends the test and the broadcast then fails to
  start, the host sees "The test has ended, but the broadcast did not start.
  Reason: ... Fix it, then press Go Live." once. The live on/off flips of the
  broadcast's own start used to reset the test state before the failure arrived;
  the reducer now accepts the failure in either order. The message clears on the
  next action (test start, Go Live, dismiss).

**Neighbouring cases (read, not changed).** A real Go Live while a test from
the same room runs is refused for capacity ("A test stream is still running"),
because only sessions whose studio is gone count as held. A test start while a
real broadcast of the same room is running (for example from a co-host) is
refused for capacity ("A live broadcast is running"), because a running
broadcast is not held. "Go live now" from the test panel stops the test relay
and runs the normal Go Live path with its own checks; a test never carries a
destination and cannot publish. None of these can end a real broadcast or
publish a test.

**Found while checking (not changed).** Destination ids are part of the
"same setup" test. A destination added in this visit is `dest-N`; after a page
reload it comes back as `saved-N` (and without its stream key, which is never
stored). So a host who added the destination and reloaded in the same session
gets a new broadcast, not a resume, when pressing Go Live during the hold.
Destinations that were already remembered keep `saved-N` and resume. Worth a
separate fix (make the setup comparison ignore client ids).

**How it was verified.** `media-server/src/testStreamSession.test.ts` runs the
real media server against a local listener: a real broadcast reaches
"destination live", the studio socket closes, a test start from a new socket is
refused, the held broadcast is untouched (no private output folder, listener
connection still open), and a Go Live afterwards resumes it with no second
connection; the test fails without the guard (checked by disabling it). A second
case keeps the replace-on-new-settings behavior. Machine tests cover the
refusal and the Go-live-now failure in both orders; the re-announce decision has
its own test. Real browser check (`output/p118-hold-check/check.mjs`, local media
server on 3012, counting listener): live, away 12 s, return, test refused with
the message, listener connection still open and one connection in total, Go Live
continues on the same connection, then in a fresh studio a forced signaling
close brings "TEST - not public" back on the guest after about 2 s.

**Not verified.** The Go-live-now failure message in a real browser (machine
tests only); a real YouTube or Facebook destination (the listener is a dummy that
accepts the connection and says nothing); Safari and Firefox; a media server
restart during the hold. `e2e/studio.test.mjs` is unchanged: the scenario needs
a media server, which the CI browser job does not start.

## Fix — a returning studio continues its held broadcast when destination ids changed

**Problem.** When the studio's connection drops during a real broadcast, the media
server holds the destinations on a slate for 3 minutes and a returning studio that
presses Go Live continues the same broadcast when `isSameRelaySetup` says the setup
is the same. That comparison included the client's destination id. Ids are local to
one page visit (`dest-N` for a destination added in this visit, `saved-N` by position
after a reload), so a host who added, removed or re-ordered a destination in the visit
they went live in, then crashed or reloaded, was not continued: Go Live replaced the
held broadcast (public stream stopped, new one started). A host who does not remember
stream keys hit the same mismatch after pasting the key again.

**What it does now.**
- `media-server/src/relayRekey.ts` defines what a destination IS: its RTMP URL plus
  stream key. Two lists are the same when their sorted multisets of those pairs are
  equal (exact comparison, no trimming, order and ids and names ignored).
  `isSameRelaySetup` uses it; the output settings it compared before are unchanged.
- On a resume, `rekeySessionDestinations` pairs the held session's destinations with
  the returning studio's and moves every id-keyed record to the new ids in one place:
  relays (and the destination each carries), confirmed destinations, stop timers,
  restart timers, reconnect counts, and the stored destination list. Timers keep running.
  `resumeSession` also now stores the new list in `session.destinations` (it used to
  keep the old one, which the encoder-restart messages read).
- The relay handlers in `spawnRelay` (stats, error, exit, restart timer, backpressure)
  used to capture the destination object from when they were created. They now read
  `relay.destination`, which the helper updates, and a pending restart timer starts the
  replacement relay from the current destination and the current payload. After a resume
  nothing reports an id the returning studio does not know: status, stats, health,
  errors, restarts, the final stop summary.
- A list that really differs (one more, one fewer, another key or URL) still replaces
  the held broadcast, and a private test during a hold is still refused (PR #367 guard).

**Duplicates.** `validateDestinations` only requires unique ids; it accepts two
destinations with the same URL and key under different ids. The comparison counts
them (a list with the pair twice is not the list with it once) and the pairing is one
to one: equal ids first, then list order. Two destinations sending to one place is
not something a host would do on purpose, so the order rule is only there to keep the
mapping unambiguous.

**Client.** No change. The destination rows take the ids from the status messages, and
the media server now sends the returning ids. A remembered destination that comes back
without its stream key is refused by Go Live ("Missing stream key",
`getStreamDestinationIssue`, covered by `client/test/streamDestinations.test.ts`);
pasting the same key again continues the held broadcast. Stream keys are not stored or
logged anywhere new.

**Verification.**
- Unit tests: `relayRekey.test.ts` (set key ignores ids, names and order; different key,
  URL, more, fewer, duplicates, a separator inside a key; pairing; the re-key helper
  including swapped ids and an old id copied before the resume), `relayResume.test.ts`.
- Media-server session tests (`testStreamSession.test.ts`, real media server, local RTMP
  listener): the held broadcast continues with a different id, no second connection, every
  status after the resume and the stop summary carry the new id; another key replaces the
  held broadcast; the existing replace test passes. The continue test failed before the fix.
- Real browser (`output/resume-ids-check/check.mjs`, 1440x900): remember-keys on and off,
  destination added in the visit that went live, reload, hold, Go Live: one connection at
  the listener, LIVE, row connecting then live; with keys off Go Live refuses with
  "Missing stream key" until the key is pasted again.

**Not verified.** A real YouTube or Facebook destination (the listener is a local dummy
that never answers); a long hold close to 3 minutes; `e2e/studio.test.mjs` was not
changed (it has no media server in CI).

## Resume here next session

Draft P0.3 branch checkpoint: anonymous release-tagged error aggregation and
browser intake regressions are saved. The browser suite now runs error intake
and studio qualification serially, with separate diagnostic artifacts. The
previous lint run and 26 targeted tests passed; an additional throwing-getter
regression is awaiting the new gate run. Full current-head gates and browser
verification must pass before this branch merges.

**Linux finalization (resolved in PR #352):** five CI runs of the same code
gave 3 passes and 2 failures waiting for "Start recording" after the 30-second
take. Passing runs already spent 30-40 s closing out the take (scenario 73-85 s)
with no page errors, so the failures were the 60 s deadline on a shared runner
encoding three browsers' video in software, not a stalled stop path. The suite
now records at the 720p preset, allows 120 s for finalization, writes
`recording-finalize-timing.json` on success and, on a timeout, each recorder's
stop-requested/stopped timestamps plus a screenshot. Assertions are unchanged.

PR #352 is merged, including the Linux finalization diagnostic. Recording
integrity and error reporting remain separate drafts awaiting their own gates.

### P0.2 checkpoint — PR #353 (read-ahead)

The guest sender now reads its recording in bounded 256 KiB blocks instead of
one disk read per ~16 KiB network frame, and discards that block on resume,
completion and close. Review found that the sender kept reading the snapshot it
had cached even after a finished track swapped to its final file (a folder
writer removes the part files the snapshot points at), and retried an unreadable
snapshot forever after any failed read. It now drops the cached snapshot and
block when the source changes or a read fails; two regressions cover both and
fail without the fix. Local gates: client **1,421**, server **265 + 2 skipped**,
media server **291**, shared **26**, scripts **37**; lint and the root build
pass. A local 35-second smoke (Mac, X9 Pro) completed all four guest transfers
across the forced reconnect, byte-identical to the MediaRecorder sources, with no
page, CSP or recording console errors. It still failed the 1-second packet-gap
check on video streams, including the host's own non-transferred ISO, so those
gaps come from capture, not transfer.

**Linux soak still fails before transfer starts.** Runs 42488938177 and
42489839081 (the second after timer-polled readiness waits) both failed the
35-second preflight the same way: the host page fell minutes behind. Its ISO
started 10 s after its audio and the program 24 s after it; over about 330 s
it emitted 19 ISO and 7 program chunks while each guest emitted 335. It never
answered a guest transfer offer, its signaling socket missed heartbeats, and
the server ended the room after 120 s. Guests were healthy. No page, CSP or
recording console errors. The 20-minute step never ran, and no guest byte
reached the host, so these runs do not test read-ahead.

Likely cause (not yet verified): `client/src/utils/frameTicker.ts` sets
`lastFrameAt` before calling `onFrame`. Once a compositor frame takes more than
half the 33 ms interval (likely for 1080p software raster on a GPU-less 4-vCPU
runner), every queued worker tick passes the backlog check. Frames are then drawn
back to back and the host main thread never idles. Next: measure the frame time
on Linux, then drop ticks that arrive during or just after a slow frame (with a
unit test) in a separate PR, and rerun the soak. Evidence is on X9 Pro in
`.x9/storage/qa-local/soak-353/`.

1. **P0.2 — recording integrity:** validate `codex/wave3-recording-read-ahead`.
   The exclusive 35-second rehearsal stopped all seven recorders and resumed
   real peer channels, but timed out receiving every guest track. The sender
   performs serial disk reads for each approximately 16 KiB network frame;
   the draft adds bounded 256 KiB reads plus three unrun regressions. Run those
   tests, all gates, a quiet local smoke, then the manual CI `recording_soak`
   input (35-second preflight followed by 1,200 seconds). Require byte-identical
   received files, monotonic timestamps, no gap over one second and media-clock
   drift below 40 ms. Do not claim real-camera lip sync or ExFAT throughput
   from a Linux result. Evidence: `output/recording-soak/2026-11-08T06-54-02.627Z/`.
2. **P0.3 — error reporting:** finish `codex/wave3-errors`. Privacy sanitization,
   release tags, bounded grouping and intake defenses are implemented; lint
   and 26 targeted tests passed. The interrupted full test run is not a pass.
   Run full gates and `e2e/client-errors.test.mjs`; that browser test is now in
   CI with serial execution so fixtures do not collide on ports. Then review and
   merge its own PR and confirm deployed release tags.
3. **P4.31 — deploy classifier:** isolated on
   `codex/wave3-deploy-classifier-ready` with ten passing classifier tests.
   Root Dockerfile/.dockerignore changes now trigger the media deployment;
   unrelated nested Docker filenames do not. Full CI is the merge gate. This
   branch contains no browser harness or unverified recording/error changes.
4. P1.4 (destinations/presets/health) is PR #360. Continue with the
   remaining unchecked items in order, starting at P1.5.

No new paid services or owner configuration changes are required by the shipped
test tooling. A real-camera/network rehearsal is still an owner action after
synthetic recording qualification. All local work, evidence and caches remain
on X9 Pro. Do not run multiple browser rehearsals or builds concurrently there.
