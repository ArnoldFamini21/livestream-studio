# Studio workflow audit — September 7, 2026

The benchmark is a small set of clear controls backed by dependable capture, guest coordination, and publishing. Feature names alone do not establish parity.

## Improvements in this release

| Area | Verified gap | Change |
| --- | --- | --- |
| Workspace loading | Twenty saved studios launched 20 catalog reads and 400 catalog writes on opening. This exceeds the server's 30-request rate limit. | One bounded sync request replaces the fan-out. Each source and destination still requires its private host credential. Unchanged catalog entries are not rewritten; partial failures retain available results. Simultaneous refreshes share their in-flight request. |
| Guest management | Repeated headings, status badges, volume sliders, and up to eight actions appeared for every guest. | Compact waiting-room, on-stage, and backstage lists. Admission and microphone controls remain immediate; audio mix, spotlight, moderation, and role changes appear on demand. Private messaging opens the selected person's conversation. |
| Chat continuity | Switching panels unmounted chat and discarded drafts and the selected conversation. | Drafts remain in the room's sidebar state, separately keyed by public, backstage, and recipient. Channel and recipient selection survive panel switches. Drafts are not written to persistent browser storage. |
| Recording integrity | A failed OPFS write fell back to storing only failed chunks in memory, but finalization returned either the disk file or memory chunks. That could omit part of a recording. | Commit each chunk separately. After a storage failure, combine previously committed chunks and all subsequent memory chunks in capture order. Cancellation discards owned chunks. |
| Guest preview | A camera switched back on with the same stream could mount a new video element without reattaching its source. | Preview attachment responds to both stream and camera-enabled changes and detaches old video elements. |

## Benchmark sources

[StreamYard's People documentation](https://support.streamyard.com/hc/en-us/articles/39042290705300-Using-the-People-Tab-in-StreamYard) describes centralized guest audio/video controls, private chat, and moderation. This release improves access to the app's existing host controls; it does not add remote camera/device configuration.

[StreamYard's recording documentation](https://streamyard.com/recordings) describes separate device-local tracks and recovery of unfinished uploads. [Riverside's product overview](https://riverside.com/product) emphasizes local high-quality capture and post-production workflows. These set reliability benchmarks beyond visual polish.

## Remaining priorities

1. Recovery of interrupted recording sessions and resumable guest uploads, including reopening after a browser crash. Committed chunks alone do not yet provide a user-facing recovery workflow.
2. Long-session, multi-participant verification of capture, playback, synchronization, memory use, and storage pressure across Safari and Chromium.
3. Production tests of restrictive-network/TURN connections, real destination failover, and external platform chat using configured services. Existing code paths are not proof of production equivalence.
4. Further reduction of account/catalog traffic when quickly switching between recordings, brand kits, and team views.

The changes above are concrete progress toward StreamYard/Riverside parity. Full parity has not been established.
