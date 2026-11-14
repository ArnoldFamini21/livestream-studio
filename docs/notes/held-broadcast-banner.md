# Crash recovery: the returning host is told the broadcast is still on the air

## What happens

When the studio's connection to the media server drops during a real
broadcast (browser crash, reload, network loss), the media server keeps every
destination on a "be right back" slate for 3 minutes (`STUDIO_RECONNECT_HOLD_MS`
in `media-server/src/relayResume.ts`). Pressing Go Live with the same places to
stream to and the same output settings continues that broadcast.

Before this change the returning host saw an ordinary studio. Now the host
sees a banner at the top of the studio:

- While a hold is reported: "Your broadcast is still on the air. Viewers see
  the "be right back" screen. Continue within M:SS." and a **Continue
  broadcast** button.
- A remembered destination that came back without its stream key: the banner
  says to paste the key first, and its button ("Open destinations") opens the
  destinations panel. Keys are never stored for this; with "Remember stream
  key" off they have always had to be pasted again.
- When the countdown reaches zero, or the server says the hold is over: "The
  broadcast ended. Press Go Live to start a new one." with Dismiss.
- When the host is live again by any path, the banner goes away.
- "Test stream (private)" is disabled with one line of explanation while a
  hold is reported (the media server refuses a test during a hold anyway).

Guests and co-hosts see nothing. Only the host can continue a broadcast:
destinations and stream keys live on the host's device.

## Media server

`GET /rtmp/held?roomId=ROOM`, read-only, authorised exactly like
`GET /rtmp/backups/latest` (same CORS handling, same live stream token check,
the token must be for that room: 401 without or with a bad token, 403 for
another room, 400 without a room). Built by the pure function
`buildHeldBroadcastAnswer` in `media-server/src/heldBroadcast.ts`.

```json
{ "held": true, "state": "held", "secondsLeft": 151,
  "destinations": [ { "name": "YouTube", "connected": true } ] }
{ "held": false, "state": "broadcast" }   // or "test" or "none"
```

Never a stream key, an RTMP URL or a destination id. Display names are cut to
80 characters. `/health` advertises it as `capabilities.heldBroadcast`, so a new
studio that meets an old media server during a deploy shows no banner and does
not ask.

The banner does not depend on every health check succeeding. A media server
that answered its health check decides (with the capability: ask; without it:
do not). A health check that got no answer at all (a timeout, no network) or a
busy one (HTTP 429 or 5xx) leaves the question open, and the studio asks
anyway: the media server is busiest exactly while a broadcast is on hold, the
health check gives up after 4 seconds, and the host has only 3 minutes. Each
time that answer changes (a check fails, or answers again after a failed one)
the studio asks afresh. A manual re-check (the Check button) keeps the answer
while it runs. An old media server met with the question still open answers
"not found", which ends the asking; in a browser that answer can also arrive as
a failed request (it carries no CORS headers), and then the retries run out.
The rule is `getHeldBroadcastSupport` in
`client/src/utils/heldBroadcastState.ts` ('yes', 'open' or 'no').

`STUDIO_RECONNECT_HOLD_SECONDS` (optional) can only shorten the hold, for local
and automated checks. Unset, longer, zero or invalid values keep 3 minutes.

## Studio

- `client/src/utils/heldBroadcastState.ts`: reading the answer, the watch
  state (idle, held with a local countdown, ended), formatting, and what the
  health check says about the request (getHeldBroadcastSupport).
- `client/src/utils/heldBroadcastAsker.ts`: asks once, then about every 10 s
  while a hold is reported. A failed ask is retried: before any answer after 2,
  4, 8 and 15 seconds and then every 30 seconds, for about three minutes in all
  (a hold that existed when the studio opened cannot outlast that), and then
  the asking ends; while a hold is known every 10 s for as long as the banner
  shows. One ask is given 8 seconds, so a request that hangs is retried too. A
  media server that does not know the request (404/405), or no media server
  address at all, ends the asking at once.
- `client/src/utils/heldBroadcastBanner.ts`: what the banner shows
  (`decideHeldBanner`) and `getGoLiveBlocker`, the same rule the destinations
  panel uses for its Go Live button.
- `client/src/hooks/useHeldBroadcast.ts`: the small hook (asks after the host
  has joined and again when the signaling connection returns; stops when
  nothing is held, when the host is live, and on unmount). The countdown is
  local, counted down from the seconds the server gave, never from a clock
  comparison.
- `client/src/components/HeldBroadcastBanner.tsx`: the banner.
- `StudioRoom.tsx`: wiring only, next to `useTestStream`.

**Continue broadcast** runs the same path as the Go Live button
(`onGoLive` after `getNormalGoLiveBlocker`), and the button stays off with the
reason whenever the destinations panel's Go Live button would be off (relay not
ready, a blocking studio check, an unusable destination). When the destinations
switched on now are not the ones on the air, the banner warns that pressing the
button would start a new broadcast instead of continuing it.

After a quick reload (within the studio server's reconnect window of about 30
seconds) the studio server may still say the room is live, so the studio shows
LIVE although nothing is sent from the page. The banner treats "live" as "this
page is sending it": Continue clears that stale local LIVE and then goes
through the normal Go Live path.

## Not covered

- The server's answer has only display names. If output settings (size, bit
  rate, orientation) differ from the broadcast on hold, Go Live replaces it
  (existing media server rule, see `isSameRelaySetup`); the banner cannot tell.
- A host who never returns and a media server restart end the hold, as before.
