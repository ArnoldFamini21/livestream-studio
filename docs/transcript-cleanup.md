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
- **Export cleaned video** asks the media server for a cleaned final MP4, cleaned per-person videos, and cleaned WAV and MP3 stems. It needs the recording uploaded to the media server.

## How the server export stays in sync

The export request carries `edit.keepRanges`, up to 2000 ranges. The media server snaps each range to video-frame boundaries. It then selects exactly those frames, and cuts audio in 1 ms frames using the same ranges. Every artifact therefore removes the same moments, and picture and sound stay within a frame of each other across all cuts. The filter graph is written to a file next to the output (`-/filter_complex`), so long edits never exceed command-line limits. The export manifest records the number of kept ranges and the seconds kept.
