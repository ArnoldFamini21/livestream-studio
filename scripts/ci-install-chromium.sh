#!/bin/sh
# Chromium for the browser jobs, bounded in time.
#
# `--with-deps` installs Chromium's system libraries through apt before it
# downloads the browser. When the Ubuntu mirror is unreachable that apt run
# keeps retrying until the whole job times out. So it gets a time limit, and if
# it does not finish the browser is installed alone: GitHub's runner image
# already carries the libraries for its own Chrome, and a library that is still
# missing fails the browser launch with a clear message instead of stalling.
set -u

deps_seconds="${CHROMIUM_DEPS_SECONDS:-240}"

timeout -k 10 "$deps_seconds" npx playwright-core install --with-deps chromium && exit 0
status=$?

echo "::warning::Chromium's system libraries could not be installed in time (status $status). Installing the browser alone."
exec npx playwright-core install chromium
