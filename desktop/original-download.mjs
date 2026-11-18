
// This observer receives the actual authorization result, never renderer claims.
// It only handles the pinned-original route's explicit stale-file HTTP response.
export function createOriginalDownloadRefusal({ getBinding, getContents, notify, isTrustedSender, webUrl, now = Date.now }) {
  for (const fn of [getBinding, getContents, notify, isTrustedSender, webUrl, now])
    if (typeof fn !== "function") throw new TypeError("Original download refusal requires explicit trusted dependencies.");
  const pending = new Map(), intents = new Map();
  const prune = () => { for (const map of [pending, intents]) for (const [id, p] of map) if (p.expires < now()) map.delete(id); };
  function pinned(value, base) {
    const url = webUrl(value);
    return url && url.origin === base && !url.hash &&
      /^\/api\/buzzy\/jobs\/[A-Za-z0-9_-]+\/document$/.test(url.pathname) &&
      /^\?original=[a-f0-9]{64}$/.test(url.search);
  }
  return {
    clear() { pending.clear(); intents.clear(); },
    forgetContents(wc) { for (const map of [pending, intents]) for (const [id, p] of map) if (p.wc === wc) map.delete(id); },
    finished(details) { pending.delete(details.id); },
    prepare(wc, url, headers) {
      prune();
      const binding = getBinding(), nonce = headers?.["X-BeeZilla-Download"];
      if (binding && pinned(url, binding.base) && typeof nonce === "string" && nonce &&
          getContents().includes(wc) && !wc.isDestroyed() && intents.size < 64)
        intents.set(nonce, { binding, wc, url, expires: now() + 10000 });
    },
    authorizeRequest(details, authorization) {
      pending.delete(details.id); prune();
      const binding = getBinding();
      const nonceHeaders = Object.entries(details.requestHeaders ?? {}).filter(([key]) => key.toLowerCase() === "x-beezilla-download");
      const nonce = nonceHeaders.length === 1 ? nonceHeaders[0][1] : null;
      const intent = intents.get(nonce);
      for (const [, value] of nonceHeaders) intents.delete(value);
      const wc = getContents().find(w => !w.isDestroyed() && w.id === details.webContentsId);
      const bearer = Object.entries(authorization.requestHeaders ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
      // Chromium's trusted <a download> path has no main-issued nonce. Keep it
      // distinct from prepared downloads: any nonce header excludes this path,
      // including empty, duplicate, expired and otherwise invalid nonces.
      const direct = nonceHeaders.length === 0 && details.resourceType === "other" &&
        !!wc && details.webContents === wc && !!details.frame && details.frame === wc.mainFrame;
      const prepared = nonceHeaders.length === 1 && !!intent && intent.expires >= now() &&
        intent.binding === binding && intent.wc === wc && intent.url === details.url;
      if (!binding || (!direct && !prepared) || authorization.cancel || details.method !== "GET" || !Number.isInteger(details.id) ||
          !pinned(details.url, binding.base) || bearer !== "Bearer " + binding.token ||
          !wc || (details.webContents && details.webContents !== wc) ||
          !isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, { base: binding.base, contents: getContents() }) ||
          pending.size >= 128) return authorization;
      pending.set(details.id, { path: direct ? "direct-native-link" : "prepared-native", resourceType: details.resourceType, binding, wc, frame: wc.mainFrame, page: wc.getURL(), url: details.url, expires: now() + 10000 });
      return authorization;
    },
    headers(details) {
      const p = pending.get(details.id); pending.delete(details.id);
      if (!p || p.expires < now() || details.statusCode !== 409 || details.method !== "GET" ||
          details.url !== p.url || details.webContentsId !== p.wc.id ||
          (p.path === "direct-native-link" && (details.resourceType !== p.resourceType ||
            details.frame !== p.frame || details.webContents !== p.wc)) ||
          (details.webContents && details.webContents !== p.wc) || getBinding() !== p.binding ||
          p.wc.isDestroyed() || !getContents().includes(p.wc) || p.wc.mainFrame !== p.frame ||
          p.wc.getURL() !== p.page || !isTrustedSender({ sender: p.wc, senderFrame: p.frame }, { base: p.binding.base, contents: getContents() })) return {};
      // Fixed text lives in preload. No runtime credential or response body crosses IPC.
      try { notify(p.wc, { code: "original_changed", url: p.url, pageUrl: p.page }); } catch { /* cancellation must still occur */ }
      return { cancel: true };
    },
  };
}
