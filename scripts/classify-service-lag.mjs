#!/usr/bin/env node
// Which Render services need a deploy? The files of this push (as before), plus
// whatever each running service is still missing.
//
// Why: a deploy that was held (a broadcast was on the air) or that failed leaves
// a service on an older commit. The next push only lists its own files, so a
// service change from the earlier push would never go out. Each service reports
// the commit it runs in /health ("commit"). Files that changed between that
// commit and the new head, and that belong to the service, mean it is behind.
//
// classifyProductionChanges stays the only place that maps files to services.
// This script writes the same outputs as classify-production-changes.mjs
// (signaling_changed, media_changed, signaling_files, media_files).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyProductionChanges } from './classify-production-changes.mjs';

export const SIGNALING_HEALTH_URL = 'https://livestream-studio-server.onrender.com/health';
export const MEDIA_HEALTH_URL = 'https://livestream-studio-media-server.onrender.com/health';
// The media server answers /health only to a page on the studio's own origin.
export const MEDIA_HEALTH_HEADERS = { Origin: 'https://studio.arnoldfamini.com' };

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/** The commit string from a /health body, or null. It comes from the network: hex only, 7 to 40 characters. */
export function parseHealthCommit(body) {
  const commit = body && typeof body === 'object' ? body.commit : undefined;
  if (typeof commit !== 'string') return null;
  const trimmed = commit.trim();
  return COMMIT_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads the commit a service reports. Returns { commit } or { commit: null, reason }. */
export async function readServiceCommit({
  url,
  headers = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 45_000,
  attempts = 3,
  retryDelayMs = 5_000,
  sleep = defaultSleep,
}) {
  let reason = 'no attempt was made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      });
      const request = (async () => {
        const response = await fetchImpl(url, { headers, signal: controller.signal });
        const status = Number(response.status);
        if (status < 200 || status >= 300) return { status, body: null };
        return { status, body: await response.json() };
      })();
      request.catch(() => {});
      const { status, body } = await Promise.race([request, timeout]);
      if (status >= 200 && status < 300) {
        const commit = parseHealthCommit(body);
        return commit ? { commit } : { commit: null, reason: 'the health answer has no usable commit' };
      }
      reason = `HTTP ${status}`;
      if (status < 500 && status !== 429) return { commit: null, reason };
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  return { commit: null, reason: `${reason} (after ${attempts} attempts)` };
}

function git(args) {
  // No shell: the arguments go straight to git.
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The full id of a commit string if it names a commit that is in the history of
 * `head`; otherwise null. The string is checked as 7-40 hex characters before git sees it.
 */
export function resolveCommitInHistory(candidate, head, run = git) {
  if (typeof candidate !== 'string' || !COMMIT_PATTERN.test(candidate)) return null;
  try {
    const full = run(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).trim();
    if (!COMMIT_PATTERN.test(full)) return null;
    run(['merge-base', '--is-ancestor', full, head]);
    return full;
  } catch {
    return null;
  }
}

export function listChangedFiles(base, head, run = git) {
  return run(['diff', '--name-only', base, head]).split(/\r?\n/).filter(Boolean);
}

function unique(...lists) {
  return [...new Set(lists.flat())];
}

/**
 * Combines this push's classification with each service's own catch-up range.
 * Each range is classified separately by classifyProductionChanges; a service
 * redeploys when either range changed files in its paths.
 */
export function mergeServiceClassifications(push, signalingRange, mediaRange) {
  const signalingFiles = unique(push.signalingFiles, signalingRange ? signalingRange.signalingFiles : []);
  const mediaFiles = unique(push.mediaFiles, mediaRange ? mediaRange.mediaFiles : []);
  return {
    files: push.files,
    signalingChanged: signalingFiles.length > 0,
    mediaChanged: mediaFiles.length > 0,
    signalingFiles,
    mediaFiles,
  };
}

/**
 * For one service: the classification of the files between the commit it runs
 * and `head`, or null when that cannot be worked out (the caller then keeps what
 * the push alone says). Messages go to `log` as GitHub annotations.
 */
export async function classifyServiceRange({ name, url, headers, head, readCommit = readServiceCommit, resolve = resolveCommitInHistory, listFiles = listChangedFiles, log = console.log }) {
  const { commit, reason } = await readCommit({ url, headers });
  if (!commit) {
    log(`::warning::Could not read the commit the ${name} service runs (${reason}). Using only the files of this push for it.`);
    return null;
  }
  const base = resolve(commit, head);
  if (!base) {
    log(`::warning::The ${name} service reports commit ${String(commit).slice(0, 40)}, which is not in this history. Using only the files of this push for it.`);
    return null;
  }
  let files;
  try {
    files = listFiles(base, head);
  } catch (error) {
    log(`::warning::Could not compare ${base.slice(0, 7)} with ${head.slice(0, 7)} for the ${name} service (${error instanceof Error ? error.message : error}). Using only the files of this push for it.`);
    return null;
  }
  const classification = classifyProductionChanges(files);
  log(`The ${name} service runs ${base.slice(0, 7)}; ${files.length} file(s) changed since.`);
  return classification;
}

function parseArgs(argv) {
  const args = { githubOutput: '', files: [], head: '', skipLag: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--github-output') args.githubOutput = argv[++index] || '';
    else if (arg === '--head') args.head = argv[++index] || '';
    else if (arg === '--skip-lag') args.skipLag = true;
    else if (arg === '--files-from') args.files.push(...readFileSync(argv[++index] || '', 'utf8').split(/\r?\n/));
    else args.files.push(arg);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const push = classifyProductionChanges(args.files);
  let result = push;

  if (args.skipLag) {
    console.log('::notice::Catch-up of services that are behind is skipped for this run.');
  } else {
    try {
      if (!/^[0-9a-f]{40}$/i.test(args.head)) throw new Error('--head must be a full commit id');
      const [signalingRange, mediaRange] = await Promise.all([
        classifyServiceRange({ name: 'signaling', url: SIGNALING_HEALTH_URL, headers: {}, head: args.head }),
        classifyServiceRange({ name: 'media', url: MEDIA_HEALTH_URL, headers: MEDIA_HEALTH_HEADERS, head: args.head }),
      ]);
      result = mergeServiceClassifications(push, signalingRange, mediaRange);
      if (result.signalingChanged && !push.signalingChanged) console.log('::notice::The signaling service is behind main and will be deployed.');
      if (result.mediaChanged && !push.mediaChanged) console.log('::notice::The media service is behind main and will be deployed.');
    } catch (error) {
      // Never fail the deploy because the catch-up check broke: use this push alone, as before.
      console.log(`::warning::The catch-up check failed (${error instanceof Error ? error.message : error}). Using only the files of this push.`);
      result = push;
    }
  }

  if (args.githubOutput) {
    appendFileSync(args.githubOutput, [
      `signaling_changed=${result.signalingChanged}`,
      `media_changed=${result.mediaChanged}`,
      `signaling_files=${result.signalingFiles.join(',')}`,
      `media_files=${result.mediaFiles.join(',')}`,
    ].join('\n') + '\n');
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
