# Studio reliability review — September 21, 2026

The next useful step toward StreamYard and Riverside is protecting recorded footage through interruptions. A clean interface is not enough when a reload can discard a program recording.

## Recording recovery shipped in this release

- Program mixes and individual MediaRecorder tracks commit ordered fragments to browser storage while recording. The program recorder previously kept all footage only in memory; individual tracks had disk chunks but no recovery index or user-facing recovery action.
- The workspace and studio recording libraries show **Recover recording** only when there is unfinished footage in that browser. Recovery saves a contiguous fragment sequence to the existing library; failed saves retain the source. Stable recovery IDs prevent duplicate entries after a cleanup retry.
- A Web Lock protects every capture directory from other tabs. Recording files remain locked for the capturing document's lifetime because completed Blob objects still reference those files during uploads and downloads. A successful library transaction marks the backup as acknowledged. A later document can remove acknowledged fragments once the original tab has released its lock.
- Program, separate-track, and coordinated participant finalization are included in studio exit protection. The record control shows **Saving…** during finalization, and duplicate Stop requests share the same result instead of returning empty footage.
- Unsupported or full browser storage falls back to ordered memory capture with a visible warning to keep the tab open. Disk fragments remain available as a partial recovery after reload.

The browser rehearsal exposed and fixed an important lifecycle bug: removing OPFS source files immediately after the library save invalidated original Blob references used by subsequent uploads. Cleanup now waits until those references belong to a closed/navigated document.

## Verification and limits

Automated coverage includes interrupted capture, storage exhaustion, initialization failure, failed library saves, missing fragments, cross-tab locking, idempotent retries, safe acknowledgement, cancellation, and exit guards. The checked-in browser fixture at `client/test/browser/recording-recovery.html` exercises the actual recording hooks and library using generated video without camera/microphone access. Program and individual-track recordings were interrupted by reload, recovered, and played at their original 640×360 size. Normal saves remained readable for later uploads; saved library footage also played after reopening the browser. The actual workspace recovery action was checked visually and used successfully.

Recovery applies to recordings created after this release, on the same device, browser profile, and website origin. It requires OPFS and Web Locks. It cannot recover data the browser never committed, data cleared by the user/browser, or unindexed recordings from older releases. Partial MediaRecorder containers can lack final moments or require repair; recovery does not guarantee playback for every browser/container. Raw WebCodecs sidecars are not recovered. Unsaved finished footage becomes discoverable when its original recording tab closes or reloads. This is local recovery, not resumable cloud synchronization.

## Next priorities toward parity

1. Resume participant uploads after reconnection or browser reopening, with durable upload offsets, explicit retry state, and host visibility into which tracks are complete. The recovery workflow provides the local source but does not resume a remote session automatically.
2. Verify long sessions, multi-guest synchronization, storage pressure, and audio/video quality across Safari and Chromium on separate devices. Short synthetic recordings are a regression check, not a substitute for this qualification.
3. Verify production TURN routing on restrictive networks and real destination failover. Shipping connection-retry logic alone does not establish broadcast reliability.
4. Consolidate post-production around a dependable recording library: preview, trim, transcript, captions, and exports with clear readiness and failure states. Existing feature controls still need end-to-end service testing.

[StreamYard's local recording guidance](https://support.streamyard.com/hc/en-us/articles/10725401176596-Local-Recording-of-your-Live-Stream) describes local participant recording and unfinished-upload recovery. [Riverside's podcast workflow](https://riverside.fm/use-cases/podcasting) describes local capture and progressive uploads. These are the reliability benchmarks for the work above. Full parity has not been established.

---

## Historical workflow audit — September 7, 2026

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

## Remaining priorities as of September 7

1. Recovery of interrupted recording sessions and resumable guest uploads, including reopening after a browser crash. Committed chunks alone do not yet provide a user-facing recovery workflow.
2. Long-session, multi-participant verification of capture, playback, synchronization, memory use, and storage pressure across Safari and Chromium.
3. Production tests of restrictive-network/TURN connections, real destination failover, and external platform chat using configured services. Existing code paths are not proof of production equivalence.
4. Further reduction of account/catalog traffic when quickly switching between recordings, brand kits, and team views.

The changes above are concrete progress toward StreamYard/Riverside parity. Full parity has not been established.


## Production deployment findings as of September 7

The September 7 release exposed infrastructure gaps beyond the UI. The signaling service was still running commit `2542d58` from March 17. The media service declared in `render.yaml` had not been provisioned. The existing signaling service has now been updated and the media service provisioned on the declared free plan, with matching service authentication and both GitHub deployment hooks configured. The signaling service's empty `NODE_ENV` value was corrected to `production`. Secret values are stored in the hosting providers, not this repository.

The release checker now sends the configured website origin to service health endpoints, including its curl fallback. This matches the browser's request contract without relaxing the media server's production origin checks.

The signaling build explicitly installs locked development dependencies with `npm ci --include=dev`. With `NODE_ENV=production`, the previous install omitted the project compiler and Render fell back to a different global TypeScript version, failing with TS5102. The Render dashboard build command must match `render.yaml` for services managed outside a Blueprint.

Production readiness still requires durable PostgreSQL storage for accounts, rooms, and catalogs; object storage for cloud recordings; a configured production TURN relay; and capacity testing on appropriate hosting. The current free instances can sleep and lack persistent disks. In-memory cloud data does not survive a backend restart. External platform and AI credentials also need configuration before those integrations can be considered operational. Local browser recordings and workspace data are distinct from those server-side persistence gaps.
