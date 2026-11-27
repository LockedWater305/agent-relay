/** Fixed desktop document drain, composed with the existing Library barrier.
 * No renderer IPC, arbitrary selector, token, URL or storage capability. */
import { randomUUID } from "node:crypto";
import { isTrustedSender } from "./security.mjs";

function pageScript(nonce, action) {
  return `(async () => {
    const nonce = ${JSON.stringify(nonce)};
    let item = window.__bzDesktopDocumentLease;
    ${action === "begin" ? `
    if (item && item.nonce !== nonce) throw new Error("Another desktop transition owns this document");
    const sketch = /^\\/buzzy\\/sketch(?:\\.html)?\\/?$/.test(location.pathname);
    const stage = sketch ? document.getElementById("stage") : null;
    const hook = stage?.bzDesktopSketch;
    if (sketch && (!stage?.isConnected || !hook)) throw new Error("Sketch is still loading. Retry after the board opens");
    item = { nonce, document, stage, hook };
    window.__bzDesktopDocumentLease = item;
    hook?.begin(nonce);` : `
    if (!item || item.nonce !== nonce || item.document !== document) throw new Error("The app document changed during saving");`}
    if (item.stage && (!item.stage.isConnected || document.getElementById("stage") !== item.stage || item.stage.bzDesktopSketch !== item.hook)) throw new Error("The Sketch page changed during saving");
    ${action === "drain" ? `if (item.hook && await item.hook.drain(nonce) !== true) throw new Error("Sketch changes are not safely saved. Use Save to retry");` : ""}
    if (window.__bzDesktopDocumentLease !== item || item.document !== document) throw new Error("The app document changed during saving");
    const state = item.hook ? item.hook.state(nonce) : null;
    return { href: location.href, sketch: Boolean(item.hook), state };
  })()`;
}

function releaseScript(nonce) {
  return `(() => {
    const item = window.__bzDesktopDocumentLease;
    if (item?.nonce !== ${JSON.stringify(nonce)} || item.document !== document) return;
    if (item.stage && document.getElementById("stage") === item.stage && item.stage.bzDesktopSketch === item.hook) item.hook.release(item.nonce);
    delete window.__bzDesktopDocumentLease;
  })()`;
}

