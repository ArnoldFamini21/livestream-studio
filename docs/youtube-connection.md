# Connected YouTube destinations

Open **Go Live → Add Destination → YouTube**, fill in the title, description, visibility, and latency, then choose **Sign in & create broadcast**. After Google's consent prompt, the studio creates a YouTube live broadcast and a single-use RTMP stream, binds them, and adds the destination with its ingest URL and key filled in. You never copy a stream key.

The broadcast is created with auto-start and auto-stop. YouTube goes live when the studio's first frames arrive and ends when the stream stops. The destination card links to the watch page and to YouTube Studio's live control room. If the broadcast has a live chat and the signaling server has `YOUTUBE_API_KEY`, the studio connects that chat to the unified chat automatically.

If any creation step fails, the studio deletes what it already created, so the channel is not left with empty upcoming broadcasts. The error messages cover channels that aren't yet approved for live streaming (approval can take up to 24 hours), wrong Google accounts, rate limits, and invalid titles.

**Use a stream key instead** keeps the manual path for any YouTube event you created yourself.

## Deployment configuration

The feature uses the same OAuth Web client as Google Drive (`VITE_GOOGLE_CLIENT_ID`). In that Google Cloud project:

1. Enable **YouTube Data API v3**.
2. Add the `https://www.googleapis.com/auth/youtube` scope to the OAuth consent screen. It is a sensitive scope: while the app is in testing, add the channel owner's Google account as a test user; publishing the app for wider use requires Google's verification.
3. Keep the production website origin and any local development origin in the client's authorized JavaScript origins.

No server secret is needed to create broadcasts. Access tokens stay in browser memory and are never stored in `localStorage`, URLs, or catalogs.

## Remembered destinations

Destinations you add with a stream key are remembered in this browser, so they come back in the next studio. A stream key is saved only when **Remember stream key on this device** is checked for that destination. Otherwise the destination returns switched off and asks for its key. Connected YouTube broadcasts are single-use and are never remembered; create a new one for each show.

## Verification

Client tests cover broadcast creation and binding, cleanup after a failed bind or stream creation, error messages, title and description sanitizing, schedule handling, destination serialization (keys only on opt-in, never for connected broadcasts), corrupt storage, and the enabled-destination cap. You still need to run one real consent-and-go-live test in the deployed browser with the channel's Google account.
