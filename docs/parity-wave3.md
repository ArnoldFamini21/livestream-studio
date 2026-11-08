# StreamYard / Riverside parity — wave 3

## Backlog checklist

Unchecked items are not qualified or shipped. Partial work is recorded below;
unit coverage alone does not complete a browser acceptance criterion.

- [ ] **P0.1** Browser end-to-end qualification in Linux CI (Linux recording finalization is failing)
- [ ] **P0.2** Three-participant recording soak (20+ minutes, reconnect, transfer, packet timing)
- [ ] **P0.3** Free production error grouping, release tags, no PII
- [ ] **P1.4** Configurable multistream destinations, health and presets
- [ ] **P1.5** Simultaneous landscape and portrait streaming
- [ ] **P1.6** Merged on-screen chat overlay, questions and export
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

## Resume here next session

**Linux finalization (resolved in PR #352):** five CI runs of the same code
gave 3 passes and 2 failures waiting for "Start recording" after the 30-second
take. Passing runs already spent 30-40 s closing out the take (scenario 73-85 s)
with no page errors, so the failures were the 60 s deadline on a shared runner
encoding three browsers' video in software, not a stalled stop path. The suite
now records at the 720p preset, allows 120 s for finalization, writes
`recording-finalize-timing.json` on success and, on a timeout, each recorder's
stop-requested/stopped timestamps plus a screenshot. Assertions are unchanged.

The owner requested a usage-limited wrap-up before the long soak. Browser and
recording work remain drafts. Only an independently verified deploy-classifier
change may merge during this wrap-up; it is isolated from the failing suite.

Draft P0.2 branch checkpoint: bounded sender read-ahead and three regression
cases are saved but unverified. Do not merge this production change until its
unit cases, full gates, local smoke and 20-minute Linux soak pass.



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
   Run full gates and `e2e/client-errors.test.mjs`; add that browser test to CI
   with serial execution so fixtures do not collide on ports. Then review and
   merge its own PR and confirm deployed release tags.
3. **P4.31 — deploy classifier:** isolated on
   `codex/wave3-deploy-classifier-ready` with ten passing classifier tests.
   Root Dockerfile/.dockerignore changes now trigger the media deployment;
   unrelated nested Docker filenames do not. Full CI is the merge gate. This
   branch contains no browser harness or unverified recording/error changes.
4. Continue **P1.4** (configurable destinations/presets/health), then the
   remaining unchecked items in order. None of P1–P3 was implemented here.

No new paid services or owner configuration changes are required by the shipped
test tooling. A real-camera/network rehearsal is still an owner action after
synthetic recording qualification. All local work, evidence and caches remain
on X9 Pro. Do not run multiple browser rehearsals or builds concurrently there.
