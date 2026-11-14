# The studio says LIVE but the browser is not sending anything

## The problem

The studio's browser is the program. A canvas and a Web Audio mix go into a
`MediaRecorder`, and its chunks travel over a WebSocket to the media server,
which forwards them to YouTube or Facebook. Before this change, nothing checked
that a chunk ever came out of the recorder. The relay was marked live as soon
as the media server answered `session-started`. If the recorder produced
nothing, the header said LIVE, the destination stayed on "Connecting", and
Stream Health said "Starting" for ever.

A real cause, seen on the owner's Mac on 2026-11-14: Chrome's audio clock was
stuck. The `AudioContext` said `running`, but `currentTime` did not move
(0.005 s in one second). A recorder with a video track and an audio track from
that context produced 0 chunks. Chrome started with `--disable-audio-output`
worked again, which shows the cause is the computer's sound output device, not
the page. A Bluetooth headset that went away, or a virtual audio device whose
driver is not running, can do the same.

## What the watchdog does

`client/src/utils/relayMediaWatch.ts` (pure, the time comes in as an argument)
decides. `useRtmpRelay.ts` owns one timer per transport, started with the
recorder, checking once a second.

| Rule | Value |
| --- | --- |
| No chunk this long after the recorder started | 8 s, verdict `no-first-chunk` |
| No chunk this long after an earlier one | 10 s, verdict `stopped` |
| Restarts in a row for this cause | at most 2 |
| The count starts again after chunks flowed | 60 s in a row, counted over the whole relay (a reconnect in between does not hide a healthy stretch) |

