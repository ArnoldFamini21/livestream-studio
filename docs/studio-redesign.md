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
