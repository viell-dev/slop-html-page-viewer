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
  # One full-size window at a time: tiling would shrink each Obsidian window
  # whenever another test worker opens one, and reflow its pages mid-test.
  autostart=$(mktemp)
  printf '#!/bin/sh\nherbstclient set_layout max\nherbstclient set default_frame_layout max\n' >"$autostart"
  chmod 700 "$autostart"
  herbstluftwm --autostart "$autostart" >/tmp/html-page-viewer-wm.log 2>&1 &
fi

# wdio.conf.mts resolves a relative output directory against the repository
# root; resolve it the same way before leaving the root.
root=$(cd "$(dirname "$0")/../.." && pwd)
case "${E2E_OUTPUT_DIR:-}" in
  "") ;;
  /*) ;;
  *) E2E_OUTPUT_DIR="$root/$E2E_OUTPUT_DIR" ;;
esac
export E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-$root/test-results/e2e}"

cd "$(dirname "$0")"
status=0
npx wdio run wdio.conf.mts "$@" || status=$?
# Compares the corpus results with the prototype's, when both ran.
node corpus/compare.mjs "$E2E_OUTPUT_DIR" || status=1
exit "$status"
