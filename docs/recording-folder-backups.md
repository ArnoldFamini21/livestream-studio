# Save a recording to your drive

After stopping a recording, choose **Save to folder** in the recording panel.
The same action is available beside saved sessions and in the workspace's
Recordings page. In desktop Chrome or Edge, select a folder on your external
drive and approve access to that folder.

The studio creates a new folder for each save, writes the original tracks, and
checks each saved file's size after closing it. It writes
`recording-manifest.json` last, after all tracks pass those checks. The manifest
includes track names, sizes, capture details, and recording markers. This action
does not upload files or call a paid service.

Keep the tab open and the drive connected until the studio reports success.
While a save is in progress, the studio holds the recording controls and
library selection in place. Cancelling the folder picker releases those
controls. If a disconnect or browser Back navigation closes the recording
panel, the finished save reports success or failure in a notification that
stays visible until dismissed.
Expand **Preview saved copy** to play the first video or audio track directly
from the saved file. For a separate check after closing the studio, open that
file from the destination folder in a player that supports its format.

If a save fails, keep the partial folder and retry. A retry creates another new
folder, and the original recording remains in the studio library. Success
confirms completed writes and matching file sizes; it does not replace a
playback check of an important recording.

Browsers without the directory picker, including Safari, show instructions to
use **Download all**, which downloads every original track as its own file
straight from browser storage (the ZIP download also streams tracks from disk
instead of loading them into memory). Set the browser's download location to
your external drive first.

## Record straight to your drive (Chrome or Edge)

In the Recordings panel, choose **Choose recording folder** once. The studio
remembers the folder; on later visits pressing Record asks the browser to allow
it again with one click, without showing the folder picker.

While a take records, every track is written into that folder as it is
captured, organised as `<folder>/<Studio>/<YYYY-MM-DD HHmm take>/<person>/`.
Tracks are committed in small part files every few seconds (so a crash loses
at most a few seconds) and joined into the final file, with a size check, when
the track ends. A device or setting change mid-take continues the track in a
new "(part N)" file, and a screen share started mid-take becomes its own
track. `take-manifest.json` in the take folder lists every file with its start
offset, pauses and segment number, and the editor exports (FCPXML, Premiere,
Resolve, timeline CSV/JSON) place each track at that offset.

Guests' tracks are sent to the host's folder peer-to-peer during the take over
a dedicated WebRTC data channel (using the studio's STUN/TURN servers). The
panel shows progress per guest ("Receiving Maria's tracks — 82%"). A guest who
reloads or reconnects resumes from the last byte the host saved; a guest's
browser keeps its own copy until the host confirms the whole track. With a
folder connected nothing is uploaded to the media server, unless object storage
is configured and the cloud copy is switched on. An optional lossless track
records each microphone, before voice processing, as 48 kHz WAV.

If the drive stops accepting files, recording continues in browser storage and
the studio says so; save that take to the folder afterwards. Without a folder,
the studio asks the browser to keep its storage persistent and warns before
recording when browser storage has less than about two hours of room.

## Browser storage is separate

**Save to folder** makes a copy after recording. Without a recording folder,
recovery chunks and the local library use browser storage during recording, which follows the browser
profile. Choosing an external destination afterwards does not relocate that
storage. Use a dedicated browser profile and cache on the external drive when
that is a storage requirement. Existing recordings in a different browser or
profile do not automatically appear in the new profile.

No new hosting, storage subscription, or cloud processing service is required
for folder saving. Existing hosting and connectivity costs are separate.