It looks at when the recorder last **produced** a non-empty chunk, not when one
was sent (a slow uplink is the backlog rule's business). It does not fire
before `session-started`, while the relay is being stopped on purpose, while a
reconnect is waiting, or for a transport that is no longer the current one. The
timer is cleared by `stopActiveRelayTransport`, so every existing cleanup path
clears it. Times are `performance.now()`, not the wall clock, so a clock jump or
a wake from sleep does not look like a silent recorder. The private test stream uses the same relay, so it is watched too.

When it fires:

1. `stats.mediaStall` is set (`{ since, kind }`) and the program audio check
   runs (about 4 s at most). `runRelayMediaStall` (pure, in `relayMediaWatch.ts`,
   tested with a fake relay) then asks again: did the relay move on during the
   check (stopped, a socket drop gave a new transport)? Then nothing happens.
   Did the recorder produce a chunk during the check? Then the stall is over:
   the flag is cleared, no restart is counted, the host is not told, and the
   watchdog keeps watching. The one exception is a `recovered` answer: that
   restart is wanted.
2. The audio cannot run (`stuck`): the relay ends through the final stop path
   (but see below: no "stop" is sent to the media server) with "Your computer's sound output is not responding, so the
   browser cannot produce the broadcast. Check the sound output device or
   restart the browser, then go live again."
3. The audio was `recovered`: the transport restarts at once.
4. The audio was fine (`running`, or no check): the transport restarts at once,
   up to 2 times in a row. After that the relay ends with "Your browser is not
   producing the broadcast (no video or sound data came out of it). Reload the
   studio page and go live again. If it happens again, restart the browser."

The relay is ended without a "stop" message: the studio closes the socket, and
the media server keeps the broadcast on its "be right back" slate for its usual
hold (3 minutes) as it does for any lost studio. The host can fix the cause and
press Continue broadcast (or reload the studio page and continue), instead of
starting a new broadcast. This also covers a short interruption of the audio
(Safari, a headset switch) that the first check reads as stuck. The hold only
exists once a destination had gone live: when the broadcast never produced
anything (the stuck output at Go Live), the server says "nothing to hold" and
ends the session, as before.

A restart is `restartTransport` in the transport closure: stop this transport,
tell the destinations "connecting", then run the existing `reconnectNow`. It
does not wait and it does not use the reconnect attempts that socket drops and
slow uplinks share (`MAX_RELAY_RECONNECT_ATTEMPTS`, the backlog rule and the
socket-drop paths are unchanged). If the restarted connection itself fails,
the old reconnect path takes over.

`mediaStall` is cleared by the next chunk the recorder produces.

## The program audio check

`client/src/audio/programAudioClock.ts`. `judgeAudioClock` says `stuck` when
fewer than 0.2 s of audio time passed in at least 1 s of wall time (a shorter
look is judged in proportion), or when the context is not `running` after a
resume. `useBroadcastAudioBus` wraps it:

- `checkProgramAudio()`: resume if needed, read `currentTime`, wait 1.2 s, read
  again. Moving: `{ state: "running" }`. Not moving: if the context has
  `setSinkId`, call `setSinkId({ type: "none" })` (Chrome: no sound device, the
  context then runs on a timer), wait 0.8 s, read again. Moving now:
  `{ state: "recovered" }`. Otherwise `{ state: "stuck" }`. A resume that never
  answers is given up after 0.4 s. The device switch is the recovery itself and
  may be slow on a stuck output: it is given 1 s, and if it still has not
  answered that is not a failure (it may land a moment later): the clock is
  watched as if it had, and the output is reported as off. Only a switch that
  fails (no `setSinkId`, or it rejects) ends the check as `stuck` with the output
  not off. Never throws.
  Only one check or restore runs at a time.
- `restoreAudioOutput()`: `setSinkId("")` (the default device), check the clock
  for 1.2 s; if it is stuck again, back to `{ type: "none" }` and report false.
- `soundOutputOff` (state the hook returns): true while the bus context has no
  sound device. A new context starts with the sound on.
- Whenever the output is off and no broadcast runs (the broadcast ended, or the
  output went off during a check that finished after the host pressed Stop),
  `useRestoreSoundWhenRelayEnds` tries `restoreAudioOutput()` once, quietly. It
  does not run while the studio still counts as live (a recorder error that
  did not end the broadcast).
- The studio's other audio context, the one that cleans up the host's microphone
  (`createEnhancedAudioStream`), only feeds the program mix and never plays to
  the speakers. It is created without a sound device (`setSinkId({ type: "none" })`
  right after creation, where the browser has it), so a stuck output cannot
  silence the host's voice in the broadcast. Without this, rescuing only the
  bus would have left the preacher's own voice out of the program while every
  indicator was green.

The sleep and the clock are injectable (`AudioClockDeps`), so the check is
tested with a fake context and no real waiting.

## What the host stops hearing when the bus has no sound device

Traced in the code, not measured on a real stuck device.

- Stops playing on this computer: sound effects (sound board), background
  music, and the sound of clips and videos played in the studio. They are all
  routed to `monitorMix`, which is connected to `context.destination`.
  Background music and clip videos are attached to the bus with
  `createMediaElementSource`, which replaces the element's own output.
- Not changed: guests' voices. They play through the `<video>` elements of the
  stage tiles (`VideoTile`, `srcObject`), not through the studio's audio mix.
  The level meters and the guest-arrival chime use a separate shared context.
  If the computer's sound device is really broken, nothing is audible there
  whatever the studio does, but the studio's change does not cause that.
- Viewers and guests still get everything. The program mix, the mix sent back
  to guests and the guests' voices inside the program all live in the same
  context, which keeps running on a timer.

## What the host sees

All with the existing toasts and notice area, no new panel.

- Stream Health shows a red "Not sending" and "Your browser is not producing
  the broadcast. The studio is restarting it." while a stall is flagged. Before
  the watchdog fires it still says "Starting".
- Header: the red LIVE badge becomes an amber "NOT SENDING 0:22" with no
  pulsing dot. The LIVE badge was the smaller change: the health pill is an
  average of many checks, and one bad check can still read "Good". Only the
  computer that runs the relay has a stall, so guests, co-hosts who do not run
  the relay and viewers see nothing new.
- A toast, once each time the watchdog restarts the broadcast: "The studio is
  not sending your broadcast. It is restarting it now."
- When the audio was recovered, a second toast: "Your computer's sound output
  stopped responding. To keep the broadcast going, the studio stopped playing
  its sound effects, music and clips on this computer. Guests' voices are played
  separately and are not switched off by the studio. Viewers still hear everything. When the sound output works again, press "Turn sound back on"." And a marker stays in the
  notice area while the output is off: "Sound effects, music and clips are not
  playing on this computer. Viewers still hear everything. Check the sound output
  device, then press "Turn sound back on"." with a "Turn sound back on" button.
  When no broadcast runs any more it says "Sound is off on this computer (sound
  effects, music and clips). Check the sound output device, then press "Turn
  sound back on"." (nothing about viewers). The private test stream uses test
  words ("test stream", "start the test again") in the toasts and end messages.
  If "Turn sound back on" fails: "The sound output still does not respond. Sound
  stays off on this computer." If it works: "Sound is back on."
