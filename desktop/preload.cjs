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
// A one-way main notification, not an API by which pages can authorize downloads.
ipcRenderer.on("beezilla:original-download:refused", (_event, data) => {
  try {
    if (!process.isMainFrame || data?.code !== "original_changed" || data.pageUrl !== window.location.href) return;
    const url = new URL(data.url), page = new URL(window.location.href);
    if (url.username || url.password || page.username || page.password || url.origin !== page.origin || url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
        !/^\/buzzy\/talk(?:\.html)?\/?$/.test(page.pathname) || url.hash ||
        !/^\/api\/buzzy\/jobs\/[A-Za-z0-9_-]+\/document$/.test(url.pathname) ||
        !/^\?original=[a-f0-9]{64}$/.test(url.search)) return;
    const links = [...document.querySelectorAll('#chatMessages .file-card a[download]')].filter(link => link.isConnected && link.href === url.href);
    if (links.length !== 1) return;
    for (const link of links) {
      const card = link.closest(".file-card");
      if (!card || !link.isConnected) continue;
      const meta = card.querySelector(".file-meta");
      if (!meta) continue;
      let notice = meta.querySelector(".original-download-error");
      if (!notice) {
        notice = document.createElement("div");
        notice.className = "original-download-error";
        notice.setAttribute("role", "status");
        meta.appendChild(notice);
      }
      notice.textContent = "This original file has changed or is unavailable. Open the latest file card; no replacement was downloaded.";
    }
  } catch { /* A retired page or malformed notification cannot affect a new card. */ }
});
const call = async (channel, payload) => {
  pendingCalls++;
  try { return await ipcRenderer.invoke(`beezilla:${channel}`, payload); }
  finally { pendingCalls--; navigateWhenIdle(); }
};

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
