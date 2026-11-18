import { definePlugin } from "nitro";
import { htmlAliasLocation } from "./page-alias";

/**
 * Nitro 3.0.260603-beta prepends its static handler before user middleware.
 * A redirect in pages.nitro.ts alone is therefore unreachable for shipped HTML.
 * Wrap the public fetch entry before the static pipeline, leaving every request
 * other than a known GET/HEAD HTML alias on the original app path unchanged.
 * Builtin route-rule redirects are unsuitable here: this pinned version has no
 * method-scoped rules and reconstructs queries with Object.fromEntries.
 */
export default definePlugin((app) => {
  const originalFetch = app.fetch.bind(app);
  app.fetch = (request) => {
    const requestUrl = request.url.split("#", 1)[0];
    const queryAt = requestUrl.indexOf("?");
    const target = new URL(requestUrl).pathname + (queryAt < 0 ? "" : requestUrl.slice(queryAt));
    const location = htmlAliasLocation(target, request.method);
    if (location) return new Response(null, { status: 302, headers: { location } });
    return originalFetch(request);
  };
});
