#!/bin/sh
# Runs direct mode's checks (docs/DESIGN-direct-mode.md, section
# 11), one at a time: they share the builders' test ports 7660 to 7669, which
# are checked first. The sender app (the relay Worker's build, relay/) is
# built first when its sources changed. Logs go to
# $S/e2e/logs/direct-<name>.log ($DIRECT_LOGS to keep a run's logs apart);
# the last line of each says PASSED or FAILED (the Node tests: "# fail 0").
# Pass names to run only those:
#   e2e/direct/run-direct.sh pairing media
# Names, in the default order:
#   units      protocol.js (B0) and the hub's pure modules (B2), in Node
#   site       the site's Worker (site/worker/index.js: the /send redirect
#              and the site's own redirects) in Node, no wrangler
#   relay      the relay Worker against wrangler dev (B1's relay/test)
#   pairing media reconnect security turn coexist cpu
#              the browser suites (the [A] checks of section 11.4; cpu
#              measures one camera leg)
#   lifetime   L1 and L2: about 13 minutes, the hub idle for 10
#   m4         check M4: the receiver-mode sender suites (senderdebug,
#              pickers, sendermeet, senderedge) through ../suites/run-all.sh,
#              on its own test ports 7620/7621
# Never touches the installed Remote Visio (7420/7421), never deploys.
set -u
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
S=${S:-/private/tmp/claude-502/-Users-omar-Workspace-relaymic/aa7f9c6c-b68e-4019-a660-1cab91ee4d53/scratchpad}
export S
logs=${DIRECT_LOGS:-$S/e2e/logs}
mkdir -p "$logs" "$S/direct"
all="units site relay pairing media reconnect security turn coexist cpu lifetime m4"

# Another run, a harness or an agent on the test ports would answer this
# run's pages and sockets: nothing starts then.
busy=""
for p in 7660 7661 7662 7663 7664 7665 7666 7667 7668 7669; do
    lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && busy="$busy tcp/$p"
done
for p in 7664 7665 7666 7669; do
    lsof -nP -iUDP:$p >/dev/null 2>&1 && busy="$busy udp/$p"
done
[ -z "$busy" ] || { echo "test ports in use:$busy; not running"; exit 3; }

# The sender app as the relay Worker serves it (relay/scripts/build-sender.mjs
# into relay/dist/), when one of its sources is newer than the last build.
node --input-type=module -e "const k = await import('$here/kit.mjs'); k.buildApp();" >"$logs/direct-build.log" 2>&1 || {
    echo "the sender app's build failed: $logs/direct-build.log"; exit 1;
}

failed=""
for s in ${*:-$all}; do
    log="$logs/direct-$s.log"
    case "$s" in
    units)
        node --test --test-reporter=tap "$here/protocol.test.mjs" "$here/hub-units.test.mjs" >"$log" 2>&1
        code=$?
        echo "$s: exit $code ($(sed -n 's/^# pass //p' "$log") passed, $(sed -n 's/^# fail //p' "$log") failed) $log" ;;
    site)
        # Pure Node: the site's Worker with a fake ASSETS binding.
        (cd "$repo/site" && node --test --test-reporter=tap worker/test/site.test.mjs) >"$log" 2>&1
        code=$?
        echo "$s: exit $code ($(sed -n 's/^# pass //p' "$log") passed, $(sed -n 's/^# fail //p' "$log") failed) $log" ;;
    relay)
        # Its own wrangler dev (the relay's, from relay/) on 7660/7661, with
        # state, configuration and logs under the scratchpad.
        rm -rf "$S/direct/relay-test"
        (cd "$repo/relay" && RELAY_TEST_DIR="$S/direct/relay-test" node --test --test-reporter=tap test/relay.test.mjs) >"$log" 2>&1
        code=$?
        echo "$s: exit $code ($(sed -n 's/^# pass //p' "$log") passed, $(sed -n 's/^# fail //p' "$log") failed) $log" ;;
    m4)
        "$here/../suites/run-all.sh" senderdebug pickers sendermeet senderedge >"$log" 2>&1
        code=$?
        echo "$s: exit $code ($(tail -1 "$log")) $log" ;;
    *)
        if [ ! -f "$here/$s.mjs" ]; then echo "$s: no such suite"; failed="$failed $s"; continue; fi
        node "$here/$s.mjs" >"$log" 2>&1
        code=$?
        echo "$s: exit $code ($(grep -c '^PASS' "$log") passed, $(grep -c '^FAIL' "$log") failed) $log" ;;
    esac
    [ "$code" -eq 0 ] || failed="$failed $s"
done
[ -z "$failed" ] || { echo "FAILED:$failed"; exit 1; }
echo "ALL PASSED"
