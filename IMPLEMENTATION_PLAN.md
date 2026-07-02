# LiveStream Studio — Full Implementation Plan
## Goal: Feature parity with StreamYard + Riverside.fm

---

## Phase 1: Recording Engine (Priority: Critical)
### 1A. Local-First Per-Participant Recording (Riverside approach)
- [x] MediaRecorder API per participant capturing local camera/mic in high quality
- [x] Record as WebM (VP9/Opus) locally, then upload chunks to server via WebSocket/HTTP
- [x] Media-server authenticated WebM upload sessions with bounded per-track chunk intake
- [x] Client-side media-server handoff for completed local WebM tracks via bounded HTTP chunks
- [x] Separate isolated audio tracks (WAV) + video tracks per participant
- [x] Server-side stitching with FFmpeg into final MP4 (H.264 + AAC)
- [x] Media-server FFmpeg export command builders for MP4 stitching plus WAV/MP3 stems
- [x] Media-server export manifest artifact for MP4/stem handoff review
- [x] Per-track capture metadata in local recording bundles for ISO/audio/program alignment
- [x] Browser-side recording quality reports in editor and podcast ZIP exports
- [x] Recording indicator (red dot + timer) in the header and producer controls
- [x] Host/co-host record start/stop controls with guests blocked from recording surfaces

### 1B. 4K Recording Optimization
- [x] Manual capture quality presets: 720p/1080p/4K
- [x] Adaptive hardware capability detection and automatic quality recommendation
- [x] Browser encoding readiness checks for 720p/1080p/4K capture presets
- [x] Recording preflight warns or blocks based on browser encoding readiness
- [x] WebCodecs hardware acceleration readiness probe for 1080p/4K presets
- [x] WebCodecs video encoder core with bounded chunk capture and recording pipeline metadata
- [x] Use hardware-accelerated WebCodecs encode pipeline where available
- [x] Chunked upload with resume support for large 4K files
- [x] Server-side S3-compatible storage integration
- [x] Export pipeline: MP4 (H.264/H.265), separate WAV/MP3 audio stems

### 1C. Screen Recording
- [x] getDisplayMedia() for screen/window/tab sharing
- [x] Record screen share as a separate track
- [x] Picture-in-picture: camera overlay on screen share

---

## Phase 2: Studio Layout Compositor (Priority: Critical)
### 2A. Canvas-Based Compositor
- [x] OffscreenCanvas rendering pipeline compositing all video feeds with capture-canvas fallback
- [x] Layout presets: Grid, Spotlight, Side-by-Side, Picture-in-Picture, Solo
- [x] Smooth CSS transitions when switching layouts (300ms ease)
- [x] Drag-and-drop participant reordering within the grid
- [x] Click-to-spotlight: click a participant to make them the main feed

### 2B. Scene System (OBS-style)
- [x] Scene manager: create/name/reorder scenes
- [x] Each scene has its own layout + overlay configuration
- [x] One-click scene switching with crossfade transition
- [x] "Starting Soon", "BRB", "Ending" built-in scene templates
- [x] One-click production scene pack for a full show flow
- [x] Scene preview thumbnails in the sidebar

---

## Phase 3: Overlay System (Priority: High)
### 3A. Lower Thirds
- [x] Animated slide-in lower thirds with name + title
- [x] Multiple style presets (minimal, bold, gradient, glassmorphism)
- [x] Custom colors, font presets, and animation presets
- [x] Animation direction controls
- [x] Auto-show when participant speaks (optional)
- [x] Timed display (auto-hide after N seconds)

### 3B. Logos & Branding
- [x] Upload custom logo — position anywhere on canvas (drag-and-drop)
- [x] Watermark mode (semi-transparent, corner-locked)
- [x] Custom background images/videos for scenes
- [x] Brand color theme that skins the entire studio

### 3C. Text Banners & Tickers
- [x] Static text banners (breaking news style)
- [x] Scrolling ticker tape
- [x] Countdown/count-up timer overlay
- [x] Custom HTML overlay support (iframes for widgets)

