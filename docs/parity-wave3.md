# StreamYard / Riverside parity — wave 3

## Backlog checklist

Unchecked items are not qualified or shipped. Partial work is recorded below;
unit coverage alone does not complete a browser acceptance criterion.

- [ ] **P0.1** Browser end-to-end qualification in Linux CI
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
- [ ] **P4.31** Root Dockerfile/.dockerignore trigger media deployment

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
