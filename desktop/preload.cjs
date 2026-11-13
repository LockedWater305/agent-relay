/**
 * Preload — the ONLY privileged surface the page gets.
 *
 * CommonJS on purpose: a sandboxed renderer cannot load an ESM preload, and the
 * failure is silent — `window.beezilla` is simply undefined while the window
 * looks fine. Sandboxing wins over module style, so this file stays .cjs.
 *
 * Earlier the app tried to inject the auth header by patching `window.fetch`
 * here, which failed: with contextIsolation the preload's `fetch` is a different
 * JS world from the page's. Network auth now happens in
 * `session.onBeforeSendHeaders`. What a preload IS for is exactly this: a narrow,
 * explicit IPC bridge.
 *
 * Every method returns a promise and the main process answers
 * `{ ok, data }` / `{ ok: false, error }` — no silent `false`, so a settings form
 * can show the real error instead of "something went wrong".
 */
const { contextBridge, ipcRenderer } = require("electron");

let pendingCalls = 0;
let nextRuntimeUrl = null;
let navigationTimer = null;
function navigateWhenIdle() {
  if (pendingCalls || !nextRuntimeUrl || navigationTimer) return;
  navigationTimer = setTimeout(() => {
    navigationTimer = null;
    if (pendingCalls || !nextRuntimeUrl) return;
    const target = nextRuntimeUrl;
    nextRuntimeUrl = null;
    window.location.replace(target);
  }, 0);
}
ipcRenderer.on("beezilla:runtime:changed", (_event, data) => {
  // This event is main -> preload only. Do not expose an unrestricted event or
  // navigation API to the page, and refuse malformed endpoints defensively.
  try {
    const url = new URL(data?.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || !/^\/buzzy(?:\/[a-z-]+(?:\.html)?)?\/?$/.test(url.pathname)) return;
    nextRuntimeUrl = url.href;
    navigateWhenIdle();
  } catch { /* invalid event: remain on the current page */ }
});
// Every page-to-main call is counted here, so a runtime navigation waits for its reply.
const invoke = async (channel, payload) => {
  pendingCalls++;
  try { return await ipcRenderer.invoke(channel, payload); }
  finally { pendingCalls--; navigateWhenIdle(); }
};
const call = (channel, payload) => invoke(`beezilla:${channel}`, payload);

// Even a same-origin subframe is not a privileged app window.
if (process.isMainFrame) contextBridge.exposeInMainWorld("beezilla", {
  settings: {
    get: () => call("settings:get"),
    saveInference: (cfg) => call("settings:saveInference", cfg),
    saveSearch: (cfg) => call("settings:saveSearch", cfg),
    /** ElevenLabs key for the Music button — the local runtime has no env of its own */
    saveMusic: (cfg) => call("settings:saveMusic", cfg),
    clear: (kind) => call("settings:clear", kind),
    /** sign in on our site and store the short-lived inference token */
    connect: () => call("settings:connect"),
  },
  app: {
    version: () => call("app:version"),
    /** where main.log lives — so a bug report can name a file instead of a symptom */
    logs: () => call("app:logPath"),
    openLogs: () => call("app:openLogs"),
    /** write a line into main.log from the page — mic and transcriber diagnostics */
    log: (message) => call("app:log", message),
  },
});

// Folder access (desktop/folders-ipc.mjs). The bridge is exposed only in the top frame of a window
// whose origin is the runtime origin that main reports for that window right now. Main answers
// synchronously because the runtime port can change on a restart, so a value fixed when the window
// was created could be stale. Main checks the sender again on every call. The channel names are
// repeated here because a sandboxed preload cannot import desktop/folders-ipc.mjs.
function folderOrigin() {
  try {
    const origin = ipcRenderer.sendSync("bz-folders:origin");
    return typeof origin === "string" && origin === window.location.origin ? origin : null;
  } catch {
    return null;
  }
}

if (process.isMainFrame && folderOrigin() !== null) contextBridge.exposeInMainWorld("beezillaFolders", {
  pick: () => invoke("bz-folders:pick"),
  list: () => invoke("bz-folders:list"),
  activate: (id) => invoke("bz-folders:activate", { id }),
  pause: (id) => invoke("bz-folders:pause", { id }),
  resume: (id) => invoke("bz-folders:resume", { id }),
  revoke: (id) => invoke("bz-folders:revoke", { id }),
  listDir: (id, path) => invoke("bz-folders:listDir", { id, path }),
  readFile: (id, path, options) => invoke("bz-folders:readFile", { id, path, options }),
  search: (id, query, options) => invoke("bz-folders:search", { id, query, options }),
  activity: () => invoke("bz-folders:activity"),
  /** Each broker entry as it happens. Returns the function that stops the callback. */
  onActivity(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on("bz-folders:activity-event", listener);
    return () => { ipcRenderer.removeListener("bz-folders:activity-event", listener); };
  },
});
