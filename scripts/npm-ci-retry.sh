#!/bin/sh
# npm ci with retries. Some dependencies (ffmpeg-static) download binaries from
# GitHub releases during install; a short GitHub outage (HTTP 5xx) should not
# fail a deploy or every PR's CI. Arguments are passed through to npm ci.
set -u
attempt=1
while :; do
  if npm ci "$@"; then exit 0; fi
  if [ "$attempt" -ge 3 ]; then
    echo "npm ci failed after $attempt attempts" >&2
    exit 1
  fi
  delay=$((attempt * 30))
  echo "npm ci failed (attempt $attempt); retrying in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
