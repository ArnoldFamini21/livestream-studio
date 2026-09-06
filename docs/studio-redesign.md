# Workspace and studio redesign

The workspace now separates studios, recordings, brand kits, team, and account settings. Creation begins with two fields; scheduling, passwords, and registration are available in a disclosure. Studio cards expose entry and guest links, with preparation sheets, QR codes, calendar downloads, private host links, and removal in a secondary menu.

The studio opens with its stage visible and the six tool panels collapsed. A searchable tools menu groups production, audience, and audio tools, including aliases such as “script” for Teleprompter. Brand settings use individual disclosures. Mobile panels overlay the stage; the control bar wraps without hiding production actions. Guest preparation retains device selection and moves advanced audio options into a disclosure.

## Functional changes

- Cloud recordings, brand kits, and team catalogs load when their section is opened, reducing unnecessary API requests.
- Workspace views use URL query parameters, supporting reload and browser history.
- Studio search and upcoming filtering operate on the existing merged studio catalog.
- The recordings and brand pages show the full catalogs instead of truncating them to three and four items. Local recording tracks can be downloaded from the workspace as a ZIP.
- A solo grid participant gets one full-width column. Previously the fallback formula assigned two columns to a count of one.
- Offline program recordings now activate the canvas compositor. Previously only a live broadcast activated it, allowing an audio-only program file when recording without going live.
- The record button distinguishes the local program recorder, an existing shared session after rejoining, and standalone local tracks. It no longer tries to start a second recording when the shared session is active. Shared pause state is reflected in the toolbar.
- Studio and guest-entry routes load on demand, reducing the initial workspace entry bundle.
- Native dialogs provide focus containment, Escape handling, and focus restoration for studio creation and the scheduled invite.

## Competitive reference and limits

References checked September 6, 2026:

