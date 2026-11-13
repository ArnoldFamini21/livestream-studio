# Deploy safety: updates wait for a broadcast to end

Merging to `main` normally updates the live studio by itself. Two kinds of update can hurt a broadcast that is on the air: restarting the media server ends the stream to YouTube and Facebook, and publishing the client replaces the page files a studio tab may still need. So the deploy now checks first and waits.

## What the hold does

The workflow `Build and Deploy to Hostinger` has a step called **Hold the deploy while a broadcast is on the air**. It runs after the build and the tests, and before anything reaches production (before the Render deploy hooks and before the client is published). It asks the media server, every 30 seconds, whether anything is on the air:

- It reads `https://livestream-studio-media-server.onrender.com/metrics` and looks at `livestream_studio_media_relay_sessions_by_state{state="started"}`.
- A number above 0 means busy. That counts a real broadcast, a broadcast held on the "we'll be right back" slate after the studio dropped (up to 3 minutes), and a private test. A studio that is open but has not pressed Go Live does not count.
- Idle (0): the deploy goes on.
- The media server cannot be reached after three tries (a sleeping Render server needs about a minute to wake): there is no broadcast to protect, so the deploy goes on, with a yellow warning in the log.
- The server answers but the answer cannot be read: the deploy goes on, with a yellow warning.
- Still busy after 8 minutes: the run stops and fails. Nothing was deployed.

The hold applies to every push to `main`, whatever changed (a client-only change is held too). A push cannot skip it.

## What you see when a deploy is held

The run on the Actions page turns red and shows:

> A broadcast or a private test is on the air. Nothing was deployed. Re-run this workflow when it has ended.

Nothing changed in production: no service restarted and no new client was published. Your code is merged, it is just not live yet.

## Re-running a held deploy

When the broadcast has ended, open the held run on the Actions page (repository `ArnoldFamini21/livestream-studio`, tab Actions, workflow `Build and Deploy to Hostinger`) and press **Re-run all jobs**. Or from a terminal: `gh run rerun RUN_ID`. Re-run the newest run for `main`: re-running an old run would publish that old version again.

If you do nothing, the next merge to `main` deploys everything that is waiting.

## Nothing is left behind

A held or failed deploy used to leave a service on its old version, because the next merge only looked at its own files. Now each run also asks both Render services which commit they run (their `/health` page shows it) and redeploys a service when files that belong to it changed since that commit. A service whose files did not change is never restarted. If a service's commit cannot be read, that service is judged by the files of the current merge only, as before. A manual run (Run workflow) never does this catch-up: it deploys only what you tick.

## Emergency: deploy during a broadcast

On the Actions page, choose **Run workflow** and tick **deploy_while_live**. That run does not wait, and it deploys only what you tick (deploy_client, deploy_signaling, deploy_media) with no catch-up of other services. Restarting the media server ends a live stream. Only a manual run can do this; a push cannot.

## The time budget

The whole job is limited to 45 minutes. The build and tests take about 5 minutes (10 at worst), the hold at most 12 (8 minutes of waiting plus the last check), the publish 2, the client check up to 5 and the service check up to 15: 44 minutes in the worst case. That is why the wait is 8 minutes rather than longer. A longer broadcast simply means re-running the deploy afterwards.

## Where it lives

`scripts/media-activity.mjs` (reads the metrics), `scripts/wait-for-idle-media.mjs` (the wait), `scripts/classify-service-lag.mjs` (which services are behind), `.github/workflows/deploy.yml`, and `scripts/deploy-workflow.test.mjs`, which fails if the hold is removed, moved after the deploy steps, or made skippable by a push.
