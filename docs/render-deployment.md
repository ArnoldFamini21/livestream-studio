# Render Deployment

The production stack uses Hostinger for the static client and Render for the two Node runtimes:

- `livestream-studio-server` for REST, signaling WebSocket, room state, and live-token issuance
- `livestream-studio-media-server` for RTMP relay, local recording uploads, and FFmpeg exports

`render.yaml` is the source of truth for both Render services.

## Required Render Services

Create or sync a Render Blueprint from this repository so both web services exist:

```sh
livestream-studio-server
livestream-studio-media-server
```

Both services must be connected to the default branch and use the commands from `render.yaml`.

## Required Environment

Set these values in Render:

```sh
CLIENT_URLS=https://studio.arnoldfamini.com
LIVE_STREAM_TOKEN_SECRET=<same random secret on both Render services>
DATABASE_URL=<Render PostgreSQL internal database URL for livestream-studio-server>
PGSSLMODE=require
```

The signaling server uses `DATABASE_URL` for PostgreSQL room snapshots and host-scoped recording catalog metadata. This keeps scheduled and newly created studios recoverable across Render restarts and lets hosts sync recording dashboard summaries across browser sessions. Recording blobs and export artifacts are not stored in this database; they stay in browser storage, media-server export storage, Google Drive handoffs, or S3-compatible artifact storage when configured. If `DATABASE_URL` is not set, the server logs that room snapshot persistence is disabled and continues with memory-only rooms and recording catalog metadata.

Toolbar recording coordinates device-local capture for every on-stage participant. The signaling server signs participant-scoped upload tokens with `LIVE_STREAM_TOKEN_SECRET`; the media-server verifies the same secret, groups completed uploads by room and recording session, and gives only a host/co-host token access to the combined MP4, isolated video, and audio-stem export. The secret must therefore match on both Render services.

The signaling server also supports optional transcription and ICE/TURN settings from `render.yaml`. Do not commit those secret values.

### Optional AI features (OpenAI)

Transcription, AI highlight clip suggestions, and AI show notes are all opt-in. Set an OpenAI API key on `livestream-studio-server` to enable them:

```sh
OPENAI_API_KEY=<OpenAI API key>
# Optional model overrides (sensible defaults are used when unset):
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_HIGHLIGHT_MODEL=gpt-4o-mini
OPENAI_EPISODE_CONTENT_MODEL=gpt-4o-mini
OPENAI_CAPTION_TRANSLATION_MODEL=gpt-4o-mini
```

These power the "Generate Transcript" (`/api/transcriptions`), "AI highlights" (`/api/highlights`), "AI Show Notes" (`/api/episode-content`), and "Translate VTT" caption translation (`/api/translate-captions`) actions in the recording and live-caption panels. When `OPENAI_API_KEY` is not set, each endpoint returns HTTP 503 and the studio falls back gracefully — clip suggestions still come from the offline marker/caption heuristics, and manual transcript/show-notes/translation generation is simply unavailable. No transcript or caption text is sent anywhere unless the key is configured and the host triggers the action.

For server-side platform chat ingestion in the studio Chat panel, set these on `livestream-studio-server` as needed:

```sh
YOUTUBE_API_KEY=<Google API key with YouTube Data API v3 access>
FACEBOOK_ACCESS_TOKEN=<Facebook Page/User access token with live video comment access>
```

Hosts and co-hosts paste a YouTube live chat ID or Facebook live video ID in the Chat panel. The signaling server polls YouTube's `liveChat/messages` endpoint and Facebook Graph API live video comments server-side, then relays imported comments into the existing public chat feed with platform badges so they can be starred, pinned, shown, or flashed on stream. Facebook polling defaults to 10 seconds and can be tuned with `FACEBOOK_COMMENTS_POLL_INTERVAL_MS`.

For production-grade WebRTC connectivity, configure a provider-backed TURN service on `livestream-studio-server`. Without one, guests who cannot connect directly, which includes most mobile and many home networks, cannot see or hear the host.

