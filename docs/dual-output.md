# Landscape and portrait in one broadcast

In **Go live → Stream destinations**, turn on **Stream landscape and portrait together**. The stage is the main program. Use the orientation picker on each destination to send at least one destination to landscape and one to portrait. The second program shows a preview and an independent **Grid**, **Spotlight**, or **Solo** layout.

Both programs share the stage participants, program audio, active shared content, and on-air overlays. The main program keeps its selected quality and is used for watch-page playback, private testing and the live backup. The second program is capped at 720p and 30 fps. Its video and audio add about 2.7 Mbps upstream, before transport overhead. A host can change the second layout while live.

The mode needs browser H.264 capture and a media server with FFmpeg, encode-once, and at least two allowed destinations. Both programs count toward the existing combined destination cap. An operator can turn off this capability with `RTMP_DUAL_OUTPUT=0`. The first connection starts the main program; the second belongs to the same host and broadcast. If the second cannot start, both are stopped. If the second exhausts its reconnect attempts during a broadcast, the first continues and the second program reports the failure. The browser automatically attempts a reconnect before reporting that failure. Continuing on a new studio tab reattaches the main program and starts a new second program.

## Local RTMP rehearsal

The optional browser rehearsal starts two local FFmpeg listeners and decodes the 1280 × 720 and 720 × 1280 video and verifies AAC audio in both files. It uses fake camera and microphone devices and sends no media to external platforms. Use the X9 wrapper around the shell commands on the owner's Mac.

```sh
npm run -w shared build
npm run -w server build
npm run -w media-server build
VITE_API_URL=http://localhost:3381 VITE_WS_URL=ws://localhost:3381/ws \
VITE_MEDIA_HTTP_URL=http://localhost:3382 VITE_MEDIA_WS_URL=ws://localhost:3382/rtmp \
VITE_INVITE_BASE_URL=http://localhost:5599 npm run -w client build
E2E_API_PORT=3381 E2E_PORT=5599 node --test e2e/dual-output.mjs
```

Local output files and browser diagnostics go into `output/dual-output`. The rehearsal needs a Chromium build with MediaRecorder H.264 and the keyframe interval option. This rehearsal runs separately from the standard browser suite because it starts a media server.