---

## Phase 4: RTMP Live Streaming (Priority: High)
### 4A. Server-Side FFmpeg Relay
- [x] Capture composite canvas as MediaStream
- [x] Stream canvas frames + mixed audio to server via WebSocket
- [x] Server-side FFmpeg transcodes and pushes RTMP to destinations
- [x] Go Live preflight warns or blocks based on browser encoder readiness
- [x] Authoritative live elapsed timer in the studio header
- [x] Configurable output: 720p/1080p/1080p60/4K30 bitrate presets with preflight warnings and FFmpeg relay bounds

### 4B. Multi-Destination Streaming
- [x] YouTube Live RTMP integration (stream key input)
- [x] Facebook Live RTMP integration
- [x] Custom RTMP URL support (Twitch, LinkedIn, etc.)
- [x] Simultaneous multi-stream to up to 3 destinations
- [x] Per-destination enable/disable toggle

### 4C. Stream Health Dashboard
- [x] Real-time bitrate graph
- [x] Estimated dropped frames counter
- [x] Connection quality indicator (green/yellow/red)
- [x] Per-destination stream status (connected/buffering/error)
- [x] Relay round-trip latency display
- [x] Auto-reconnect on stream drop
- [x] Post-live summary with duration and destination outcome

---

## Phase 5: Guest & Participant Management (Priority: High)
### 5A. Invite System
- [x] Shareable join links with room name embedded
- [x] Optional password-protected rooms
- [x] Email invite with magic link
- [x] QR code for mobile guests

### 5B. Green Room / Waiting Room
- [x] Guests land in green room by default
- [x] Camera/mic preview and device test in green room
- [x] Host sees list of waiting guests with admit/deny buttons
- [x] Bulk admit all
- [x] "You're next" notification for waiting guests

### 5C. On-Stage Management
- [x] Host can move guests between: Green Room → On-Stage → Backstage, including hold-to-green-room controls
- [x] Mute/unmute individual participants (host power)
- [x] Remove participant from session
- [x] Spotlight participant (make them the main feed) from stage, Producer Mode, and People controls
- [x] Reorder participant display order with stage-order controls

### 5D. Backstage
- [x] Private audio/video channel for host + selected guests
- [x] Backstage participants invisible to stream/recording
- [x] Backstage text chat

---

## Phase 6: Chat & Audience Interaction (Priority: Medium)
### 6A. Built-In Chat
- [x] Real-time WebSocket chat panel (host + guests), including scoped typing indicators
- [x] Chat message animations (slide in from right)
- [x] Emoji reactions
- [x] Pin messages
- [x] Private messages between host and individual guests

### 6B. Live Chat Integration
- [x] YouTube Live Chat API integration (read incoming messages)
- [x] Facebook Live Comments API integration
- [x] Unified chat view merging all platforms
- [x] Highlight/feature a chat message on screen (overlay)
- [x] Animated comment pop-up on stream (StreamYard-style)

### 6C. Audience Engagement
- [x] Live polls (host creates, audience votes via chat commands)
- [x] Q&A queue (audience submits, host picks to display)
- [x] On-screen audience comment flashing with animations
- [x] Reaction overlays (hearts, claps, fire floating up)

---

## Phase 7: Audio Processing (Priority: Medium)
### 7A. Per-Participant Audio Controls
- [x] Individual volume sliders
- [x] Real-time audio level meters (VU meters)
- [x] Noise suppression (browser mic processing controls)
- [x] Echo cancellation tuning (live mic processing controls)
- [x] Audio ducking (lower others when someone speaks)

### 7B. Audio Mixing
- [x] Background music player (upload MP3/WAV, play during stream)
- [x] Sound effects board (applause, drum roll, airhorn, custom)
- [x] Separate stream/monitor routing for producer audio
- [x] Fade in/out controls for music

---