- When the watchdog ends the relay, the reason is shown as an error toast that
  stays until dismissed. (The final stop path alone did not show it in the
  browser check: the destination row went back to Idle with no message and the
  "Stream ended with issues" notice does not print the reason. Most likely the
  studio server's "not live" message resets the rows. The same is true of the
  older causes.)

Pressing "Turn sound back on" while the device is still stuck freezes the
broadcast's audio clock for about 1.3 s while the check runs.

## Tests and checks

- Unit tests: `client/test/relayMediaWatch.test.ts` (includes the watchdog step
  after the sound check: restart count stored and limited, relay moved on, chunks
  came back), `programAudioClock.test.ts`, `broadcastAudioBusOutput.test.ts`,
  `audioProcessing.test.ts` (the voice context has no sound device).
- A real-browser check (local media server, counting RTMP listener, the built
  client, real Chromium with `--disable-audio-output`). A stuck sound output is
  simulated by wrapping `AudioContext`: the context is really suspended while
  its `state` says `running`, `resume()` does nothing, `setSinkId({ type:
  "none" })` really resumes it, and `setSinkId("")` suspends it again unless
  the scenario says the device is healthy. Scenarios: healthy, before (the
  build of origin/main: LIVE, no chunk, no destination connection), recover,
  nosink, midstream, silent (the recorder never produces and the audio is fine:
  two restarts, then the relay ends), blip (the recorder goes quiet for 10 s and
  comes back during the sound check: no restart). When the relay ends, the check
  asserts that no "stop" was sent, the media server holds the broadcast and the
  studio offers the held-broadcast banner. The check scripts are not in the
  repository.

## What was not verified

- A real stuck sound device. The stuck context is simulated; on the owner's Mac
  the real one went away by itself hours later.
- `setSinkId({ type: "none" })` on a context whose real device is stuck. The
  simulation resumes the context on that call, as Chrome is expected to.
- That guests' voices keep playing when the bus has no sound device (from the
  code, not from a listening test).
- Safari and Firefox: they have no `AudioContext.setSinkId`, so the check can
  only say `running` or `stuck`; a stuck sound output ends the broadcast with
  the plain reason instead of recovering.
- The hook wiring (timers, the transport closure) has no unit test (it needs a real
  recorder and a socket). The decisions it makes are in `runRelayMediaStall`,
  which has; the wiring is covered by the browser scenarios.
- That giving the microphone context no sound device keeps the voice processing
  smooth on a healthy computer (it should: the context then runs on a timer).
  Not listened to.
- A background browser tab: the poll and the check's waits are ordinary timers,
  which Chrome may slow down in a tab that has been hidden for a long time.
  A host with guests (live video and audio) is not affected; a solo host with
  the studio tab hidden may see a late detection.
