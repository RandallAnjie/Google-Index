// GoIndex Extended — Module Worker entry point.
//
// fetch(request, env, ctx) is what Cloudflare / RandallFlare hand us.
// env carries the runtime bindings (CLIENT_ID, REFRESH_TOKEN, ROOTS…),
// which is the entire point of the Module Worker contract over the
// legacy addEventListener('fetch', …) style.
//
// Config is built lazily on the first request per isolate and cached
// on module scope. Subsequent requests in the same isolate reuse it.
// router.handleRequest owns its own gds[] cache the same way.

import { buildConfig, classifyReason, unconfiguredHtml } from "./env.js";
import { handleRequest } from "./router.js";

let configCache = null;

export default {
  async fetch(request, env, _ctx) {
    if (!configCache) {
      try {
        configCache = buildConfig(env);
      } catch (e) {
        // CRITICALLY: do not echo e.message to the visitor. Earlier
        // versions surfaced parser errors containing the actual ROOTS
        // bytes — a deployment-time mistake that would publish env
        // values (including any auth maps inside ROOTS) to anyone who
        // hit the URL before configuration finished. The operator
        // sees the full reason in worker logs; the visitor sees a
        // categorised reason via classifyReason().
        console.error("[goindex] unconfigured: " + (e && e.message));
        return new Response(unconfiguredHtml(classifyReason(e)), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
    }
    return handleRequest(request, configCache);
  },
};
