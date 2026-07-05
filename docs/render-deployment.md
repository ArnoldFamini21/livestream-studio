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

For server-side platform chat ingestion in the studio Chat panel, set these on `livestream-studio-server` as needed:

```sh
YOUTUBE_API_KEY=<Google API key with YouTube Data API v3 access>
FACEBOOK_ACCESS_TOKEN=<Facebook Page/User access token with live video comment access>
```

Hosts and co-hosts paste a YouTube live chat ID or Facebook live video ID in the Chat panel. The signaling server polls YouTube's `liveChat/messages` endpoint and Facebook Graph API live video comments server-side, then relays imported comments into the existing public chat feed with platform badges so they can be starred, pinned, shown, or flashed on stream. Facebook polling defaults to 10 seconds and can be tuned with `FACEBOOK_COMMENTS_POLL_INTERVAL_MS`.

For production-grade WebRTC connectivity, configure a provider-backed TURN service on `livestream-studio-server`. The built-in OpenRelay fallback is useful for local demos, but it is not treated as production ready by the health metadata.

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

`/health` and `/api/ice-config` expose non-secret ICE readiness metadata. `ice.turnReady: true` means the signaling server is using configured TURN credentials rather than the fallback.

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

The RTMP relay also writes a server-side MP4 backup recording for every live session by default. The host/co-host client polls the media server after Go Live stops and exposes an authenticated backup download in the post-live notice. These backups are local to the media-server filesystem unless the service is deployed with persistent storage:

```sh
RTMP_BACKUP_RECORDING_ENABLED=true
RTMP_BACKUP_RECORDING_DIR=/tmp/livestream-studio-live-backups
RTMP_BACKUP_RECORDING_MAX_BYTES=8589934592
```

Set `RTMP_BACKUP_RECORDING_ENABLED=false` to disable this safety recording on constrained media-server instances.

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
