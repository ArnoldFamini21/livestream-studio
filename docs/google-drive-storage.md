# Google Drive recording storage

Open Settings → Google Drive → Connect Google Drive, complete Google's consent prompt, and choose your recording folder. After recording, use **Save to Google Drive** in the recording panel. Each recording gets a subfolder inside the selected folder.

The integration requests only `https://www.googleapis.com/auth/drive.file`. Google Picker grants access to the folder the user selects. The application verifies that the signed-in Google account can add files there before creating a recording folder. Uploads preserve inherited folder permissions; they do not create public sharing permissions.

## Deployment configuration

Enable Google Drive API and Google Picker API in the same Google Cloud project. Configure a Web application OAuth client with the production website origin and any local development origin. Configure the consent screen and, if the app is in testing, its allowed test users.

The client build reads these GitHub Actions values:

- Repository variable `VITE_GOOGLE_CLIENT_ID`: OAuth Web client ID.
- Repository variable `VITE_GOOGLE_APP_ID`: Google Cloud project number.
- Repository secret `VITE_GOOGLE_PICKER_API_KEY`: browser Picker key restricted to Google Picker API and the approved website referrers. Google Picker also requires `https://docs.google.com/*` in the referrer list.

These Vite values are necessarily included in the browser bundle. The Picker key must remain restricted; OAuth client secrets and refresh tokens must never be placed in Vite variables.

## Persistence and limits

Only the selected folder ID and name are remembered in this browser. Access tokens stay in memory. Google may ask for sign-in again after a reload or when a token expires. Forget folder clears the local destination and token; it does not revoke Google's account-level grant. Users can revoke that grant in their Google Account permissions.

Files successfully saved to Drive persist independently of the website or its hosting. Uploading is user-initiated and requires the browser to remain open; this is not automatic background cloud recording. The retention manifest supplies a review date, not automatic deletion from Drive.

## Verification

Client tests cover consent denial, closed popups, timeouts, concurrent sign-in requests, folder validation, explicit parent selection, preservation of sharing permissions, and rejecting upload URLs outside Google's endpoint. A real consent-and-upload test must additionally be completed in the deployed browser with an authorized Google account.
