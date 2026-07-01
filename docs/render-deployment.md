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
```

The signaling server also supports optional transcription and ICE/TURN settings from `render.yaml`. Do not commit those secret values.

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

## Static Client CDN Caching

The Hostinger client deploy includes `client/public/.htaccess`, which is copied into `client/dist` by Vite. It sets:

- HTML/SPA responses: `Cache-Control: no-cache, no-store, must-revalidate` so browsers discover new deploys promptly
- hashed build assets under `assets/`: `Cache-Control: public, max-age=31536000, immutable` so JS/CSS chunks can be cached at CDN/browser edge for one year
- SPA rewrites back to `index.html` for deep studio and join links

After a static deploy, verify the cache contract with:

```sh
PRODUCTION_CHECK_SCOPE=client \
PRODUCTION_REQUIRE_CLIENT_CACHE=true \
npm run production:check
```

## GitHub Deploy Hooks

The Hostinger workflow builds all workspaces and deploys the client to the `deploy` branch. To make the same merge trigger Render deploys, create deploy hooks in Render for both web services and add these GitHub repository secrets:

```sh
RENDER_SERVER_DEPLOY_HOOK_URL=<deploy hook URL for livestream-studio-server>
RENDER_MEDIA_SERVER_DEPLOY_HOOK_URL=<deploy hook URL for livestream-studio-media-server>
```

When these secrets are missing, GitHub Actions still deploys the static client but logs notices that the Render deploy triggers were skipped.

Every deploy verifies the static client cache headers after publishing to Hostinger. When both deploy hook secrets are present, the workflow also waits for Render service verification after the Hostinger deploy. It runs `npm run production:check` with the pushed commit SHA and polls for up to 15 minutes until both Render services report the new commit in `/health`.

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

Use `PRODUCTION_CHECK_SCOPE=client` to check only the Hostinger client, or `PRODUCTION_CHECK_SCOPE=services` to check only Render health metadata.

To fail the check unless production TURN credentials are configured:

```sh
PRODUCTION_REQUIRE_TURN=true npm run production:check
```

In GitHub Actions, set the repository variable `PRODUCTION_REQUIRE_TURN=true` after the Render TURN credentials are present. The workflow passes that value into the production smoke check.

If the media-server returns Render `no-server`, the Render service has not been created or synced yet. If the signaling server returns only `{ "status": "ok" }`, Render is still running an older server build.
