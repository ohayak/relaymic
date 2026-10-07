Guidance for the relay Worker (`remotevisio-relay`, send.remotevisio.com): the direct-mode relay and the sender app it serves. Design: `../bin/e2e-harness/DESIGN-direct-mode.md`; build, run and deploy: `README.md`.

- **Never** `wrangler deploy`, `wrangler login`, `wrangler secret`, `wrangler telemetry` or any upload from an agent: a human deploys (README.md). A `wrangler deploy --dry-run` only with `XDG_CONFIG_HOME`, `WRANGLER_LOG_PATH` and `--outdir` all under the session scratchpad.
- `wrangler dev` only with its state, configuration and logs under the session scratchpad: `--persist-to <scratchpad>/...`, `XDG_CONFIG_HOME=<scratchpad>/...`, `WRANGLER_LOG_PATH=<scratchpad>/...`, `WRANGLER_SEND_METRICS=false`. Never write under `~/.wrangler` or `~/Library/Preferences/.wrangler`.
- Test ports 7660 to 7679 only: 7660/7661 for `wrangler dev` and its inspector (the browser checks use 7660 to 7669, reviewers 7670 to 7679). **Never 7420 or 7421**: the user's installed Remote Visio listens there. Check with `lsof -nP -iTCP:<port> -sTCP:LISTEN` before starting anything, never run two `wrangler dev` at once, and leave nothing listening afterwards (`pgrep -fl workerd` must print nothing of yours).
- Never point a test at `send.remotevisio.com` or `remotevisio.com`: the dev conditions hold only on local hostnames, and nothing here may touch the live relay.
- `npm run build` before `wrangler dev` (the tests build when `dist/` is missing); `dist/` is generated, `send-manifest.json` is tracked and must be committed with every change of the app's sources.
- `src/relay.js` and `src/room.js` import `../../browser-extension/direct/protocol.js`: the protocol is the extension's file, never a copy.
- Never log frames, room ids, peer ids, tokens or tickets: only error codes.
