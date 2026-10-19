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
Expand **Preview saved copy** to play the first video or audio track directly
from the saved file. For a separate check after closing the studio, open that
file from the destination folder in a player that supports its format.

If a save fails, keep the partial folder and retry. A retry creates another new
folder, and the original recording remains in the studio library. Success
confirms completed writes and matching file sizes; it does not replace a
playback check of an important recording.

Browsers without the directory picker, including Safari, show instructions to
use the existing ZIP download. Set the browser's download location to your
external drive first.

## Browser storage is separate

**Save to folder** makes a copy after recording. During recording, recovery
chunks and the local library use browser storage, which follows the browser
profile. Choosing an external destination afterwards does not relocate that
storage. Use a dedicated browser profile and cache on the external drive when
that is a storage requirement. Existing recordings in a different browser or
profile do not automatically appear in the new profile.

No new hosting, storage subscription, or cloud processing service is required
for folder saving. Existing hosting and connectivity costs are separate.