## Phase 8: Advanced Recording Features (Priority: Medium)
### 8A. Multi-Track Export
- [x] Individual ISO recordings per participant (video + audio)
- [x] Combined mix-down recording
- [x] Separate screen share recording
- [x] Audio-only export (podcast ZIP with isolated audio tracks, WAV stems when supported, captions, and markers)
- [x] Transcript generation (speech-to-text via Whisper API)

### 8B. Recording Management
- [x] Recording dashboard: list all past recordings
- [x] Playback preview in browser for saved recording tracks
- [x] Download individual tracks and session ZIP bundles
- [x] Recording completion summary with duration, tracks, markers, and storage
- [x] Google Drive handoff uploads original tracks plus editor/podcast ZIP bundles
- [x] Cloud storage with expiry / permanent options
- [x] Share recording link

---

## Phase 9: Polish & Production Features (Priority: Lower)
### 9A. Transitions & Animations
- [x] Scene transition effects: crossfade, wipe, slide, zoom
- [x] Participant join/leave animations
- [x] Lower third entrance/exit animations (slide, fade, bounce)
- [x] Stinger transitions (custom video overlay during switch)

### 9B. Virtual Backgrounds
- [x] Background blur (TensorFlow.js / MediaPipe)
- [x] Virtual background images
- [x] Custom uploaded background
- [x] Green screen chroma key

### 9C. Studio Customization
- [x] Custom studio themes (light, dark, colorful)
- [x] Brand kit: upload logo, set colors, auto-apply everywhere
- [x] Custom waiting room page with branding
- [x] Custom stream starting/ending screens

### 9D. Production Safety
- [x] Browser exit warning while live streaming or recording

---

## Phase 10: Infrastructure & Scale (Priority: Ongoing)
### 10A. Database & Auth
- [ ] PostgreSQL: users, rooms, recordings, sessions
- [ ] Auth: email/password registration, magic links for guests
- [x] Local user dashboard: manage saved studios, local recordings, and brand assets in-browser
- [x] Portable workspace backup/import for saved studios, brand kits, and recording catalog metadata
- [ ] Account-backed user dashboard: manage studios, recordings, and brand assets across devices
- [ ] Team/organization support

### 10B. Media Server (SFU)
- [ ] Replace mesh WebRTC with mediasoup/LiveKit SFU for 5+ participants
- [ ] Simulcast: send multiple quality layers, server selects best for each viewer
- [x] Client WebRTC sender simulcast encodings for camera/screen mesh connections
- [x] Bandwidth adaptation per participant for current mesh WebRTC senders
- [x] Server-side recording as backup

### 10C. Deployment
- [x] Docker Compose for local dev
- [x] Kubernetes manifests for production
- [x] CDN for static assets
- [x] GitHub Actions builds client, signaling server, and media-server workspaces
- [x] Optional GitHub Actions deploy hooks for Render signaling and media-server services
- [x] Production smoke command verifies Hostinger client plus Render service health metadata
- [x] GitHub Actions waits for Render service health metadata when deploy hooks are configured
- [x] Configurable STUN/TURN ICE config endpoint for WebRTC connectivity
- [ ] Global TURN servers for reliable connectivity (production provider credentials)
- [x] Prometheus-compatible `/metrics` endpoints for signaling and RTMP relay health
- [x] Grafana dashboards and alerting for stream health metrics

---

## Implementation Priority Order
1. **Phase 2A** — Layout compositor (visual impact, core UX)
2. **Phase 1A** — Local recording engine
3. **Phase 3A** — Lower thirds overlays
4. **Phase 5B** — Green room
5. **Phase 4A** — RTMP streaming
6. **Phase 6A** — Built-in chat
7. **Phase 6C** — Animated comment overlays
8. **Phase 7A** — Audio controls & meters
9. **Phase 4B** — Multi-destination streaming
10. **Phase 3B+C** — Full overlay system
11. **Phase 5C+D** — Stage management & backstage
12. **Phase 8** — Advanced recording & export
13. **Phase 9** — Transitions, virtual backgrounds
14. **Phase 10** — Infrastructure & scale