export function createDocumentTransition({ getContents, getBase, getRuntime, acquireLibrary, onIdle = () => {}, testPageUrl = null, timeoutMs = 15_000 }) {
  let tail = Promise.resolve(), active = null, waiting = 0;
  const registered = new WeakSet();
  const held = () => Boolean(active || waiting);
  const owns = (wc) => getContents().includes(wc) && !wc.isDestroyed();
  function register(wc) {
    if (registered.has(wc)) return;
    registered.add(wc);
    const refuse = (event) => { if (held() && owns(wc)) event.preventDefault(); };
    for (const name of ["before-input-event", "before-mouse-event", "will-navigate", "will-frame-navigate", "will-redirect"]) wc.on(name, refuse);
  }
  function blocksRequest(details) {
    const wc = getContents().find((item) => !item.isDestroyed() && item.id === details.webContentsId);
    return Boolean(wc && held() && (details.resourceType === "mainFrame" || active?.sealed));
  }
  async function acquire(options = {}) {
    // A call, including one queued behind a prior lease, closes input/navigation
    // synchronously. Neither a renderer await nor a queued handoff opens a gap.
    waiting++;
    for (const wc of getContents()) register(wc);
    let unlock;
    const prior = tail;
    tail = new Promise((resolve) => { unlock = resolve; });
    await prior;
    waiting--;
    const lease = { nonce: randomUUID(), sealed: false };
    active = lease;
    const windows = [], rt = getRuntime(), base = getBase();
    const runtimeFields = rt && [rt.host, rt.port, rt.token];
    let library = null, released = false;
    const runtimeUnchanged = () => getRuntime() === rt && (!rt || [rt.host, rt.port, rt.token].every((value, i) => value === runtimeFields[i]));
    const trusted = (wc, origin) => isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, { base: origin, contents: getContents(), testPageUrl });
    function verifyOwner(item) {
      if (!owns(item.wc) || item.wc.mainFrame !== item.frame || item.wc.getURL() !== item.url || !trusted(item.wc, item.base)) throw new Error("The app window changed while saving. Retry from the current window.");
    }
    function acceptState(item, result) {
      // Only the first Save's own generated job may canonicalize a cold board.
      if (result?.href !== item.url && item.cold && /^job_art_[a-z0-9]+$/.test(result?.state?.jobId || "")) {
        const expected = new URL(item.url);
        expected.pathname = "/buzzy/sketch";
        expected.search = "?job=" + result.state.jobId;
        expected.hash = "";
        if (expected.href === result.href && item.wc.getURL() === result.href) item.url = result.href;
      }
      verifyOwner(item);
      if (!result || result.href !== item.url || typeof result.sketch !== "boolean") throw new Error("The app document could not confirm its saved state.");
      if (result.sketch && (!result.state || result.state.lease !== lease.nonce || typeof result.state.dirty !== "boolean")) throw new Error("Sketch could not confirm its saved state.");
      item.sketch = result.sketch;
      return result;
    }
    async function evaluate(item, action) {
      verifyOwner(item);
      const pending = item.wc.executeJavaScript(pageScript(lease.nonce, action));
      // A timed-out begin may still execute and reject after installing its
      // nonce. Both settlements need matching cleanup after release, never
      // while this lease is active or against a later lease/document.
      const cleanupLate = () => {
        if (released && owns(item.wc) && item.wc.mainFrame === item.frame && trusted(item.wc, item.base)) return item.wc.executeJavaScript(releaseScript(lease.nonce)).catch(() => {});
      };
      void pending.then(cleanupLate, cleanupLate).catch(() => {});
      let timer;
      try {
        const result = await Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Saving the app document timed out. Keep BeeZilla open and retry.")), timeoutMs);
        })]);
        if (released || active !== lease) throw new Error("This desktop transition is no longer current.");
        return acceptState(item, result);
      } finally { clearTimeout(timer); }
    }
    async function verify() {
      for (const item of windows) {
        const state = await evaluate(item, "state");
        if (state.sketch && state.state.dirty) throw new Error("Sketch changed before the desktop transition finished. Retry saving.");
      }
    }
    async function releaseWindow(item, skip, keepRetiredFrozen) {
      if (skip.includes(item.wc) || !owns(item.wc) || item.wc.mainFrame !== item.frame || !trusted(item.wc, item.base) || (keepRetiredFrozen && getBase() !== item.base)) return;
      let timer;
      try {
        // A hung renderer must not keep the main-process input guard or the
        // transition queue locked. A late cleanup still matches only its nonce.
        await Promise.race([
          item.wc.executeJavaScript(releaseScript(lease.nonce)),
          new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
      } catch { /* retired documents have no matching writer to resume */ }
      finally { clearTimeout(timer); }
    }
    async function release({ skip = [], keepRetiredFrozen = false } = {}) {
      if (released) return;
      released = true;
      try {
        await library?.release({ skip, keepRetiredFrozen });
        await Promise.all(windows.map((item) => releaseWindow(item, skip, keepRetiredFrozen)));
      } finally {
        if (active === lease) active = null;
        unlock();
        if (!held()) onIdle();
      }
    }
    try {
      for (const wc of getContents()) {
        if (!trusted(wc, base)) continue;
        const url = wc.getURL(), item = { wc, frame: wc.mainFrame, url, base, cold: !new URL(url).searchParams.has("job") };
        windows.push(item);
        await evaluate(item, "begin");
      }
      for (const item of windows) await evaluate(item, "drain");
      if (!runtimeUnchanged()) throw new Error("The local runtime changed while saving Sketch. Retry.");
      library = await acquireLibrary(options);
      if (!runtimeUnchanged()) throw new Error("The local runtime changed while saving Library history. Retry.");
      await verify();
      // New requests cannot hydrate a fresh document after the captured writers
      // are clean. Input guards also cover already-admitted responses/cold pages.
      lease.sealed = true;
      return { targets: windows, verify, release, async flush(next = getRuntime()) { await library.flush(next); await verify(); } };
    } catch (error) {
      await release();
      throw error;
    }
  }
  acquire.register = register;
  acquire.held = held;
  acquire.blocksRequest = blocksRequest;
  return acquire;
}