- [StreamYard product](https://streamyard.com/): browser guest production, multistreaming, branding, local isolated recording.
- [StreamYard layouts](https://support.streamyard.com/hc/en-us/articles/13828085960724-Custom-Layouts): configurable broadcast composition.
- [Riverside product](https://riverside.com/product): local recording, editing, transcription, content repurposing, and studio production.

This change improves the product experience and fixes recording/layout defects; it is not evidence of complete feature or reliability parity. The existing code includes multistream destinations, isolated recording, scenes, chat, captions, polls, Q&A, producer tools, and export integrations. Production parity still requires:

1. Configured and verified PostgreSQL persistence, object storage, TURN, media-server capacity, and recovery across browser/network/server failures.
2. End-to-end real-destination tests with authorized YouTube/Facebook/other platform credentials and a supported browser matrix.
3. Multi-user organization permissions and account lifecycle features beyond the current production roster.
4. Quality and long-session testing of transcription, translation, clipping, synchronized isolated tracks, and final exports. An implementation checkbox is not a service guarantee.
5. API budget and dependency audits under realistic workspace sizes and concurrent users.

The local development services are available at `http://localhost:5173` (client), port 3001 (signaling/API), and port 3002 (media). This change does not configure production credentials or publish a live broadcast.

## Validation

- All four workspace production builds pass. Vite still reports large studio and document-preview chunks.
- Client suite: 671 passing tests, including regressions for solo layout, shared recording actions, pause status, and offline compositor activation.
- Browser checks cover studio creation, scheduling, search/filtering, workspace history, tool search and Escape focus restoration, brand disclosures, and mobile layouts. Workspace sections fit a 390px viewport.
- Synthetic camera/microphone checks cover recording start, pause, resume, stop, and rejoining an active session. The offline fallback MP4 contains H.264 1920×1080 video and AAC audio; the local-track ZIP contains two nonempty tracks.
- A successful server-processed final MP4 remains unverified after the compositor fix: local testing encountered media-token timeouts and API throttling during repeated reloads. Development server restarts also invalidate rooms when persistence is not configured. These results do not establish production reliability.

## Minimal entry and overlay controls

The entry screen now pairs a large camera preview with a short name-and-entry form. Device selectors, video quality, speaker testing, and audio processing are available in one keyboard-accessible Camera & audio dialog. The mobile layout stacks these two areas without the old long settings form. Passwords, registration, scheduled entry restrictions, and host-access recovery remain conditional on the existing access rules.

The Overlays panel now has one Add overlay action and a compact unified list. Each row exposes Show/Hide, with editing, removal, and timer actions in a secondary menu. Creating or editing opens a focused form with appearance controls collapsed. Preset packs, speaker names, automatic naming, and chat highlights are available under Overlay options. Edits preserve overlay IDs and visibility; unchanged timer configurations preserve elapsed/running state.

Validation: client typecheck/build and 671 existing tests pass. Codex in-app browser checks cover desktop and 390px entry layouts, quality changes, dialog Escape/focus restoration, blank-name validation, studio entry, banner creation/visibility/editing, and timer start/edit/pause. The narrow overlay panel remains usable without horizontal scrolling. Tests used a local studio with camera/microphone disabled for visual captures; no broadcast was started.

## Media library and playback

Media now opens as one library with a single Add media action. Uploading and direct-link entry share one focused view; drag-and-drop accepts mixed files. Individual items have thumbnails, private previews, and a Show action, with removal in an options menu. Search appears for larger libraries. On-stage media exposes Stop sharing; presentations have compact previous/next/jump controls and an optional presenter view with the next slide, notes, and thumbnails. A slide selected in private preview is the slide shown on stage. Slide images use contain sizing, preserving the entire page.

Media preparation verifies images/videos are decodable and permits remote media only after an anonymous-CORS load succeeds. Failed items retain actionable errors; supported files in a mixed batch remain usable. Decks are rendered sequentially, with file-size/format checks and browser PDF/PPTX fallbacks. Keynote users are directed to export PDF/PPTX. Library limits no longer silently evict previous media, and unfinished URL probes are not restored as permanently processing after reload.

Shared video now feeds the existing broadcast audio bus once for monitoring and recording. Stage media and the compositor use the same successfully loaded CORS media, including remote video. Playback errors return to the camera stage instead of leaving unreadable media on air. Removing a clip disconnects its audio route.

Validation: 688 client tests pass, including media URL validation, decode/CORS failures and timeouts, format/size/capacity checks, audio route reuse/cleanup, and compositor eligibility. Client production build/typecheck pass. Codex browser checks cover mixed SVG/MP4/PDF/unsupported-file upload, private previews, selected-page presentation, previous/next/jump controls, presenter disclosure, invalid video-page links, and the narrow layout. A 20-second local test recording with microphone/camera disabled produced a server-exported 1920×1080 H.264 + AAC MP4; the exported frame contains the synthetic clip and audio is non-silent (mean -22.5 dB). This verifies local program export, not live delivery to external streaming destinations.

## Conversation-focused chat

Chat now uses a compact channel selector, a conversation list, and one composer. The duplicate heading, five-tab strip, always-visible platform forms, and inactive metrics have been removed from the main conversation. Connections, scoped transcript export, and pop-out access are available from Chat options. YouTube and Facebook setup lives in a separate view, with one expandable row per platform and connection errors surfaced when relevant.

Messages share one presentation across studio, guest, backstage, and pop-out views. Reactions and host broadcast controls are grouped under each message's options; only active reaction counts remain visible. Pinning, starring, persistent featuring, brief featuring, and public/private/backstage scopes retain their existing signaling. Private and backstage messages cannot expose broadcast actions.

Drafts are separate for public, backstage, and each direct recipient. Direct conversations and exports are scoped to the selected participant; a departed recipient disables sending and preserves the draft. The StudioRoom send handler also rejects missing recipients, preventing a private message from falling back to public chat. Social and starred views are explicitly read-only. Composers enforce the server's 2,000-character limit and avoid sending during IME composition. Incoming messages preserve the reading position; studio chat offers a New messages action when scrolled away from the bottom.

Validation: 699 client tests pass, including direct-recipient loss, channel/draft separation, transcript privacy, message limits, and private-message broadcast-action guards. Client production build/typecheck pass. Codex browser checks cover sending, reactions, starring, pinning, stage featuring/dismissal, platform setup disclosure, channel switching, draft retention, and a 390px layout with no horizontal overflow. A temporary local WebSocket guest received the selected direct message; disconnecting it disabled sending while keeping the unsent private draft. Live platform connections require authorized destination credentials and were not exercised. Codex did not expose the requested pop-out window as a controllable tab, so pop-out behavior has code/type validation but no end-to-end browser verification in this pass.

## Fixed broadcast canvas

The stage previously combined full available width with a capped height. Closing a sidebar changed its measured ratio from about 1.82 to 2.41 in a 1440×810 viewport, while the camera tile grew beyond the visible stage and was clipped. The compositor also derived output placement from those distorted bounds.

The studio now lays out its complete composition on a fixed 960×540 logical surface and uniformly scales that surface to fit the available width and height. This preserves the 16:9 frame, camera crop, layout spacing, and graphics when panels open, panels close, or the window resizes. A ResizeObserver updates preview scale without reflowing broadcast content. A temporarily hidden viewport retains its last valid scale. The logical size matches the scale of the existing authored graphics; program output remains 1920×1080.

The compositor distinguishes transformed DOM coordinates from logical CSS sizes, keeping logo dimensions, margins, name-tag padding, and media corners independent of preview scale. Comment and poll widths now refer to their stage container instead of the browser viewport.

Validation: 706 client tests pass and the client production build/typecheck passes. New regressions cover the original height-limited sidebar case, narrow/short viewports, unchanged normalized graphics and camera crop, logo dimensions, and invalid measurements. Codex browser checks cover all six side panels, camera-tile geometry, shared media, and 1440×810, 940×640, and 390×844 viewports. The 390px layout has no horizontal page overflow. A fresh local room produced a 35.795-second H.264/AAC 1920×1080 export while the sidebar and viewport were changed. All four corners of the synthetic chart remain visible; frames at 5 and 30 seconds have SSIM 0.999986, and frames at 16 and 30 seconds have SSIM 0.999999. Camera and microphone were disabled for this recording. No external live broadcast was started.

### Camera framing follow-up

Normal camera tiles now contain the complete source frame; only explicitly selected square/circular masks crop. Videos are positioned inside their tile instead of contributing intrinsic layout size. Stage fitting reads the untransformed ResizeObserver content box, with size/layout containment on the viewport. The compositor rejects its output stream (including another stream wrapping the same track) and marked debug monitors as inputs.

Validation: 708 client tests and production client build pass. A live 1280×960 synthetic camera preserved all four corner markers through narrowing/widening the preview, with a fixed 960×540 logical stage and 1920×1080 output. A deliberately enlarged output monitor inside the stage did not introduce feedback. A 19.6-second VP8 recording remained 1920×1080; frames near 2 and 18 seconds compared at SSIM 0.999129. The continuous zoom reported by the user was not reproduced in a freshly loaded local camera session with its virtual background enabled, so no unverified root cause is claimed.

## Simplified scenes

Scenes now opens with one Add scene action and compact thumbnail rows. The selected scene is indicated in its row. Naming and templates appear only when adding a scene; transitions, stinger video setup, and import/export are under Scene settings. Each row's options retain rename, update from stage, duplicate, reorder, and delete. The redundant director board, repeated save controls, and always-visible template/transition grids are removed.

Validation: all 708 client tests and the production build/typecheck pass. An isolated local preview of the actual SceneManager in the Codex browser covered creation, templates/show pack, switching, renaming, duplication, reordering, transition URL validation, save-failure retry, and the 12-scene limit. Panels at 240px and 320px remained within their bounds, including long names and expanded settings. The user's production studio was not modified during these checks.
