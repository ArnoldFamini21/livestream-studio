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

## GitHub Deploy Hooks

The Hostinger workflow builds all workspaces and deploys the client to the `deploy` branch. To make the same merge trigger Render deploys, create deploy hooks in Render for both web services and add these GitHub repository secrets:

```sh
RENDER_SERVER_DEPLOY_HOOK_URL=<deploy hook URL for livestream-studio-server>
RENDER_MEDIA_SERVER_DEPLOY_HOOK_URL=<deploy hook URL for livestream-studio-media-server>
```

When these secrets are missing, GitHub Actions still deploys the static client but logs notices that the Render deploy triggers were skipped.

## Production Smoke Check

After Render deploys finish, run:

```sh
npm run production:check
```

For a specific commit:

```sh
EXPECTED_COMMIT=$(git rev-parse HEAD) npm run production:check
```

The check verifies:

- `https://studio.arnoldfamini.com` serves a built client bundle
- `https://livestream-studio-server.onrender.com/health` reports `service: "signaling-server"`
- `https://livestream-studio-media-server.onrender.com/health` reports `service: "media-server"`
- both services report the expected deployment commit when `EXPECTED_COMMIT` is set

If the media-server returns Render `no-server`, the Render service has not been created or synced yet. If the signaling server returns only `{ "status": "ok" }`, Render is still running an older server build.
