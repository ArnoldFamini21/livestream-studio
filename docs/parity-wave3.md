# StreamYard / Riverside parity — wave 3

## Backlog checklist

Unchecked items are not qualified or shipped. Partial work is recorded below;
unit coverage alone does not complete a browser acceptance criterion.

- [x] **P0.1** Browser end-to-end qualification in Linux CI (PR #352 merged)
- [ ] **P0.2** Three-participant recording soak (20+ minutes, reconnect, transfer, packet timing)
- [ ] **P0.3** Free production error grouping, release tags, no PII
- [x] **P1.4** Configurable multistream destinations, health and presets (PR #360, verified locally; see below)
- [ ] **P1.5** Simultaneous landscape and portrait streaming
- [x] **P1.6** Merged on-screen chat overlay, questions and export (PR #PRNUM, verified locally; see below)
- [ ] **P1.7** Moderated viewer chat, reactions and Q&A
- [ ] **P1.8** Signed watch-page registration and HLS authorization
- [ ] **P1.9** Audience call-ins through the green room
- [ ] **P1.10** Reusable studios, synced scenes and scene folders
- [ ] **P1.11** Automatic intros/outros, banner folders, movable overlays and QR widget
- [ ] **P1.12** Stage tile controls, backstage reordering and people audio controls
- [ ] **P1.13** Private mentions, shared notes and teleprompter collaboration
- [ ] **P1.14** Phone/desktop secondary camera seats and ISO recording
- [ ] **P1.15** Camera controls, smoothing and same-origin MediaPipe assets
- [ ] **P1.16** Screen-share mix volume and music transport controls
- [ ] **P1.17** Private test stream before public broadcast
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
Logos are still sent inline in branding, so a logo data URL over about 60 KiB
can still exceed the WebSocket cap; that predates this change.

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

## P1.6 — on-screen chat overlay, questions, shown comments, export (PR #PRNUM)

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
  server that restarted, brings them back (the host republishes when the server holds
  nothing). Server state is in memory only.
- **Privacy.** Backstage chat, direct messages and anything sent by someone still in
  the green room never reach the overlay (`selectOverlayComments`). Comment text is
  reduced to plain single-line text: controls, bidi and zero-width characters removed,
  200 characters, at most 8 rows and 3 lines per comment, 40 comments buffered.
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
