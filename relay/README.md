# Remote Visio relay (`remotevisio-relay`)

The Cloudflare Worker behind **send.remotevisio.com**: the direct-mode relay (`/relay/v1/*`, one `RelayRoom` Durable
Object per room) and the sender app it serves at `/` (built from `../internal/web` into `dist/`). It is a Worker of
its own, apart from the site's (`../site`, `remotevisio-site`, remotevisio.com): the app and the relay share one origin
by design (the app's CSP allows `'self'` and its own WebSocket host only, there is no CORS, and no third-party script of
the site ever reaches the storage that holds the pairing keys), and a custom domain belongs to one Worker. The design
is `../bin/e2e-harness/DESIGN-direct-mode.md` (§4 the relay, §8.4 the app's build and headers, §12 the deploy
checklist); the browser checks are in `../bin/e2e-harness/direct/`.

## Layout

| Path | What |
|---|---|
| `wrangler.jsonc` | the Worker: assets from `dist/`, the custom domain, the Durable Object and its migration, the rate limits, the vars, observability; `env.dev` for `wrangler dev` |
| `src/index.js` | the entry: exports `RelayRoom`, hands every request to `handleApp` |
| `src/app.js` | the app host: `/` (the app page; `data-nav` for a navigation from another site), `/send/*.js`, the icons, `robots.txt`, the app's headers on every answer |
| `src/relay.js` | `/relay/v1/*`: health, Origin and role checks, ids, rate limits, the upgrade handed to the room |
| `src/room.js` | `RelayRoom`: mailboxes and pair rooms |
| `scripts/build-sender.mjs` | builds `dist/` (the app under `send/`, the site's icons beside it) and `send-manifest.json` from `../internal/web`, `../browser-extension/direct/protocol.js` and `../site/public` |
| `scripts/verify-send.mjs` | checks a live app host against `send-manifest.json` |
| `send-manifest.json` | the SHA-256 of every file the app host serves (tracked, deterministic; committed with every deploy) |
| `test/relay.test.mjs` | the relay tests: unit tests of `handleRelay`, then everything against a `wrangler dev` of their own |
| `.dev.vars.example` | the development variables (copy to `.dev.vars`, which git ignores) |

`src/relay.js` and `src/room.js` import `../../browser-extension/direct/protocol.js` (wrangler bundles it): the
protocol is the extension's file, not a copy.

## Build, run, test

Node 25 and `npm install` (it installs wrangler, nothing else).

```sh
npm run build        # dist/ and send-manifest.json; again whenever internal/web or protocol.js changes
npm run dev          # wrangler dev --env dev on http://send.localhost:7660 (inspector 7661): the app at /, the relay at /relay/v1/*
npm test             # the relay tests, with their own wrangler dev on 7660/7661 (the ports must be free)
npm run verify-send  # compares https://send.remotevisio.com with send-manifest.json (another origin as the argument)
```

The dev environment has no routes, so the Worker sees the hostname the client sent, and serves the app and the relay
on all of them; the dev conditions (`DEV=1` and the `DEV_*` variables, from `.dev.vars` or `--var`) hold only on
`127.0.0.1`, `localhost` and `*.localhost`. `wrangler dev` keeps its state in `.wrangler/` here unless `--persist-to`
says otherwise; the tests and the browser checks run it with its state, configuration and logs under the session's
scratchpad (`CLAUDE.md` says how). The site is not part of this Worker: `http://send.localhost:7660/privacy` is a 404.

## Deploy (a human, never an agent)

In this order, with the scoped API token of §8.4 of the design:

1. A clean working tree at a reviewed commit; `npm run build`; `send-manifest.json` committed with it.
2. **The custom domain belongs to this Worker only.** If `send.remotevisio.com` was ever deployed as a route of
   `remotevisio-site` (the site's `wrangler.jsonc` listed it before the relay became a Worker of its own), remove it
   there first, in the Cloudflare dashboard (Workers & Pages, `remotevisio-site`, Settings, Domains & Routes).
   Otherwise `wrangler deploy` reports the conflict. The zone must be in the same Cloudflare account.
3. Once: decide `TURN_ENABLED` (§16 of the design); if on, `npx wrangler secret put TURN_KEY_ID` and
   `TURN_KEY_API_TOKEN` (phase B: the TURN routes are not built yet).
4. `npx wrangler deploy`, from this folder (wrangler notes that the file also defines the `dev` environment: the
   top-level one is production, and `--env ""` names it explicitly). The first deploy creates the `RelayRoom` class
   (migration `v1`). A deploy disconnects every relay WebSocket; hubs and senders reconnect with backoff.
5. `npm run verify-send`; open Workers Logs and check that a relay request shows `/relay/v1/mailbox` without `?id=`
   (§4.3 of the design; if it does not, set `observability.logs.invocation_logs` to `false`).
6. The site is deployed on its own, from `../site` (`npm run build && npx wrangler deploy`): its `/send` redirect
   points here, nothing else of it depends on this Worker.
