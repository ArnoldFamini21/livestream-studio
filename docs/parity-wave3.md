# StreamYard / Riverside parity — wave 3

## Backlog checklist

- [ ] **Owner request, 2026-11-08:** accessible canvas background color and custom-image controls while presenting

Unchecked items are not qualified or shipped. Partial work is recorded below;
unit coverage alone does not complete a browser acceptance criterion.

- [ ] **P0.1** Browser end-to-end qualification in Linux CI (Linux recording finalization is failing)
- [ ] **P0.2** Three-participant recording soak (20+ minutes, reconnect, transfer, packet timing)
- [x] **P0.3** Free production error grouping, release tags, no PII (PR #354 merged)
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

### Canvas background request

The existing stage background already feeds the preview and compositor, but
its picker is buried in Brand settings and solid colors are limited to presets.
Add a Background control beside stage layout controls, including during slide
presentations. Reuse the existing image upload/storage pipeline, add arbitrary
hex/color selection, and preserve gradients, video and reset options. Verify
preview and program pixels, persistence after reload, and desktop/phone layouts
under the real CSP. No new dependency, origin or paid service is planned.

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

## Resume here next session — owner-requested stop, 2026-11-08

All implementation stopped at the owner's request to conserve usage. These
notes supersede the earlier qualification snapshot above. No P1–P3 backlog
item was implemented in this session.

Shipped: PR #352 browser qualification and PR #356 deployment classification
were already merged. PR #354 anonymous error grouping, release tags and intake
defenses merged as `e3a4f59829319b85116c2b1242c822ce40470064`. Its exact-head
Linux CI (42464109239) passed all workspace lint/build checks, 2,032 unit/script
tests (two database tests skipped), and 11 real Chromium browser tests. Local
X9 browser verification of that PR was deferred; Linux browser verification
passed. Approximate total bundle increase: 2.91 kB raw / 0.53 kB gzip. Deployment
verification is tracked in the merge's GitHub Actions run and final handoff.

1. **Owner request — canvas background, draft PR #357:** the Background button
   beside layout controls, accessible dialog, custom hex/color selection,
   image upload/reset and saved-stage helpers are committed as an unverified
   checkpoint. Image normalization caps dimensions at 1920px and binary size
   at 400 KiB while retaining transparency. Dependency installation completed;
   no lint, unit, build or browser checks ran. The new focused tests are unrun.
   **Blocking:** the server WebSocket maxPayload is 64 KiB, whereas normalized
   image data URLs can approach 546 KiB. Uploading a larger image can disconnect
   the host. Do not merge until transport is fixed and verified. Consider a
   bounded larger frame only for authenticated, admitted host/cohost branding
   updates; retain 64 KiB for other messages and all authorization/rate checks.
   Existing authenticated stage-image HTTP URLs cannot directly serve CSS
   images without an appropriate authorized loader and eviction handling.
   Then run full gates and real local-browser color/image, persistence,
   preview/compositor and responsive checks. Use the existing X9 FFMPEG_BIN
   when installing/building media dependencies. This draft has no server fix.
2. **P0.2 — recording integrity, draft PR #353:** head `e7d3bda1` preserves
   bounded 256 KiB sender read-ahead, four regression tests, stricter seven-file
   reconnect/transfer and packet analysis, plus an untested Shift+R stop
   diagnostic. Previous checkpoint `d6942f43` passed all local lint/build gates
   and 2,025 tests (two database tests skipped). A quiet local smoke delivered
   all seven files after reconnect, but failed on a 1.200-second host ISO packet
   gap. Linux manual run 42464124847 passed normal unit/browser jobs but failed
   its 35-second soak preflight while clicking Stop. The 20-minute soak never
   ran. Next: validate the keyboard-stop diagnostic, rerun quiet preflight,
   investigate any remaining gaps, then qualify at least 1,200 seconds. Keep
   byte-identical transfer, monotonic timestamps and <=1 second packet gaps.
   The <40 ms drift check compares endpoint media durations; it does not
   establish peak transient drift or real-camera lip sync. Local evidence:
   `output/recording-soak/2026-11-08T08-39-52.486Z/result.json`.
3. Continue **P1.4** (configurable destinations/presets/health), then unchecked
   backlog items in order after these qualifications.

Recording finalization is not proven to be solely software-encoding delay.
The no-folder participant path can retry an unavailable upload endpoint with
31 seconds of backoff; an unbounded network fetch also deserves investigation.
The existing 720p preset, 120-second short-suite finalization deadline and
recorder diagnostics do not relax the long-soak media-integrity assertions.

All owned local test/build/browser processes were stopped. All work, evidence,
dependencies and caches remain on X9 Pro. Run only one heavy build/browser
qualification at a time. No new paid services or owner configuration changes
were introduced. A real-camera/network rehearsal remains an owner action after
synthetic recording qualification.
