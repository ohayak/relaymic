#!/bin/sh
# Runs every end-to-end suite, one at a time (they share the test ports
# 7620/7621 and 7631-7641), after rebuilding the harness from the working
# tree (it embeds internal/web). Logs go to $S/e2e/logs/<suite>.log; the last
# line of each says PASSED or FAILED. Pass suite names to run only those:
#   e2e/suites/run-all.sh microphone speaker
# Never touches the installed Remote Visio (7420/7421): see lib.mjs.
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
S=${S:-/private/tmp/claude-502/-Users-omar-Workspace-relaymic/aa7f9c6c-b68e-4019-a660-1cab91ee4d53/scratchpad}
logs="$S/e2e/logs"
mkdir -p "$logs"
(cd "$repo" && go build -tags nolibopusfile -o e2e/.local/harness ./e2e/harness) || exit 1
all="e2e robust security consent dualcopy latestart refused senderdebug zipcheck microphone speaker orphan legacy pickers sendermeet senderedge extension/suite extension/dual"
failed=""
for s in ${*:-$all}; do
    log="$logs/$(echo "$s" | tr / -).log"
    (cd "$here/$(dirname "$s")" && node "$(basename "$s").mjs" >"$log" 2>&1)
    code=$?
    echo "$s: exit $code ($(grep -cE '^PASS|"ok": true' "$log") passed, $(grep -cE '^FAIL|"ok": false' "$log") failed) $log"
    [ "$code" -eq 0 ] || failed="$failed $s"
done
[ -z "$failed" ] || { echo "FAILED:$failed"; exit 1; }
echo "ALL PASSED"