**Cloudflare (recommended).** Cloudflare Realtime TURN has a generous free allowance. In the Cloudflare dashboard, open **Realtime → TURN Server**, create a TURN key, and copy its key ID and API token into the server's environment:

```bash
CLOUDFLARE_TURN_KEY_ID=<turn key id>
CLOUDFLARE_TURN_API_TOKEN=<turn key api token>
```

The server requests 24-hour credentials from Cloudflare, reuses them for 12 hours, and drops the port-53 URLs that browsers block. If Cloudflare cannot be reached, it falls back to the configuration below. `/health` reports `ice.source: "cloudflare"`.

**Fallback.** With no TURN settings at all, the server uses Metered's free Open Relay (`staticauth.openrelay.metered.ca`) and mints short-lived credentials from its published secret. The old static `openrelayproject` password no longer works. The free relay is shared by everyone and capped at 20 GB a month, so it is not treated as production ready by the health metadata.

Use either a complete JSON config:

```sh
ICE_SERVERS_JSON='{"iceTransportPolicy":"all","iceServers":[{"urls":["stun:<provider-stun-host>:19302"]},{"urls":["turn:<provider-turn-host>:3478","turns:<provider-turn-host>:443"],"username":"<turn-user>","credential":"<turn-secret>","credentialType":"password"}]}'
```

Or split env vars:

```sh
STUN_URLS=stun:<provider-stun-host>:19302
TURN_URLS=turn:<provider-turn-host>:3478,turns:<provider-turn-host>:443
TURN_USERNAME=<turn-user>
TURN_CREDENTIAL=<turn-secret>
TURN_CREDENTIAL_TYPE=password
ICE_TRANSPORT_POLICY=all
```

**Ephemeral TURN credentials (recommended for coturn / providers that support the TURN REST API).** Instead of shipping a static `TURN_USERNAME`/`TURN_CREDENTIAL`, set a shared secret and the signaling server mints short-lived credentials per request using the coturn `use-auth-secret` scheme (username `<expiry-unix>:<user>`, credential = base64 HMAC-SHA1). This avoids exposing a long-lived password to clients:

```sh
STUN_URLS=stun:<provider-stun-host>:19302
TURN_URLS=turn:<provider-turn-host>:3478,turns:<provider-turn-host>:443
TURN_STATIC_AUTH_SECRET=<same secret configured on coturn: static-auth-secret>
TURN_CREDENTIAL_TTL_SECONDS=86400
ICE_TRANSPORT_POLICY=all
```

When `TURN_STATIC_AUTH_SECRET` and `TURN_URLS` are both set (and `ICE_SERVERS_JSON` is not), `/api/ice-config` reports `source: "turn_rest_secret"` and returns freshly generated credentials on every request. Configure coturn with a matching `static-auth-secret` and `use-auth-secret`.

`/health` and `/api/ice-config` expose non-secret ICE readiness metadata. `ice.turnReady: true` means the signaling server is using configured TURN credentials rather than the fallback.

### Production readiness and error reporting

The signaling server's `/health` includes `readiness`: `ready` is `false` while any **blocking** issue remains. Blocking issues are a missing database URL, a store that fell back to memory because Postgres was unreachable, a `LIVE_STREAM_TOKEN_SECRET` shorter than 32 characters, and a missing TURN configuration. A missing `CLIENT_URL` or `YOUTUBE_API_KEY` is only a warning. In production, each issue is also logged at startup. Set `PRODUCTION_STRICT=true` to make a production server exit at startup instead of serving traffic while a blocking issue remains.

Production browsers send uncaught errors, React crashes, failed live relays, and interrupted recording tracks to `POST /api/client-errors`. Before logging, the server strips query strings and fragments, which can carry invite and media tokens. Each report is logged as one `{"event":"client_error",...}` JSON line and counted in `/metrics` as `livestream_studio_client_errors_total{kind=...}`. Browsers fold repeats of the same error into one counted report and send at most 20 reports per page load. Set `VITE_CLIENT_ERROR_REPORTING=false` at build time to turn reporting off, or `true` to enable it in development builds. `VITE_RELEASE` tags each report with a build identifier.

