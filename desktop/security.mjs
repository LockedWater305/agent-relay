/** Desktop trust boundaries. Pure functions keep the policy testable without Electron. */
import { randomUUID } from "node:crypto";
const UI_PAGES = new Set([
  "index", "talk", "memory", "remember", "experts", "library", "profile", "landing",
  "login", "recipes", "wallet", "upload", "graph", "settings", "capabilities",
  "project", "sketch", "studio",
]);

export function webUrl(value) {
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function runtimeOrigin(runtime) {
  if (!runtime || runtime.host !== "127.0.0.1" || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) {
    throw new Error("The local runtime returned an invalid loopback endpoint.");
  }
  return `http://127.0.0.1:${runtime.port}`;
}

export function sameOrigin(value, base) {
  const url = webUrl(value);
  const expected = webUrl(base);
  return Boolean(url && expected && url.origin === expected.origin);
}

/** Uploaded HTML and API responses are not privileged application pages. */
export function isAppPage(value, base) {
  if (!sameOrigin(value, base)) return false;
  const path = webUrl(value).pathname.replace(/\/$/, "");
  if (path === "/buzzy") return true;
  const match = /^\/buzzy\/([a-z-]+)(?:\.html)?$/.exec(path);
  return Boolean(match && UI_PAGES.has(match[1]));
}

export function safeExternalUrl(value) {
  return webUrl(value)?.href ?? null;
}

export function isAppDownload(value, base) {
  if (!sameOrigin(value, base)) return false;
  return /^\/api\/buzzy\/(?:assets\/\d+|documents\/doc_[A-Za-z0-9_-]+(?:\/(?:pack|check-sheet))?|jobs\/[A-Za-z0-9_-]+\/document|export)$/.test(webUrl(value).pathname);
}

export function connectBaseUrl(value) {
  const url = webUrl(value);
  const localTest = url?.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!url || (url.protocol !== "https:" && !localTest) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The BeeZilla account server must be an HTTPS origin (HTTP loopback is allowed for local tests).");
  }
  return url.origin;
}

export function isConnectNavigation(value, base) {
  const url = webUrl(value);
  // HTTPS OAuth redirects stay in a separate, unprivileged session. HTTP is
  // only allowed for the exact configured loopback fixture, never as a downgrade.
  return Boolean(url && (url.protocol === "https:" || sameOrigin(value, base)));
}

export function retargetAppPage(value, previousBase, nextBase, fallback = "/buzzy/talk") {
  const path = isAppPage(value, previousBase) ? webUrl(value) : null;
  const target = path ? `${nextBase}${path.pathname}${path.search}${path.hash}` : `${nextBase}${fallback}`;
  if (!isAppPage(target, nextBase)) throw new Error("Cannot navigate to a non-application page after restart.");
  return target;
}

/** Object identity + top frame + exact current origin, not a renderer-supplied ID. */
export function isTrustedSender(event, { base, contents, testPageUrl = null }) {
  try {
    const sender = event?.sender;
    const frame = event?.senderFrame;
    if (!sender || sender.isDestroyed() || !contents.includes(sender) || !frame || frame !== sender.mainFrame) return false;
    const trusted = (url) => isAppPage(url, base) || Boolean(testPageUrl && url === testPageUrl);
    return trusted(frame.url) && trusted(sender.getURL());
  } catch {
    return false;
  }
}

export function allowAudioPermission({ contents, webContents, base, permission, origin, details = {}, request = false }) {
  try {
    if (!webContents || webContents.isDestroyed() || !contents.includes(webContents) || !isAppPage(webContents.getURL(), base)) return false;
    if (details.isMainFrame !== true || !sameOrigin(origin, base)) return false;
    if (details.requestingUrl && !isAppPage(details.requestingUrl, base)) return false;
    if (details.securityOrigin && !sameOrigin(details.securityOrigin, base)) return false;
    if (permission === "audioCapture") return true;
    if (permission !== "media") return false;
    if (request) return Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === "audio");
    return details.mediaType === "audio";
  } catch {
    return false;
  }
}

/**
 * One listener survives runtime restarts. Never attach a local credential to a
 * cloud window, worker, subframe, remote request, or uploaded document. Remove
 * our own retired credentials too, in case a redirect retained a header.
 */
export function createRuntimeAuth({ getContents, testPageUrl = null }) {
  let runtime = null;
  const tokens = new Set();
  const downloads = new Map();
  return {
    clear() { runtime = null; downloads.clear(); },
    prepareDownload(contents, url) {
      if (!runtime || !getContents().includes(contents) || !isAppPage(contents.getURL(), runtime.base) || !isAppDownload(url, runtime.base)) throw new Error("That file cannot be downloaded from this window.");
      for (const [key, item] of downloads) if (item.expires < Date.now()) downloads.delete(key);
      if (downloads.size >= 64) throw new Error("Too many downloads are waiting. Try again in a moment.");
      const nonce = randomUUID();
      downloads.set(nonce, { url, id: contents.id, expires: Date.now() + 10_000 });
      return { "X-BeeZilla-Download": nonce };
    },
    bind(next) {
      const base = runtimeOrigin(next);
      if (typeof next.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(next.token)) throw new Error("The local runtime returned an invalid session token.");
      tokens.add(next.token);
      runtime = { base, token: next.token };
      return base;
    },
    headers(details) {
      const headers = { ...details.requestHeaders };
      let download = null;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "authorization" && tokens.has(String(headers[key]).replace(/^Bearer /i, ""))) delete headers[key];
        if (key.toLowerCase() === "x-beezilla-download") {
          download = downloads.get(headers[key]);
          downloads.delete(headers[key]);
          delete headers[key];
        }
      }
      if (!runtime || !sameOrigin(details.url, runtime.base)) return { requestHeaders: headers };
      const contents = getContents();
      const wc = contents.find((item) => !item.isDestroyed() && item.id === details.webContentsId);
      if (!wc || (details.webContents && details.webContents !== wc)) return { cancel: true };
      if (download && download.expires >= Date.now() && download.id === wc.id && download.url === details.url && isAppDownload(details.url, runtime.base)) {
        // downloadURL is initiated by main and may have no requesting frame.
      } else if (details.resourceType === "mainFrame") {
        if (!isAppPage(details.url, runtime.base) || (details.frame && details.frame !== wc.mainFrame)) return { cancel: true };
      } else {
        if (!isTrustedSender({ sender: wc, senderFrame: details.frame }, { base: runtime.base, contents, testPageUrl })) return { cancel: true };
        if (details.initiatorOrigin && !sameOrigin(details.initiatorOrigin, runtime.base)) return { cancel: true };
      }
      for (const key of Object.keys(headers)) if (key.toLowerCase() === "authorization") delete headers[key];
      headers.Authorization = `Bearer ${runtime.token}`;
      return { requestHeaders: headers };
    },
  };
}
