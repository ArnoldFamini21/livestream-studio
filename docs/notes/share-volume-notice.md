# Screen share: tell the host when viewers hear the share below full volume

Follow-up to the screen-share volume slider (PR #365).

## The problem

The slider keeps its level for the browser session (`client/src/audio/screenVolumeStore.ts`)
and applies it to every share. It is only visible while the People panel is open. A host who
turned the share down to 0 for a silent slide deck and later shared a video heard that video on
their own speakers (the browser plays the host's own shared tab itself), while viewers and the
recording got silence. Nothing on screen said so.

## What the host sees now

Only the person who runs the program mix (the stage owner) is affected, because only their
level is applied (`getScreenVolumeView` returns `slider` for them alone).

- **Notice**, shown once when a share with sound comes onto the program below 100 percent, in
  the same notice area as the live summary. "Viewers hear this screen share at 30%." (or
  "Viewers cannot hear this screen share." at 0) with two buttons: "Set to 100%" and "Keep 30%"
  ("Keep it silent" at 0).
- **Marker**, a small "Share 30%" pill in the studio header beside the waiting-guests badge,
  for as long as a share with sound is on the program below 100 percent. Pressing it opens
  People, where the slider is. It disappears at 100 percent or when the share ends.
- A co-host who does not run the program sees neither. If the host leaves and a co-host runs
  the program, the rule applies to that co-host's own stored level from then on.

## When the notice appears again

- It appears once per share start. Answering with either button, moving the level to 100, or
  the share leaving the program ends its life for that share.
- A new screen share of your own (a new capture) always counts as a new start.
- A guest's share that drops and returns within 10 seconds counts as the same share (a
  reconnect) and does not repeat the notice. A guest who stops and starts again within 10
  seconds is treated the same way; the marker still shows.
- A share that starts at 100 percent never gets the notice, even if the level is lowered later
  (the host just chose it); the marker shows.

## Where the code is

- `client/src/audio/screenVolumeNotice.ts`: the pure decision function
  (`decideScreenVolumeAdvice`): what to show, to whom, with which words. Tested in
  `client/test/screenVolumeNotice.test.ts`.
- `client/src/audio/useScreenVolumeNotice.ts`: runs it in React and holds the per-share memory.
- `client/src/components/ScreenShareVolumeNotice.tsx`, `ScreenShareVolumeMarker.tsx`.
- `client/src/components/StudioRoom.tsx`: wiring only, next to the screen-volume wiring.

## Small fixes in the same change

- `StudioRoom.tsx`: `goLiveFailureReasonRef` is cleared at the very start of every Go Live
  attempt, so a failed attempt cannot cite the reason of an older one. This lives in the
  component's closure and has no pure function to test; it is covered by the browser check
  only in the sense that the code path is unchanged otherwise.
- `MusicTransportBar.tsx`: a tap on the scrub thumb that does not move it no longer seeks by a
  tiny step (`client/src/audio/scrubRelease.ts`, tested). Dragging, pressing on the bar and
  keyboard seeking work as before.
- `docs/parity-wave3.md`: the P0.3 box is ticked (its work merged in PR #354).

## Not covered

`e2e/studio.test.mjs` has no faked screen share, so it does not exercise this notice.
