# Browser qualification

`npm run test:e2e` runs the built React app and signaling server with real
Chromium, fake camera/microphone devices, independent host/guest/viewer profiles,
and the CSP read directly from `client/public/.htaccess`. Only loopback HTTP and
WebSocket API origins are added to the production policy. No paid services or
production credentials are used. Non-local HTTP requests are blocked.

Build the local target first (all four variables keep optional media probes on
loopback; the signaling health response correctly marks media-server features
unavailable):

```sh
npm run -w shared build
npm run -w server build
VITE_API_URL=http://localhost:3001 VITE_WS_URL=ws://localhost:3001/ws \
  VITE_MEDIA_HTTP_URL=http://localhost:3001 VITE_MEDIA_WS_URL=ws://localhost:3001/rtmp \
  npm run -w client build
npm run test:e2e
```

On the owner's Mac, run each command through the workspace `.x9/run.sh` wrapper
with no login shell. The harness uses `/Applications/Google Chrome.app` directly,
with every profile, download, cache, log and screenshot under `output/e2e` (or
`E2E_ARTIFACT_DIR`). Profiles are unique to each run and removed at teardown.
`E2E_CHROMIUM_PATH` selects another installed Chromium executable. There is no
Playwright daemon or Unix socket on ExFAT. On Linux, install the pinned browser
with `npx playwright-core install --with-deps chromium`; CI does this before the
browser job. The browser dependency is development-only and adds no client
bundle bytes.

The suite checks admission and green-room media privacy, a playing backstage
program return, stage transition, watch-page voting, saved custom layouts,
portrait canvas dimensions, the server-confirmed talkback badge, a 30-second
recording with non-empty OPFS tracks, responsive screenshots, and explicit/tab
close departure timing. Assertions wait for application state and browser events;
there are no fixed UI sleeps. A failed scenario stops dependent scenarios, saves
the last screenshots/accessibility trees, and closes the test processes.

The owner gate is disabled only in the isolated test server's environment. The
suite does not alter production gates, TURN admission, or HMAC rules. It does not
qualify real cameras, hardware A/V synchronization, restrictive networks, TURN,
SFU capacity, RTMP, HLS playback, or Safari/mobile browser engines. The 390-wide
screenshots exercise responsive Chrome layout, not a physical phone.

For parallel local diagnostics, `startHarness` accepts `apiPort`, `port` and
`distDir`; build that directory with matching Vite endpoints. An explicitly set
`E2E_REUSE_SERVER=1` can share already-running local servers, but is rejected in
CI. CI always starts and verifies its own isolated server.

`npm run test:recording-soak` defaults to 20 minutes with three participants and
requires `ffprobe` on PATH (or `FFPROBE_PATH`). `SOAK_SECONDS=35` is a development
smoke run and reports `qualification: false`. The host picker returns a native
OPFS directory, so capture, folder writing and peer transfer use the production
paths. Passive copies of original chunks are compared byte-for-byte with host
files. Analysis checks encoded timestamps, gaps up to one second and A/V duration
drift below 40 ms; fixed initial offsets are reported separately. This does not
prove lip-sync with real hardware. See `e2e/recording-soak.mjs` for output and
parallel-build settings.

The existing CI workflow also has an optional `recording_soak` manual input.
It runs a 35-second preflight followed by the full 1,200-second qualification on
Linux. Both runs use real browser capture, native OPFS folder writes and RTC
transfer; the short run must pass before the long run starts. JSON, logs and
screenshots are retained for seven days; raw captures remain on the ephemeral
runner. This provides a repeatable Linux check when native Chrome OPFS on the
owner's ExFAT volume stalls. A green Linux result does not establish external
SSD throughput or qualify the owner's actual camera and network.

The former untracked `output/*.mjs` browser experiments used a stale absolute
checkout path. Their reusable persistent-browser, fake-media, snapshot and OPFS
inspection pieces now live here; `output/` is exclusively generated evidence.
