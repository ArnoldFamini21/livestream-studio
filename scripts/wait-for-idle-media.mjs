#!/usr/bin/env node
// Holds a deploy while a broadcast is on the air. Polls the media server's
// /metrics every 30 seconds until nothing is on the air, or until the time
// budget runs out.
//
//   exit 0  idle (or the media server is down / unreadable: nothing to protect)
//   exit 1  still busy when the budget ended; nothing was deployed
//
// Environment (all optional):
//   MEDIA_IDLE_BUDGET_MINUTES  how long to wait, default 20
//   MEDIA_IDLE_POLL_SECONDS    seconds between polls, default 30
//   MEDIA_METRICS_URL          default: the production media server
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MEDIA_METRICS_URL, readMediaActivity } from './media-activity.mjs';

export const DEFAULT_BUDGET_MINUTES = 20;
export const DEFAULT_POLL_SECONDS = 30;
export const BUSY_ERROR = '::error::A broadcast or a private test is on the air. Nothing was deployed. Re-run this workflow when it has ended.';

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} min ${String(seconds).padStart(2, '0')} s` : `${seconds} s`;
}

/**
 * Returns { exitCode, outcome } where outcome is 'idle', 'unreachable',
 * 'unknown' or 'busy'. Clock, sleep, logging and the reader are injectable.
 */
export async function waitForIdleMedia({
  budgetMs = DEFAULT_BUDGET_MINUTES * 60_000,
  pollMs = DEFAULT_POLL_SECONDS * 1000,
  readActivity = readMediaActivity,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
} = {}) {
  const startedAt = now();
  for (let poll = 1; ; poll++) {
    const activity = await readActivity();
    const waited = now() - startedAt;
    const prefix = `[poll ${poll}, waited ${formatDuration(waited)} of ${formatDuration(budgetMs)}]`;

    if (activity.state === 'idle') {
      log(`${prefix} The media server is idle: no relay session is started. Safe to deploy.`);
      return { exitCode: 0, outcome: 'idle' };
    }
    if (activity.state === 'unreachable') {
      log(`${prefix} The media server did not answer.`);
      log(`::warning::The media server could not be reached (${activity.detail}). A server that is down has no broadcast to protect, so the deploy goes on.`);
      return { exitCode: 0, outcome: 'unreachable' };
    }
    if (activity.state === 'unknown') {
      log(`${prefix} The media server's activity could not be read.`);
      log(`::warning::Could not tell whether a broadcast is on the air (${activity.detail}). The deploy goes on.`);
      return { exitCode: 0, outcome: 'unknown' };
    }

    log(`${prefix} The media server is busy: ${activity.started} relay session(s) started (a broadcast, a broadcast held on the slate, or a private test).`);
    const remaining = budgetMs - waited;
    if (remaining <= 0) {
      log(BUSY_ERROR);
      return { exitCode: 1, outcome: 'busy' };
    }
    await sleep(Math.min(pollMs, remaining));
  }
}

function writeStepSummary(result) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const text = {
    busy: '### Deploy held\n\nA broadcast or a private test is on the air, so nothing was deployed. Re-run this workflow when it has ended (see docs/deploy-safety.md).\n',
    unreachable: '### Deploy continued\n\nThe media server could not be reached, so there was no broadcast to protect.\n',
    unknown: '### Deploy continued\n\nThe media server did not say whether a broadcast is on the air. The deploy went on.\n',
  }[result.outcome];
  if (!text) return;
  try {
    appendFileSync(file, `${text}\n`);
  } catch {
    // The summary is a courtesy; never fail the hold because of it.
  }
}

async function main() {
  const budgetMs = positiveNumber(process.env.MEDIA_IDLE_BUDGET_MINUTES, DEFAULT_BUDGET_MINUTES) * 60_000;
  const pollMs = positiveNumber(process.env.MEDIA_IDLE_POLL_SECONDS, DEFAULT_POLL_SECONDS) * 1000;
  const url = process.env.MEDIA_METRICS_URL || MEDIA_METRICS_URL;
  const result = await waitForIdleMedia({
    budgetMs,
    pollMs,
    readActivity: () => readMediaActivity({ url }),
  });
  writeStepSummary(result);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