### Account security and password reset email

Signed-in hosts can manage their account under **Settings & account**:

- **Change password.** Requires the current password and signs out every other device.
- **Where you're signed in.** Lists each device's browser, platform, last activity, and sign-in date. Any device can be signed out individually, or all devices except the current one at once.
- **Forgot password?** On the sign-in form, it emails a single-use link that expires after one hour. Using the link signs out every device and cancels every other outstanding link.

Reset requests never reveal whether an email has an account. The response is identical and is sent before the lookup. Each account receives at most three reset emails per hour.

To send password-reset emails and studio invites (the Invite panel's **Send invite**), set `ACCOUNT_EMAIL_FROM` to a sender verified with one of these providers, together with that provider's key:

```sh
ACCOUNT_EMAIL_FROM="Livestream Studio <studio@arnoldfamini.com>"
RESEND_API_KEY=<Resend API key>          # or
POSTMARK_SERVER_TOKEN=<Postmark server token>
```

Reset links point to `ACCOUNT_RESET_URL_BASE` if it is set, and otherwise to the first `CLIENT_URL`. They are never built from request headers. In production without a provider, the sign-in form explains that email reset is unavailable, and `/health` lists the `account-email-missing` warning. In development without a provider, the reset link is printed to the signaling server's console.

Sign-in, registration, password change, and reset endpoints are limited to 10 attempts per minute per IP address. On startup, the Postgres store adds the `last_seen_at` and `user_agent` session columns and the `studio_account_password_resets` table. Existing sessions stay valid.

### Live relay: one encode, bounded buffering

The media server encodes the studio's program once and shares the result with every destination. A single FFmpeg process encodes the browser's WebM to H.264/AAC FLV. Each destination then gets a lightweight copy-only FFmpeg process that pushes that FLV to its RTMP server. As a result, CPU cost no longer grows with the number of destinations.

- **A failed destination restarts on its own.** It rejoins the shared stream at the next keyframe without re-encoding and without interrupting the other destinations.
- **A crashed encoder restarts at most twice.** It resumes from the cached WebM header, and every destination reconnects to the new encode.
- **No input can queue more than about 6 seconds of media.** This applies to the encoder, each destination, and the live backup, which gets twice the allowance. A slow upload to one platform, or an overloaded encoder, now makes that input skip ahead to the live edge at a clean boundary (a WebM Cluster or an H.264 keyframe) instead of growing server memory and delaying viewers. The studio's destination card reports "falling behind; skipping ahead" and then "Caught up".
- **Monitoring.** `/metrics` exposes `livestream_studio_media_shared_encoders_total`, `livestream_studio_media_skipping_feeds_total`, and `livestream_studio_media_skip_events_total`. `/health` reports `capabilities.liveRelay`.

Set `RTMP_ENCODE_ONCE=false` to return to one full encode per destination. The byte limits still apply in that mode.

The media server can also copy recording export artifacts to S3-compatible object storage. Set these on `livestream-studio-media-server` when durable recording handoff is needed:

```sh
RECORDING_STORAGE_ENDPOINT=<S3-compatible endpoint>
RECORDING_STORAGE_REGION=us-east-1
RECORDING_STORAGE_BUCKET=<bucket name>
RECORDING_STORAGE_ACCESS_KEY_ID=<access key>
RECORDING_STORAGE_SECRET_ACCESS_KEY=<secret key>
RECORDING_STORAGE_FORCE_PATH_STYLE=true
RECORDING_STORAGE_PREFIX=livestream-studio
RECORDING_STORAGE_PUBLIC_BASE_URL=<optional CDN/public base URL>
```

The export job still streams downloads from the media server, but job status and manifest JSON include the durable `s3` bucket/key for every uploaded artifact.

Files larger than 100 MB are uploaded in 64 MB parts (S3 multipart upload), because single uploads are capped at 5 GiB and a one-hour export at the default 12 Mbps is about 5.4 GB. A failed part aborts the upload, so no partial parts are left billing. `/health` reports `capabilities.recordingStorage.ready`, and Session Health warns when storage is not configured.

**Cloudflare R2 (recommended; 10 GB-month free, no download fees).** In the Cloudflare dashboard, create an R2 bucket, then create an R2 API token with **Object Read & Write** on that bucket. Use the S3 endpoint shown with the token:

```sh
RECORDING_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
RECORDING_STORAGE_REGION=auto
RECORDING_STORAGE_BUCKET=livestream-studio-recordings
RECORDING_STORAGE_ACCESS_KEY_ID=<R2 access key id>
RECORDING_STORAGE_SECRET_ACCESS_KEY=<R2 secret access key>
RECORDING_STORAGE_FORCE_PATH_STYLE=true
RECORDING_STORAGE_PREFIX=livestream-studio
```

Live backup recordings (below) are copied here too.

The RTMP relay also writes a server-side MP4 backup recording for every live session by default. The host/co-host client polls the media server after Go Live stops and exposes an authenticated backup download in the post-live notice. When object storage is configured, each finished backup is uploaded to `<prefix>/rooms/<room>/live-backups/`, with a small record under `<prefix>/live-backups/<backupId>.json` so it can be found after a restart or sleep. The local copy is then deleted, and **Download Backup** fetches a one-hour presigned link and downloads straight from the bucket. Without object storage, backups stay on the media-server filesystem and are lost on restart unless the service has persistent storage:

```sh
RTMP_BACKUP_RECORDING_ENABLED=true
RTMP_BACKUP_RECORDING_DIR=/tmp/livestream-studio-live-backups
RTMP_BACKUP_RECORDING_MAX_BYTES=8589934592
```

Set `RTMP_BACKUP_RECORDING_ENABLED=false` to disable this safety recording on constrained media-server instances.

## Public watch page

Every studio has a public watch page at `https://studio.arnoldfamini.com/watch/<room id>` (the Invite panel shows the link). While the host is live, the media server writes the shared H.264/AAC encode as HLS (2-second segments, a rolling 6-segment playlist, no re-encode) under `HLS_OUTPUT_DIR` (default: the temp folder) and serves it at `/watch/<room id>/status`, `/watch/<room id>/stream.m3u8`, and the segments. The page plays it with hls.js (Safari plays HLS natively), shows LIVE with a viewer estimate (distinct addresses that fetched the playlist in the last 20 s), and reports when the broadcast ends. Segments are deleted 15 s after the session stops. When the studio has registration enabled, viewers register (name and email) before the player appears, and they show up in the host's registrant list. Latency is about 6-10 s. The watch page needs encode-once mode (the default); with `RTMP_ENCODE_ONCE=false` it stays "Not live".

## Static Client CDN Caching

The Hostinger client deploy includes `client/public/.htaccess`, which is copied into `client/dist` by Vite. It sets:

- HTML/SPA responses: `Cache-Control: no-cache, no-store, must-revalidate` so browsers discover new deploys promptly
- hashed build assets under `assets/`: `Cache-Control: public, max-age=31536000, immutable` without `Expires: 0` so JS/CSS chunks can be cached at CDN/browser edge for one year
- SPA rewrites back to `index.html` for deep studio and join links

After a static deploy, verify the cache contract with:

```sh
PRODUCTION_CHECK_SCOPE=client \
PRODUCTION_REQUIRE_CLIENT_CACHE=true \
npm run production:check
```

The static Hostinger deploy verifies client cache headers without requiring the Render media-server. PDF uploads can still render in the browser when Render is unavailable. PowerPoint design preservation requires the media-server exact renderer, except for modern PPTX decks that already contain full-slide image artwork. Legacy PowerPoint/Keynote files always require the media-server. MP4 export, backup recordings, RTMP relay, and durable recording handoff also remain media-server features.

## GitHub Deploy Hooks

The Hostinger workflow builds all workspaces and deploys the client to the `deploy` branch. To make the same merge trigger Render deploys, create deploy hooks in Render for both web services and add these GitHub repository secrets:

```sh
RENDER_SERVER_DEPLOY_HOOK_URL=<deploy hook URL for livestream-studio-server>
RENDER_MEDIA_SERVER_DEPLOY_HOOK_URL=<deploy hook URL for livestream-studio-media-server>
```

Client-only merges can still deploy the static Hostinger bundle without Render hooks. If a merge changes `server/`, `media-server/`, `shared/`, root package files, or `render.yaml`, the workflow now requires the matching Render deploy hook secret and fails before publishing when it is missing. This prevents backend fixes from appearing green while Render is still serving an older build.

Every deploy verifies the static client cache headers after publishing to Hostinger. When service files changed and the required deploy hook secrets are present, the workflow also waits for Render service verification after the Hostinger deploy. It runs `npm run production:check` with the pushed commit SHA and polls for up to 15 minutes until the changed Render services report the new commit in `/health`, including the media-server exact deck-renderer capability.

The Render service verification also creates a disposable studio and requires the signaling API to return a valid private `hostToken`. This catches the production failure where the home page reports that a studio was created but host access was not returned.

### Manual Render Redeploy

If Hostinger is current but Render is stale, run the **Build and Deploy to Hostinger** workflow manually from GitHub Actions. Use these inputs:

- `deploy_client`: publish the Hostinger client again. Leave this on for a normal full deploy; turn it off for service-only recovery.
- `deploy_signaling`: trigger the `livestream-studio-server` Render deploy hook.
- `deploy_media`: trigger the `livestream-studio-media-server` Render deploy hook.
- `verify_services`: wait for Render `/health`, commit metadata, and create-studio host access verification.

For the current production drift pattern, run a manual dispatch with:

```txt
deploy_client=false
deploy_signaling=true
deploy_media=true
verify_services=true
```

That run requires both Render deploy hook secrets and the workflow checks for them before installing dependencies or building workspaces. It will fail if the media-server has not been created/synced in Render, if the signaling service still serves the old `{ "status": "ok" }` health payload, or if create-studio responses still omit private host access.

## Production Smoke Check

After Render deploys finish, run:

```sh
npm run production:check
```

For a specific commit:

```sh
EXPECTED_COMMIT=$(git rev-parse HEAD) npm run production:check
```

To wait for a deploy to finish:

```sh
EXPECTED_COMMIT=$(git rev-parse HEAD) \
PRODUCTION_CHECK_WAIT_MS=900000 \
PRODUCTION_CHECK_INTERVAL_MS=15000 \
npm run production:check
```

The check verifies:

- `https://studio.arnoldfamini.com` serves a built client bundle
- client HTML and hashed assets send CDN-ready cache headers when `PRODUCTION_REQUIRE_CLIENT_CACHE=true`
- `https://livestream-studio-server.onrender.com/health` reports `service: "signaling-server"`
- `https://livestream-studio-media-server.onrender.com/health` reports `service: "media-server"`
- both services report the expected deployment commit when `EXPECTED_COMMIT` is set
- create-studio responses include valid private host access when `PRODUCTION_REQUIRE_HOST_ACCESS=true`

Use `PRODUCTION_CHECK_SCOPE=client` to check only the Hostinger client, or `PRODUCTION_CHECK_SCOPE=services` to check only Render health metadata.

To fail the check unless production TURN credentials are configured:

```sh
PRODUCTION_REQUIRE_TURN=true npm run production:check
```

To verify the create-studio host access contract specifically:

```sh
PRODUCTION_CHECK_SCOPE=services \
PRODUCTION_REQUIRE_HOST_ACCESS=true \
npm run production:check
```

In GitHub Actions, set the repository variable `PRODUCTION_REQUIRE_TURN=true` after the Render TURN credentials are present. The workflow passes that value into the production smoke check.

If the media-server returns Render `no-server`, the Render service has not been created or synced yet. If the signaling server returns only `{ "status": "ok" }`, Render is still running an older server build.
