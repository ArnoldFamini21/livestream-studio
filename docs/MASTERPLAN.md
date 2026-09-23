# LiveStream Studio — Masterplan to StreamYard / Riverside Parity

_Review date: September 22, 2026 · Baseline commit: `af50eb1`_

## 1. Summary

LiveStream Studio already has most of the features StreamYard and Riverside list. It has scenes, stinger transitions, lower thirds, tickers, polls, Q&A, a soundboard, background music, a teleprompter, virtual backgrounds, chroma key, isolated per-participant recording, FFmpeg exports, captions, translation, AI show notes, and multistreaming. All 1,064 automated tests pass, and the production build and typecheck are clean.

**The gap is no longer the feature list.** Four things separate this product from the competitors:

1. **Where the show is produced.** The program feed is composited and encoded in the **host's browser**. StreamYard does this in the cloud. As a result, the host's laptop and upload connection are a single point of failure for every broadcast.
2. **Recording durability.** Guest tracks upload **after** recording stops, and they are staged on an ephemeral media-server disk. Riverside uploads progressively *during* the session and shows the host each guest's upload progress.
3. **Three missing product pillars:** a post-production **editor** (Riverside's core), a hosted **audience/webinar** experience (StreamYard On-Air, Riverside Webinars), and **connected platform accounts** (OAuth destinations instead of pasted stream keys).
4. **Production infrastructure.** Postgres, object storage, and TURN are optional, and hosting runs on free instances that sleep after 15 minutes. CI deploys to production without running the test suite. Signaling state lives in one process's memory.

This plan puts **reliability before breadth**. Phases 0–2 make the existing features dependable. Phases 3–5 add the missing pillars.

---

## 2. How this review was done

| Step | What was checked |
| --- | --- |
| Code read | Media plane (`useWebRTC`, SFU, `useRtmpRelay`, media-server relay), recording/upload path, signaling/persistence, auth, deployment (Render, k8s, CI) |
| Tests | `shared` 13/13, `server` 149/149, `media-server` 139/139, `client` 763/763. All pass. |
| Build | `client` typecheck and Vite production build pass |
| Existing docs | `IMPLEMENTATION_PLAN.md`, `docs/competitor-audit.md`, `docs/studio-redesign.md` |
| Competitors | StreamYard and Riverside pricing pages, StreamYard architecture statements, Riverside help center (see §11) |

`IMPLEMENTATION_PLAN.md` tracks whether features *exist*. This masterplan tracks whether they are *dependable at production scale*, as the repository's own audits already caution ("an implementation checkbox is not a service guarantee").

---

## 3. Verified findings from the code review

### 3.1 Defects and reliability risks (fix first)

| # | Finding | Evidence | Impact |
| --- | --- | --- | --- |
| **F1** | **Destination auto-reconnect cannot recover.** When one destination's FFmpeg exits, it is respawned and receives the *next* MediaRecorder chunk. The WebM EBML header and Tracks element were only in the first chunk, and they are neither cached nor replayed. | `media-server/src/index.ts:326-342` (restart), `:515-541` (chunk fan-out), `RelaySession` at `:87` has no init-segment field | A dropped RTMP connection to YouTube, Facebook, or another destination stays down. The restart loop spends its 2 attempts on input FFmpeg cannot parse. |
| **F2** | **No backpressure anywhere in the live path.** Server `stdin.write()` ignores its return value. The client `ws.send()` never checks `bufferedAmount`. | `media-server/src/index.ts:528,539`; `client/src/hooks/useRtmpRelay.ts:788` | If an encoder or network falls behind, Node buffers without limit. That leads to memory growth, growing latency, and eventually an out-of-memory crash mid-show. |
| **F3** | **One full x264 encode per destination**, plus a fourth for the live backup. | `spawnRelay()` `media-server/src/index.ts:271` calls `createFfmpegArgs()` (`rtmp.ts:136`) with `libx264` for each destination | Three destinations need about 4× the CPU of one encode. This is the practical reason for the `MAX_RTMP_DESTINATIONS = 3` cap. StreamYard offers 8 destinations and Riverside offers unlimited. |
| **F4** | **Host browser is the program encoder.** The canvas is captured and encoded by MediaRecorder, then relayed. | `useRtmpRelay.ts:302` (`canvas.captureStream`), `:772` (MediaRecorder) | A host tab crash, sleeping laptop, or weak uplink ends the broadcast for everyone. StreamYard explicitly does "encoding, recording, multistreaming, and layout compositing in the cloud." |
| **F5** | **Guest uploads start only after recording stops**, from the finished Blob. | `client/src/utils/recordingUpload.ts:472-502` | A 90-minute 4K session ends with gigabytes still to upload. Guests who close the tab lose the take unless they return on the same device and browser. |
| **F6** | **Upload staging is ephemeral.** Chunks append to `os.tmpdir()`. The upload session registry is an in-memory `Map`. | `media-server/src/recordingUpload.ts:243,247` | A Render restart, redeploy, or 15-minute idle spin-down discards partial uploads and their offsets. |
| **F7** | **Persistence is optional; the default is memory.** Without `DATABASE_URL`, rooms, accounts, and catalogs live only in process memory. Schemas are created with ad-hoc `CREATE TABLE IF NOT EXISTS` in six services, with no migration tool. | `server/src/services/signaling.ts:171`; `accountAuth.ts:469-475`; `roomPersistence.ts:346-352` | A server restart can erase studios and sessions. Schema changes have no safe upgrade path. |
| **F8** | **Signaling cannot scale out.** All room state is in one process, and both k8s deployments set `replicas: 1`. | `signaling.ts:171-175`; `k8s/production/*-deployment.yaml` | No failover and no horizontal scale. One crash drops every live room. |
| **F9** | **CI deploys without running the 1,064 tests.** The workflow runs only `scripts/*.test.mjs` and builds, then deploys on every push to `main`. | `.github/workflows/deploy.yml:5,74` | Regressions go straight to production. |
| **F10** | **Guest screen share replaces the guest's camera.** One video sender per peer. | `client/src/hooks/useWebRTC.ts:347-360`; acknowledged in `docs/competitor-audit.md` | Guests cannot appear on camera *and* share a screen as separate, independently positioned sources. |

### 3.2 Structural and product gaps

| # | Finding | Evidence |
| --- | --- | --- |
| **G1** | Two very large components: `StudioRoom.tsx` has 7,747 lines and about 304 hook calls. `RecordingPanel.tsx` has 6,673 lines. | `wc -l`; this slows every media-plane change and makes regressions likely |
| **G2** | WebCodecs output is a raw bitstream "sidecar" only. Playable recordings still come from MediaRecorder WebM. | `client/src/hooks/useLocalRecording.ts:153-176` |
| **G3** | The SFU is built on `werift`, a pure-TypeScript implementation, and runs as a single replica. It takes over at 5+ on stage (`sfuRuntime.ts:3`). The default room cap is 7 (`signaling.ts:579`). Throughput under load is unproven. | Competitors: StreamYard shows 10 on screen plus 15 backstage (paid tiers) |
| **G4** | Destinations take a pasted stream key only. Keys are not remembered, and there is no OAuth to create YouTube/Facebook/LinkedIn broadcasts. YouTube chat is read-only through an API key. | `client/src/utils/streamDestinations.ts`; `server/src/services/youtubeLiveChat.ts` |
| **G5** | Accounts have no password reset, email verification, social sign-in, or transactional email. "Magic link" invites are `mailto:` links. | `server/src/services/accountAuth.ts`; `client/src/utils/inviteLinks.ts:100` |
| **G6** | There is no hosted viewer/watch page (HLS/WHEP). Audiences must watch on YouTube or Facebook, so polls and Q&A rely on external chat ingestion. | Client routes: `/`, `/studio`, `/join`, `/privacy`, `/terms` only |
| **G7** | There is no editor: no timeline and no transcript-based editing. Post-production is limited to trimming and exporting clips. | `RecordingPanel.tsx` |
| **G8** | There is no error monitoring, product analytics, or automated end-to-end browser tests. The browser fixtures under `client/test/browser/` are run manually. | No Sentry/OTel/Playwright dependencies |
| **G9** | Bundle weight: `pptx-preview` is 1.2 MB and the `StudioRoom` chunk is 637 KB (minified). | `client/dist/assets` |

### 3.3 Where the product already matches or exceeds the competitors

Scenes with thumbnails and a show-pack template, stinger transitions, soundboard, background music with ducking, teleprompter, producer panel, lower thirds with animation presets, tickers/timers/banners, polls and Q&A, comment highlighting, chroma key, brand kits, private slide cueing with speaker notes, -14 LUFS loudness normalization, caption translation (13 languages), AI show notes, and 9:16 / 1:1 clip formats. **Protect these. Do not rebuild them.**

---

## 4. Competitive gap matrix

✅ at parity · 🟡 partial or unproven · ❌ missing

| Capability | StreamYard | Riverside | LiveStream Studio today | Status |
| --- | --- | --- | --- | --- |
| Where the program is composited/encoded | Cloud | Cloud | Host browser | ❌ (F4) |
| On-screen participants | 6 free / 10 paid; 15 backstage (Advanced) | Multi-guest studio | Room cap 7; SFU at 5+, unproven | 🟡 (G3) |
| Multistream destinations | 3 (Core) / 8 (Advanced) | Unlimited at 1080p (Grow) | 3, each separately encoded | 🟡 (F3) |
| Connected accounts (OAuth, auto-create broadcast) | Yes | Yes (publish to YouTube, LinkedIn, and others) | Stream key paste only | ❌ (G4) |
| Destination drop recovery | Yes | Yes | Client reconnect works; per-destination restart broken | ❌ (F1) |
| Local per-participant recording | Up to 4K (Advanced) | Up to 4K, 48 kHz (Pro+) | 720p/1080p/4K presets via MediaRecorder | 🟡 (unverified at long durations) |
| Progressive upload during recording | Recovers unfinished uploads | Yes, with host-visible % and pause/resume | After stop only; ephemeral staging | ❌ (F5, F6) |
| Crash recovery of local takes | Yes | Yes | OPFS recovery, same browser only | 🟡 |
| Guest camera + screen as separate sources | Yes | Yes | Screen replaces camera | ❌ (F10) |
| Text-based / timeline editor | — | Core feature (text-based editing, remove silences/filler words, B-roll) | Trim + clip export | ❌ (G7) |
| AI clips | Yes (Core+) | Magic Clips | Heuristic + LLM suggestions, manual export | 🟡 |
| Transcripts / captions | Downloadable transcripts | Unlimited transcriptions | Whisper + VTT/SRT + translation | ✅ |
| Show notes / chapters | — | Yes | Yes (OpenAI) | ✅ |
| Audio enhancement | — | Magic Audio / enhancement | Loudness only; no AI denoise | 🟡 |
| Hosted webinar / watch page | On-Air (100 viewers, Advanced) | Webinars up to 10,000 registrants, lead capture, email reminders, CRM | Registration fields only; no viewer page | ❌ (G6) |
| Pre-recorded "stream as live" | 2–4 h | Yes (Webinar plan) | Manual video share on stage | 🟡 |
| Publishing / podcast hosting | — | YouTube, Spotify, Apple, Instagram, LinkedIn; podcast hosting | Google Drive upload | ❌ |
| Teams, roles, SSO | Seats per plan | Workspaces, custom roles, SSO, SOC 2 | Local and server roster; no enforced roles | 🟡 |
| Account lifecycle | Full | Full | Register and login only | ❌ (G5) |
| Mobile | Mobile browser | Mobile app (help center) | Responsive web | 🟡 |
| Scenes, stingers, soundboard, teleprompter, producer mode | Partial | Teleprompter, producer mode | Yes | ✅ (ahead on scenes and soundboard) |

---

## 5. Guiding principles

1. **Reliability before breadth.** Add no new feature surface until the Phase 0 exit criteria pass.
2. **Done means verified.** Every item needs an exit test run against real destinations, real guests on separate networks, and production hosting. A checkbox is not enough.
3. **Adopt proven media infrastructure; build the differentiators.** Custom SFU, relay, and egress code is where competitors have years of hardening. Scenes, overlays, and producer tools are where this product already shines.
4. **Server-side production is the north star.** Once the program feed is rendered in the cloud, most reliability gaps close together: host crash, multistream CPU, weak host uplink, and cloud composite recording.
5. **Small, reviewed PRs, gated by CI.** Do not push directly to `main` for production.

---

## 6. Key architecture decision: media infrastructure

The biggest decision in this plan is whether to keep the custom `werift` SFU and browser compositor or adopt a production media stack.

| Option | What it means | Pros | Cons |
| --- | --- | --- | --- |
| **A. Adopt LiveKit (self-hosted OSS or LiveKit Cloud)** — *recommended* | Replace mesh + `werift` SFU with the LiveKit SFU. Use **LiveKit Egress** (headless Chrome room composite) to render the existing compositor page server-side and output RTMP and files. Use **Ingress** for RTMP/WHIP inputs. | Proven SFU with simulcast, TURN, and reconnection. Server-side program feed reuses the existing React compositor and overlays as the Egress template. Per-track and composite cloud recording come built in. Retires thousands of lines of custom media code. | Migration touches `useWebRTC`, SFU utilities, and parts of `StudioRoom`. Adds an infrastructure dependency (self-hosted or paid cloud). |
| B. mediasoup + custom headless-Chrome renderer | Replace `werift` with mediasoup (C++ workers). Build a Puppeteer/Chromium "program participant" that renders the compositor and pipes to FFmpeg. | Full control. Mature SFU core. | Much more custom work: egress orchestration, scaling, and recovery all have to be built. |
| C. Keep current stack, harden it | Fix F1–F3, add co-host handoff of the program encoder, load-test `werift`. | Least disruption. | The host remains the single point of failure. `werift` scale is unproven. Parity with cloud production is out of reach. |

**Recommendation:** Do **C's fixes now** (Phase 0, because they are cheap and protect current shows), then migrate to **A** in Phase 1. The existing compositor code (`useCompositor`, overlays, scenes) is the most valuable asset for the move: it becomes the server-rendered layout template, the same approach StreamYard describes.

---

## 7. Phased roadmap

Sizes are rough estimates for one full-time developer working with AI assistance. S ≈ ≤1 week, M ≈ 2–3 weeks, L ≈ 4–6 weeks, XL ≈ 6–10 weeks.

### Phase 0 — Stabilize, gate, and instrument · **M** · start now

| Item | Details | Fixes |
| --- | --- | --- |
| 0.1 Run every test suite in CI | Add `npm test` for shared/server/media-server/client and `npm run lint` to `deploy.yml` before any deploy step. Move deploys to run only after tests pass. Use PRs, not direct pushes to `main`. | F9 |
| 0.2 Replay the WebM init segment on relay restart | Cache the EBML header + Segment/Tracks from the first chunk(s). Write them to any respawned FFmpeg before live chunks, and start at the next Cluster boundary. Add a regression test that kills FFmpeg mid-stream. | F1 |
| 0.3 Backpressure | Honor `stdin.write()`/`'drain'`, bound the per-relay queue, and drop to the next keyframe cluster when over budget. On the client, check `ws.bufferedAmount` and surface "network congested" in Session Health. | F2 |
| 0.4 Encode once, fan out | One FFmpeg process: decode, one x264 encode, `-f tee` with `[onfail=ignore]` per destination (and the backup file). Restarts of one output must not affect the others. Then raise the destination cap to 8. | F3 |
| 0.5 Fail fast on missing production infrastructure | When `NODE_ENV=production`, refuse to start without `DATABASE_URL`, object storage credentials, and TURN. Show the status in `/health`. | F6, F7 |
| 0.6 Database migrations | Adopt a migration tool (e.g., `node-pg-migrate`, Kysely, or Drizzle migrations). Move the six ad-hoc `CREATE TABLE` blocks into versioned migrations. | F7 |
| 0.7 Paid hosting | Move signaling and media off free instances (no idle spin-down, persistent config). Use managed Postgres, S3-compatible storage (e.g., Cloudflare R2 or Backblaze B2), and a TURN provider or dedicated coturn with TLS on 443. | F6, F7 |
| 0.8 Observability | Error tracking for client and servers (Sentry or self-hosted GlitchTip), structured logs, and an alert on relay exits, upload failures, and signaling disconnect spikes. The Prometheus/Grafana setup already exists; deploy it. | G8 |

**Exit criteria:** A 2-hour stream to YouTube + Facebook with 3 remote guests completes with no manual intervention. Killing one destination's FFmpeg mid-stream recovers it within 10 s without affecting the other destination. A signaling-server restart mid-show recovers every participant automatically.

### Phase 1 — Cloud production engine · **XL**

| Item | Details | Fixes |
| --- | --- | --- |
| 1.1 Media plane on LiveKit (or mediasoup) | Replace mesh + `werift` with the chosen SFU. Keep simulcast and the per-participant quality badges. Retire `meshCapacityPlanner` and SFU cutover logic. | G3 |
| 1.2 Multi-track publishing per guest | Camera, microphone, screen, and screen audio as separate tracks. Any source can be placed independently in any layout. | F10 |
| 1.3 Server-rendered program | Extract the compositor and overlays into a standalone "program" page driven by room state from signaling. Render it with Egress/headless Chrome and output RTMP (encode once, multi-output) plus a composite recording. The host's browser only *controls* the show. | F3, F4 |
| 1.4 Host-independent shows | If the host disconnects, the program keeps running on the current scene and a co-host can take over control. | F4 |
| 1.5 Stateful signaling that survives restarts | Move live room state to Redis (or Postgres + pub/sub) so signaling can run 2+ replicas behind sticky sessions with failover. | F8 |
| 1.6 Capacity | 10 on-screen participants and 15+ backstage, verified by a load test with synthetic publishers. | G3 |
| 1.7 Decompose `StudioRoom.tsx` alongside this work | Split into feature modules (media, stage, recording, broadcast, chat, producer) with a studio state store (e.g., Zustand or an XState machine for broadcast/recording lifecycles). Do this incrementally, because the media-plane migration touches this file anyway. | G1 |

**Exit criteria:** The host closes their laptop mid-stream and the broadcast continues. 10 on-screen guests produce a stable 1080p30 output to 3+ destinations. A guest can be on camera while sharing a screen at the same time.

### Phase 2 — Riverside-grade recording · **L**

| Item | Details | Fixes |
| --- | --- | --- |
| 2.1 Progressive upload during recording | Stream committed OPFS fragments (`recordingChunkStore`) to storage while recording, using the existing offset-checked chunk protocol. Show per-guest upload % in People and Session Health, with pause/resume. | F5 |
| 2.2 Direct-to-object-storage multipart | Presigned S3 multipart uploads from the browser. The server tracks durable offsets in Postgres, not memory or `tmpdir`. | F6 |
| 2.3 Resume anywhere | A guest who reopens the invite link on the same device resumes an unfinished upload automatically. Otherwise the host sees exactly which tracks are incomplete. | F5 |
| 2.4 Cloud safety net | Per-participant SFU-side recordings (lower quality) plus the Egress composite act as automatic backups when a local track never arrives. | — |
| 2.5 Track alignment | Use the existing capture metadata to align tracks and correct drift at export, targeting ±1 frame. | — |
| 2.6 Durable export queue | Move FFmpeg export jobs to a persistent queue (e.g., pg-boss or BullMQ) with retries and a worker pool, separate from the live relay. | F6 |
| 2.7 Browser matrix and soak tests | 2 h and 4 h sessions on Chrome, Edge, Safari, Firefox, and mobile Safari/Chrome, checking memory, storage pressure, and playback of 4K and 1080p outputs. | G2 |

**Exit criteria:** In a 90-minute session with 4 guests, one guest closes their browser at minute 60. Every track is complete in the cloud within 5 minutes of the session ending (with the fallback cloud track for the part the guest missed), and all tracks are aligned.

### Phase 3 — Post-production editor and AI repurposing · **XL**

| Item | Details |
| --- | --- |
| 3.1 Word-level transcripts with speaker labels | Transcribe each isolated track separately. Each track is one speaker, so diarization comes free. |
| 3.2 Text-based editor | Delete words or sentences to cut every track in sync. Includes a multi-track timeline, per-segment layouts, and caption styling. Renders server-side through the same program renderer as Phase 1. |
| 3.3 One-click cleanup | Remove silences and filler words using the word timestamps. |
| 3.4 AI clips end to end | Turn the existing highlight suggestions into finished vertical clips: speaker-aware reframing, animated burned-in captions, and title cards from the brand kit. |
| 3.5 Audio enhancement | Server-side noise/reverb removal (e.g., DeepFilterNet or RNNoise) before loudness normalization. |
| 3.6 Library | One recording library: preview, transcript, captions, show notes, clips, exports, and clear readiness and failure states. |

**Exit criteria:** Starting from a 60-minute recording, a user produces a 60-second 9:16 captioned clip and a cleaned-up full episode in under 10 minutes, without leaving the app.

### Phase 4 — Audience, distribution, and platform integrations · **L**

| Item | Details |
| --- | --- |
| 4.1 Connected destinations (OAuth) | YouTube (create/schedule `liveBroadcasts`, title, description, thumbnail, privacy), Facebook Pages/Groups, LinkedIn, Twitch, X. Store tokens server-side, encrypted, with refresh. Remember destinations between sessions. |
| 4.2 Two-way chat | Reply to YouTube and Facebook chat as the channel or page from the unified chat. |
| 4.3 Hosted watch page | Branded viewer page with low-latency WHEP or LL-HLS, registration gating, native chat, Q&A, poll voting, reactions, and "bring viewer on stage" call-ins. |
| 4.4 Transactional email | Invites, registration confirmations, 24 h and 1 h reminders, and "recording ready" notices through a provider (e.g., Postmark, Resend, or SES). Replaces `mailto:` links. |
| 4.5 Pre-recorded "stream as live" | Schedule a finished video to air on connected destinations, with a live chat overlay. |
| 4.6 Publishing | Upload finished episodes and clips to YouTube and social platforms. Podcast RSS hosting for Spotify and Apple. |

### Phase 5 — Accounts, teams, and the business layer · **M–L** (can run in parallel with Phases 2–4)

| Item | Details |
| --- | --- |
| 5.1 Account lifecycle | Email verification, password reset, Google sign-in, active-session management, account deletion. |
| 5.2 Organizations and roles | Workspaces with owner, admin, producer, and host roles enforced server-side. Shared studios, brand kits, and recordings. Audit log. |
| 5.3 Quotas and plans (only if monetizing) | Recording hours, storage, and destination limits per plan, with Stripe billing. |
| 5.4 Privacy and compliance | Retention settings, data export and deletion, and a privacy policy updated for cloud recording. Align with the Philippine Data Privacy Act of 2012 (RA 10173) and GDPR for international guests. |

### Phase 6 — Differentiators (optional positioning)

Competing with StreamYard and Riverside on every axis is a long road. A focused niche can reach "better than" sooner. If the primary users are ministries and churches, strong differentiators would be:

- **Scripture overlays:** type a reference (e.g., "John 3:16, KJV") to show a styled verse lower third, plus a sermon-outline cue list that drives the teleprompter and overlays.
- **Song lyric slides** for worship segments, with the stream-safe licensing notice shown on screen.
- **Live multilingual captions for congregations,** building on the existing caption translation.
- **Service templates:** Sabbath School, Divine Service, Vespers, Midweek prayer, and Bible study scene packs built on the existing production scene packs.

---

## 8. Cross-cutting engineering track (continuous)

| Area | Action |
| --- | --- |
| E2E testing | Automate the existing browser fixtures with Playwright (Chromium with `--use-fake-device-for-media-stream`, plus WebKit) and run them in CI. |
| Load testing | Synthetic publishers and subscribers against the SFU and Egress on every media-plane release. |
| Code health | Continue decomposing `StudioRoom.tsx` and `RecordingPanel.tsx`. Target files under about 800 lines. |
| Bundle | Load `pptx-preview` and `pdfjs` only on first deck use. Prefer the media-server deck renderer when available. |
| Security | Server-side encrypted token storage (Phase 4), rotation of `LIVE_STREAM_TOKEN_SECRET`, and a dependency audit in CI. |
| Docs | Keep `IMPLEMENTATION_PLAN.md` as the feature inventory. Track parity progress against the scorecard in §9. |

---

## 9. Parity scorecard (definition of done)

| Metric | Target | Measured by |
| --- | --- | --- |
| Go-live success rate | ≥ 99% of attempts reach "live" on all destinations | Relay telemetry (Phase 0.8) |
| Destination drop recovery | Recovers within 10 s; other destinations unaffected | Fault-injection test (0.2, 0.4) |
| Host disconnect | Broadcast continues | Phase 1 exit test |
| On-screen capacity | 10 on-screen at 1080p30 output | Load test (1.6) |
| Guest track completeness | ≥ 95% of tracks in the cloud within 5 min of session end | Upload telemetry (2.1) |
| Track sync | ±1 frame across ISO tracks after 90 min | Export validation (2.5) |
| Long session stability | 4 h with no memory growth beyond budget, client or server | Soak test (2.7) |
| Clip turnaround | 60-second captioned vertical clip in < 10 min | Phase 3 exit test |
| Regression safety | 100% of suites plus E2E gate every deploy | CI (0.1) |

---

## 10. Decisions needed from the product owner

| Decision | Options | Recommendation |
| --- | --- | --- |
| Media infrastructure | LiveKit (self-hosted or cloud) · mediasoup + custom renderer · harden current stack | LiveKit, after the Phase 0 fixes |
| Hosting budget | Free tier (not viable for parity) · modest paid instances · managed cloud media | Paid instances plus managed Postgres and object storage at minimum |
| Product scope | General StreamYard/Riverside competitor · ministry-focused studio · personal production tool | Decide before Phase 4. It changes the priority of webinars, billing, and the Phase 6 differentiators. |
| Monetization | None · paid plans | Only build Phase 5.3 if monetizing |

---

## 11. Sources

Riverside. "Manually Pause or Resume a Participant's Track Upload in the Studio." Riverside Help Center. Accessed September 22, 2026. https://support.riverside.com/hc/en-us/articles/5286931478429-Manually-pause-or-resume-a-participant-s-track-upload-in-the-studio.

Riverside. "Pricing." Accessed September 22, 2026. https://riverside.com/pricing.

Render. "Deploy for Free." Render Docs. Accessed September 22, 2026. https://render.com/docs/free.

StreamYard. "Pricing." Accessed September 22, 2026. https://streamyard.com/pricing.

StreamYard Team. "Streaming Software Minimum Hardware Requirements for 2026 (And When StreamYard Is Enough)." StreamYard Blog, last updated January 10, 2026. https://streamyard.com/blog/streaming-software-minimum-hardware-requirements-2026.

StreamYard. "StreamYard Requirements." StreamYard Help Center. Accessed September 22, 2026. https://support.streamyard.com/hc/en-us/articles/360061299051-StreamYard-Requirements.
