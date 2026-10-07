// send.remotevisio.com Worker ("remotevisio-relay" in wrangler.jsonc): the
// sender app and the direct-mode relay, on a host of their own. Every
// request goes to handleApp (app.js), whatever hostname it came for: the
// custom domain is this Worker's only route, and under wrangler dev (no
// routes) the hostname is the one the client sent (send.localhost:7660 for
// the suites). The site, remotevisio.com, is another Worker
// (../../site/worker/index.js), which only sends /send here.
// The design is bin/e2e-harness/DESIGN-direct-mode.md, sections 4 and 8.4.

import { handleApp } from "./app.js";

// Durable Object classes must be exported from the main module. Every other
// named export of this module would be taken for an entrypoint (workerd
// refuses to start on a constant), so nothing else here is exported.
export { RelayRoom } from "./room.js";

export default {
  fetch(request, env, ctx) {
    return handleApp(request, env, ctx);
  },
};
