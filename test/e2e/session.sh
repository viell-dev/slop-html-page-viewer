#!/bin/sh
# Runs the end-to-end suite on Linux. Without a display, it starts Xvfb as a
# virtual X server and herbstluftwm as the window manager, which Obsidian needs
# for focus and window events. CI and the Docker image both run this script;
# arguments go to `wdio run`. Afterwards it compares the archive corpus's results
# with the prototype's (corpus/compare.mjs).
set -eu

# Obsidian serves files whose paths are not ASCII only under a UTF-8 locale.
export LANG=C.UTF-8 LC_ALL=C.UTF-8

if [ -z "${DISPLAY:-}" ]; then
  export DISPLAY=:99
  Xvfb "$DISPLAY" -screen 0 1600x1000x24 -nolisten tcp -noreset \
    >/tmp/html-page-viewer-xvfb.log 2>&1 &
  tries=0
  until xset q >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 40 ]; then
      echo "Xvfb did not start:" >&2
      cat /tmp/html-page-viewer-xvfb.log >&2
      exit 1
    fi
    sleep 0.25
  done
  herbstluftwm >/tmp/html-page-viewer-wm.log 2>&1 &
fi

cd "$(dirname "$0")"
status=0
npx wdio run wdio.conf.mts "$@" || status=$?
# Compares the corpus results with the prototype's, when both ran.
node corpus/compare.mjs "${E2E_OUTPUT_DIR:-../../test-results/e2e}" || status=1
exit "$status"
