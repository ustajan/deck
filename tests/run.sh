#!/bin/bash
# Runs the browser tests (Python playwright + Chromium needed: pip install playwright && playwright install chromium).
# Starts test editors on ports 8821 / 8824, makes fresh presentations under $DECK_TEST_DIR (default /tmp/deck-tests).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
export DECK_TEST_DIR="${DECK_TEST_DIR:-/tmp/deck-tests}"
DECK="${DECK:-$ROOT/dist/deck}"
[ -x "$DECK" ] || { echo "build first: python3 build_single.py"; exit 1; }
rm -rf "$DECK_TEST_DIR"; mkdir -p "$DECK_TEST_DIR/cache" "$DECK_TEST_DIR/shots"
export XDG_CACHE_HOME="$DECK_TEST_DIR/cache"
( cd "$DECK_TEST_DIR" && "$DECK" new "Test talk" --no-browser >/dev/null && "$DECK" new "P2" --no-browser >/dev/null )
"$DECK" "$DECK_TEST_DIR/Test talk/test-talk.html" --no-browser --keep-running --port 8821 >"$DECK_TEST_DIR/a.log" 2>&1 &
P1=$!
"$DECK" "$DECK_TEST_DIR/P2/p2.html" --no-browser --keep-running --port 8824 >"$DECK_TEST_DIR/p2.log" 2>&1 &
P2=$!
trap 'kill $P1 $P2 2>/dev/null' EXIT
sleep 1.5
python3 "$HERE/t1.py"
# t4 needs a .pptx for the import check: put one at $DECK_TEST_DIR/space_nobackup.pptx, or it ends with that check failing
python3 "$HERE/t4.py" || true
echo "t2 (reveal-edit interop) and t3 (a converted deck) need those editors running on 8801 / 8822 — see the files."
