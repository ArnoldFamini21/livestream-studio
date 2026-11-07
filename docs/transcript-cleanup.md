# Transcript cleanup

After a recording, choose **Generate Transcript** in the recording panel. When the transcript includes word timings, a **Clean up** panel appears under it. Word timings come from OpenAI's `whisper-1`, the default `OPENAI_TRANSCRIPTION_MODEL`.

## What gets cut

| Type | Default | Rule |
|---|---|---|
| Filler words | On | um, uh, erm, er, ah, hmm, mm, and similar single-word disfluencies. Words such as "like", "so", or "you know" often carry meaning, so they are never cut automatically. |
| Stutters | On | The same word said twice in a row ("I I think"). The first is cut. "very, very" keeps both, because the comma marks deliberate emphasis. |
| Pauses | On, longer than 1 s | Gaps between words are shortened to 0.4 s, which keeps 0.2 s on each side so speech never sounds clipped. Silence before the first word and after the last is trimmed. You can choose 0.7, 1, 1.5, 2, or 3 s. |

Whisper normally leaves "um" and "uh" out of its text. For English or unspecified languages, the studio sends Whisper a short prompt written with fillers, following OpenAI's prompting guidance, so the fillers stay in the transcript and can be cut.

Cut words appear struck through, and shortened pauses appear as red "−2.1s" chips. Select any word to cut it, or select a struck word or chip to keep it. The summary shows how much time the cuts remove.

## Outputs

All outputs use the same cut list:

- **Preview cleaned** plays the recording in the browser and skips every cut.
- **Download cleaned audio** splices the audio track in the browser, much faster than real time, and saves a WAV. An 8 ms fade at each join prevents clicks. Recordings longer than 90 minutes should use the server export instead.
- **Cleaned transcript** downloads the text without the cut words.
- **Edit list (FCPXML · EDL · SRT)** downloads a ZIP for finishing the edit in a free local editor such as DaVinci Resolve:
  - `*_cleanup.fcpxml` (FCPXML 1.10). Every recorded track gets its own lane, with one clip per kept range. A clip's offset is the kept time before it, and its start is the range start plus the track's alignment. Alignment comes from the capture start times in each track's `recordingCaptureMetadata`, so a guest camera that started 1.5 s late still lines up. Markers move with the cuts.
  - One CMX3600 `*.edl` per track (record time starts at 01:00:00:00).
  - `*_cleaned.srt`, captions re-timed to the cleaned timeline, with cut words removed.

  Put the files next to the track files, or relink when the editor asks. Import the FCPXML in Resolve with File > Import > Timeline.
- **Render cleaned MP4 here** renders the cleaned program, and any other tracks you tick, in this browser with no server CPU and no upload. Each WebM is read from disk in pieces and decoded with WebCodecs (`VideoDecoder`/`AudioDecoder` through [mediabunny](https://mediabunny.dev), MPL-2.0, loaded only when a render starts). Frames outside the kept ranges are dropped. The kept frames are re-encoded as H.264, using the hardware encoder when there is one (HEVC, VP9 or AV1 if H.264 is unavailable), with AAC audio (Opus if AAC is unavailable) and 5 ms fades at each join. The result is muxed to MP4 and written as it is produced:
  1. into `<recording folder>/<Studio>/Exports/` on the SSD, when a recording folder is set up (one click re-grants access);
  2. otherwise into a folder you pick;
  3. otherwise through the browser's private storage, then downloaded;
  4. as a last resort in memory, up to 1.5 GB of source, then downloaded.

  A progress bar shows the cleaned time rendered, and **Cancel render** stops the render and removes the unfinished file. The render needs WebCodecs video and audio encoding: Chrome or Edge 94+, Firefox 130+, or Safari 26+. Safari before 17 has no video encoder, and Safari before 26 has no audio encoder. In those browsers the panel says so and points to the edit list instead.
- **Media server export (optional)** asks the media server for a cleaned final MP4, cleaned per-person videos, and cleaned WAV and MP3 stems. It needs the recording uploaded to the media server. On the free Render plan, with 0.1 CPU, x264 takes hours for a long recording, so use it only when the server has paid CPU.

## How the server export stays in sync

The export request carries `edit.keepRanges`, up to 2000 ranges. The media server snaps each range to video-frame boundaries. It then selects exactly those frames, and cuts audio in 1 ms frames using the same ranges. Every artifact therefore removes the same moments, and picture and sound stay within a frame of each other across all cuts. The filter graph is written to a file next to the output (`-/filter_complex`), so long edits never exceed command-line limits. The export manifest records the number of kept ranges and the seconds kept.
