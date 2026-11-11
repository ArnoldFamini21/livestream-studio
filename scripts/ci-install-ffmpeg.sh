#!/bin/sh
# FFmpeg for CI and deploy jobs: two independent sources, each bounded in time.
#
#   1. Ubuntu packages. On success FFMPEG_BIN=/usr/bin/ffmpeg is exported to the
#      following steps, so ffmpeg-static uses the system binary and skips its
#      own download.
#   2. If the Ubuntu mirror cannot deliver in time, FFMPEG_BIN stays unset and
#      ffmpeg-static downloads its binary from GitHub releases during `npm ci`
#      (scripts/npm-ci-retry.sh retries that download).
#
# GitHub releases answered 504 for hours on 2026-11-08. On 2026-11-11 the
# runners could not resolve the Ubuntu mirror for an hour and an unbounded
# `apt-get install` kept retrying until the whole job timed out, twice in a row.
# Neither outage should fail a job by itself, and neither may stall one.
#
# This script always exits 0: a missing system FFmpeg is not an error here,
# because `npm ci` then fetches the other source and fails loudly if it cannot.
set -u

system_ffmpeg="${FFMPEG_SYSTEM_PATH:-/usr/bin/ffmpeg}"
update_seconds="${FFMPEG_APT_UPDATE_SECONDS:-75}"
install_seconds="${FFMPEG_APT_INSTALL_SECONDS:-180}"

# Running the binary (not only finding the file) also catches an install that a
# time limit interrupted halfway, which leaves a file that cannot load its libraries.
ffmpeg_works() {
  [ -x "$system_ffmpeg" ] && "$system_ffmpeg" -version >/dev/null 2>&1
}

use_system_ffmpeg() {
  echo "Using $("$system_ffmpeg" -version 2>/dev/null | head -n 1) at $system_ffmpeg"
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "FFMPEG_BIN=$system_ffmpeg" >> "$GITHUB_ENV"
  fi
  exit 0
}

# `timeout` runs under sudo so that it signals apt-get directly.
bounded_apt_get() {
  seconds="$1"
  shift
  sudo timeout -k 10 "$seconds" apt-get \
    -o Acquire::Retries=2 \
    -o Acquire::http::Timeout=20 \
    -o Acquire::https::Timeout=20 \
    -o DPkg::Lock::Timeout=30 \
    "$@"
}

if ffmpeg_works; then use_system_ffmpeg; fi

if bounded_apt_get "$update_seconds" update -qq; then
  bounded_apt_get "$install_seconds" install -y -qq ffmpeg \
    || echo "apt-get install ffmpeg did not finish (status $?)." >&2
else
  # An index refresh that cannot finish means the mirror is unreachable; the
  # package download would only wait out its own time limit as well.
  echo "apt-get update did not finish (status $?); skipping the package install." >&2
fi

if ffmpeg_works; then use_system_ffmpeg; fi

echo "::warning::FFmpeg could not be installed from Ubuntu packages in time. ffmpeg-static will download it from GitHub releases during npm ci."
exit 0
