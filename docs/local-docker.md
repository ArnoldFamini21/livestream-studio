# Local Docker Development

This Compose setup runs the full local studio stack:

- Vite client on `http://localhost:5173`
- signaling/API server on `http://localhost:3001`
- RTMP media relay on `ws://localhost:3002/rtmp`

## First Run

```sh
cp .env.docker.example .env
npm run docker:dev
```

The client is configured to call the two local Render-equivalent services, so the Go Live RTMP relay can be exercised without editing Vite env files.

## Daily Commands

```sh
npm run docker:dev     # build and start the full stack
npm run docker:logs    # follow service logs
npm run docker:down    # stop and remove containers
npm run docker:config  # render the final Compose config
```

## RTMP Relay Notes

The `LIVE_STREAM_TOKEN_SECRET` value must match between `server` and `media-server`; `docker-compose.yml` wires both from the same environment value. Keep real RTMP stream keys in the browser session only. Do not add them to `.env`.

To test an RTMP output locally, run or point at an RTMP ingest server, add a custom RTMP destination in the Studio UI, and start Go Live from the host session.
