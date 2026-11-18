#!/usr/bin/env node
/**
 * Shared `npm start` entry after migrations. Configure the listener before the
 * built server is imported: a local runtime must never inherit a public bind.
 * Hosted deployments retain the existing all-interface listener. The desktop
 * launcher still owns its token, credentials, port discovery and runtime.json.
 */
const localRuntime = (process.env.BZ_RUNTIME ?? "").trim().toLowerCase() === "local";
const host = localRuntime ? "127.0.0.1" : "0.0.0.0";
process.env.HOST = host;
process.env.NITRO_HOST = host;

// Same process, so server signals and exit status need no forwarding wrapper.
await import("../.output/server/index.mjs");
