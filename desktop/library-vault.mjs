/** Scoped Library migration barrier. No generic storage or filesystem bridge. */
import { createHash, randomUUID } from "node:crypto";
import { isTrustedSender, runtimeOrigin } from "./security.mjs";

export const LEGACY_KEY = "bz_docs_v1";
export const PENDING_PREFIX = "bz_docs_v2_pending:";
const MAX_BYTES = 8 * 1024 * 1024;
const ERROR_PREFIX = "Library history is not safely saved yet. ";

export function canonicalRecord(record) {
  const doc = record?.document;
  if (!record || typeof record.jobId !== "string" || !record.jobId || record.jobId.length > 120 || !doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("A saved folder or document is invalid; its original local copy is unchanged.");
  if (Object.keys(doc).some((key) => !["name", "md", "createdAt", "updatedAt"].includes(key)) || typeof doc.name !== "string" || !doc.name || doc.name.length > 1024 || typeof doc.md !== "string") throw new Error("A saved document has unsupported fields; its original local copy is unchanged.");
  const normalized = { jobId: record.jobId, document: { name: doc.name, md: doc.md } };
  for (const key of ["createdAt", "updatedAt"]) {
    if (!Object.hasOwn(doc, key)) continue;
    if (typeof doc[key] !== "number" || !Number.isSafeInteger(doc[key]) || doc[key] < 0 || doc[key] > 8.64e15) throw new Error("A saved timestamp is invalid; its original local copy is unchanged.");
    normalized.document[key] = doc[key];
  }
  for (const value of [record.jobId, doc.name, doc.md]) {
    if (value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("A saved document contains text the database cannot preserve. Its original local copy is unchanged.");
  }
  const text = JSON.stringify(normalized);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("A saved document is too large to migrate automatically; its original local copy is unchanged.");
  return { record: normalized, text, hash: createHash("sha256").update(text).digest("hex") };
}

function parsePrivateJson(value, message) {
  try { return JSON.parse(value); }
  catch { throw new Error(message); }
}

export function decodeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.pending) || snapshot.pending.length > 10000) throw new Error("The Library snapshot is invalid.");
  const legacy = [];
  if (snapshot.legacy !== null) {
    if (typeof snapshot.legacy !== "string") throw new Error("The older Library cache is invalid.");
    const folders = parsePrivateJson(snapshot.legacy, "The older Library cache cannot be read.");
    if (!folders || typeof folders !== "object" || Array.isArray(folders)) throw new Error("The older Library cache cannot be read.");
    for (const [jobId, docs] of Object.entries(folders)) {
      if (!Array.isArray(docs)) throw new Error("A saved Library folder is invalid.");
      for (const document of docs) legacy.push(canonicalRecord({ jobId, document }));
    }
  }
  const pending = snapshot.pending.map(({ key, raw }) => {
    if (typeof key !== "string" || !key.startsWith(PENDING_PREFIX) || typeof raw !== "string") throw new Error("A pending Library key is invalid.");
    const envelope = parsePrivateJson(raw, "A pending Library save cannot be read.");
    if (!envelope || envelope.version !== 1 || typeof envelope.storeId !== "string" || typeof envelope.generation !== "string" || !/^\d+$/.test(envelope.generation)) throw new Error("A pending Library save cannot be read.");
    return { key, raw, envelope, ...canonicalRecord(envelope.record) };
  });
  return { legacy, pending };
}

// Establish the actual DOM document before queueing any storage operation.
function captureDocumentScript(url, proposedId) {
  return `(() => {
    if (location.href !== ${JSON.stringify(url)}) throw new Error("Library page changed during migration");
    if (!Object.hasOwn(document, "__bzLibraryVaultDocumentId")) {
      Object.defineProperty(document, "__bzLibraryVaultDocumentId", { value: ${JSON.stringify(proposedId)} });
    }
    return document.__bzLibraryVaultDocumentId;
  })()`;
}

function snapshotScript(nonce, freeze, generation, url, documentId) {
  return `(() => {
    if (document.__bzLibraryVaultDocumentId !== ${JSON.stringify(documentId)} || location.href !== ${JSON.stringify(url)}) throw new Error("Library page changed during migration");
    ${freeze ? `
    if ((window.__bzLibraryVaultGeneration ?? 0) >= ${generation}) throw new Error("This Library migration is no longer current");
    window.__bzLibraryVaultGeneration = ${generation};
    window.__bzLibraryVaultBarrier = ${JSON.stringify(nonce)};
    window.BeeZillaLibraryVault?.freeze();
    ` : `if (window.__bzLibraryVaultBarrier !== ${JSON.stringify(nonce)}) throw new Error("Library page changed during migration");`}
    const legacy = localStorage.getItem(${JSON.stringify(LEGACY_KEY)});
    const pending = []; let bytes = legacy?.length || 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(${JSON.stringify(PENDING_PREFIX)})) continue;
      const raw = localStorage.getItem(key); bytes += raw?.length || 0;
      pending.push({key, raw});
      if (pending.length > 10000 || bytes > 16 * 1024 * 1024) throw new Error("Library recovery data is too large; original copies are unchanged");
    }
    if (bytes > 16 * 1024 * 1024) throw new Error("Library recovery data is too large; original copies are unchanged");
    return {legacy, pending};
  })()`;
}

function acknowledgeScript(nonce, pending, url, documentId) {
  return `(() => {
    if (document.__bzLibraryVaultDocumentId !== ${JSON.stringify(documentId)} || location.href !== ${JSON.stringify(url)} || window.__bzLibraryVaultBarrier !== ${JSON.stringify(nonce)}) throw new Error("Library page changed before acknowledgment");
    for (const item of ${JSON.stringify(pending)}) if (localStorage.getItem(item.key) === item.raw) localStorage.removeItem(item.key);
    return true;
  })()`;
}

/** Serialize restart/close/quit so one transition cannot unfreeze another. */
export function createLibraryTransition({ getContents, getBase, getRuntime, fetchImpl = fetch, testPageUrl = null, rendererCleanupTimeoutMs = 15_000, rendererWaitTimeoutMs = 15_000 }) {
  let tail = Promise.resolve(), lastGeneration = 0;
  return async function acquire({ allowDeferred = false } = {}) {
    let unlock;
    const previous = tail;
    tail = new Promise((resolve) => { unlock = resolve; });
    await previous;
    const nonce = randomUUID(), generation = ++lastGeneration, windows = [];
    let released = null;
    const trusted = (wc, base) => isTrustedSender({ sender: wc, senderFrame: wc.mainFrame }, { base, contents: getContents(), testPageUrl });
    const verify = (item) => {
      if (released) throw new Error("This Library migration is no longer current.");
      if (item.navigated || !getContents().includes(item.wc) || item.wc.isDestroyed() || item.wc.mainFrame !== item.frame || item.wc.getURL() !== item.url || !trusted(item.wc, item.base)) throw new Error("The Library window changed during migration. Retry from the current window.");
    };
    async function releaseWindow(item, skip, keepRetiredFrozen) {
      // A successful port replacement retires the old origin. Unlock main
      // coordination, but never let a late cleanup resume a newer freeze.
      if (!item.documentId || skip.includes(item.wc) || item.wc.isDestroyed() || !getContents().includes(item.wc) || item.wc.mainFrame !== item.frame || !trusted(item.wc, item.base) || (keepRetiredFrozen && getBase() !== item.base)) return;
      let timer;
      try {
        await Promise.race([
          item.wc.executeJavaScript(`(() => {
            if (document.__bzLibraryVaultDocumentId !== ${JSON.stringify(item.documentId)} || (window.__bzLibraryVaultGeneration ?? 0) > ${generation}) return;
            const ownsFreeze = window.__bzLibraryVaultBarrier === ${JSON.stringify(nonce)};
            if (!ownsFreeze && location.href !== ${JSON.stringify(item.url)}) return;
            // Retire this generation even if the first freeze never ran.
            window.__bzLibraryVaultGeneration = ${generation};
            if (ownsFreeze) {
              delete window.__bzLibraryVaultBarrier;
              window.BeeZillaLibraryVault?.resume();
            }
          })()`),
          new Promise((resolve) => { timer = setTimeout(resolve, rendererCleanupTimeoutMs); }),
        ]);
      } catch { /* a destroyed/replaced document has no old freeze to release */ }
      finally { clearTimeout(timer); }
    }
    const release = async ({ skip = [], keepRetiredFrozen = false } = {}) => {
      if (released) return;
      released = { skip, keepRetiredFrozen };
      try { await Promise.all(windows.map((item) => releaseWindow(item, skip, keepRetiredFrozen))); }
      finally {
        for (const item of windows) item.wc.removeListener?.("did-navigate", item.onNavigation);
        unlock();
      }
    };
    async function rendererCall(item, source, mightFreeze = false) {
      verify(item);
      const pending = item.wc.executeJavaScript(source);
      if (mightFreeze) {
        const cleanupLate = () => {
          if (released) return releaseWindow(item, released.skip, released.keepRetiredFrozen);
        };
        void pending.then(cleanupLate, cleanupLate).catch(() => {});
      }
      let timer;
      try {
        const result = await Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("The Library renderer did not respond. Keep BeeZilla open and retry.")), rendererWaitTimeoutMs);
          }),
        ]);
        verify(item);
        return result;
      } finally { clearTimeout(timer); }
    }

    async function request(rt, suffix, body) {
      const base = runtimeOrigin(rt), token = rt.token;
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("The local runtime has no authenticated Library connection.");
      const verifyRuntime = () => {
        const current = getRuntime();
        if (!current || runtimeOrigin(current) !== base || current.token !== token) throw new Error("The runtime changed during Library migration. Retry.");
      };
      const verifyAll = () => { verifyRuntime(); for (const item of windows) verify(item); };
      verifyAll();
      const response = await fetchImpl(base + "/api/buzzy/library-vault" + suffix, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const reader = response.body?.getReader(), chunks = [];
      let bytes = 0;
      try {
        verifyAll();
        if (!response.ok) throw new Error("Local Library storage unavailable. Keep BeeZilla open and retry.");
        // Bound successful responses by size even without a content-length header.
        if (Number(response.headers.get("content-length")) > 10 * 1024 * 1024 || !reader) throw new Error("The Library response is invalid or too large.");
        for (;;) {
          const { value, done } = await reader.read();
          verifyAll();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 10 * 1024 * 1024) throw new Error("The Library response is too large.");
          chunks.push(value);
        }
      } catch (error) {
        // Refused or invalidated work must not leave its response streaming.
        void reader?.cancel().catch(() => {});
        throw error;
      } finally { reader?.releaseLock(); }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const data = parsePrivateJson(text, "The local Library response could not be read. Keep BeeZilla open and retry.");
      verifyAll();
      if (!data?.ok) throw new Error("Local Library storage unavailable. Keep BeeZilla open and retry.");
      return data;
    }
    async function flush(rt = getRuntime()) {
      if (released) throw new Error("This Library migration is no longer current.");
      if (!windows.length) return;
      // Capture again after every async boundary. Writers are frozen; a changed
      // nonce catches same-URL reloads, and a late external write forces retry.
      for (let pass = 0; pass < 3; pass++) {
        const snapshots = [];
        for (const item of windows) {
          const raw = await rendererCall(item, snapshotScript(nonce, false, generation, item.url, item.documentId));
          snapshots.push({ item, raw, decoded: decodeSnapshot(raw) });
        }
        if (!snapshots.some(({ decoded }) => decoded.legacy.length || decoded.pending.length)) return;
        if (!rt) throw new Error("Restart the stopped runtime from Settings, then retry saving Library history before closing this window.");
        const meta = await request(rt, "?metadata=1");
        if (typeof meta.storeId !== "string" || typeof meta.generation !== "string" || !/^\d+$/.test(meta.generation)) throw new Error("The local Library returned invalid storage identity.");
        for (const snapshot of snapshots) {
          const { item, decoded } = snapshot;
          const eligible = decoded.pending.filter((entry) => {
            if (entry.envelope.storeId !== meta.storeId) throw new Error("Pending Library history belongs to a different local database. Its original copy is unchanged.");
            return entry.envelope.generation === meta.generation;
          });
          const records = new Map();
          if (meta.generation === "0") for (const row of decoded.legacy) records.set(row.hash, row);
          for (const row of eligible) records.set(row.hash, row);
          const list = [...records.values()];
          const committed = [];
          for (let offset = 0; offset < list.length;) {
            const batch = []; let bytes = 2;
            while (offset < list.length && batch.length < 50) {
              const row = list[offset], size = Buffer.byteLength(row.text) + 1;
              if (batch.length && bytes + size > MAX_BYTES) break;
              batch.push(row); bytes += size; offset++;
            }
            const answer = await request(rt, "", { records: batch.map((row) => row.record), expectedStoreId: meta.storeId, expectedGeneration: meta.generation });
            verify(item);
            if (answer.storeId !== meta.storeId || answer.generation !== meta.generation || !Array.isArray(answer.stored)) throw new Error("The Library changed before the save was acknowledged.");
            const expected = new Set(batch.map((row) => row.hash));
            for (const stored of answer.stored) {
              const exact = canonicalRecord(stored);
              if (stored.hash !== exact.hash || !expected.delete(exact.hash)) throw new Error("A Library acknowledgment did not match the saved document.");
              committed.push(exact.hash);
            }
            if (expected.size) throw new Error("Some Library records were not saved. Their local copies are unchanged.");
            await rendererCall(item, snapshotScript(nonce, false, generation, item.url, item.documentId));
          }
          if (committed.length) {
            await rendererCall(item, acknowledgeScript(nonce, eligible.map(({ key, raw }) => ({ key, raw })), item.url, item.documentId));
          }
        }
        let changed = false;
        for (const { item, raw } of snapshots) {
          const latest = await rendererCall(item, snapshotScript(nonce, false, generation, item.url, item.documentId));
          // A completed pending POST may remove an acknowledged outbox key;
          // deletion is safe. New or modified record bytes require another pass.
          const before = new Map(raw.pending.map((row) => [row.key, row.raw]));
          if (latest.legacy !== raw.legacy || latest.pending.some((row) => before.get(row.key) !== row.raw)) changed = true;
        }
        if (!changed) return;
      }
      throw new Error("Library history kept changing during migration. Retry after its saves finish.");
    }
    try {
      const base = getBase();
      for (const wc of getContents()) {
        if (!trusted(wc, base)) continue;
        const item = { wc, frame: wc.mainFrame, url: wc.getURL(), base, navigated: false };
        // Committed main-frame navigation, not in-page route changes. A
        // matching URL and frame object can survive a reload while a probe waits.
        item.onNavigation = () => { item.navigated = true; };
        wc.on?.("did-navigate", item.onNavigation);
        windows.push(item);
        const documentId = await rendererCall(item, captureDocumentScript(item.url, randomUUID()));
        if (typeof documentId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(documentId)) throw new Error("The Library window could not confirm its document.");
        item.documentId = documentId;
        await rendererCall(item, snapshotScript(nonce, true, generation, item.url, item.documentId), true);
      }
      if (getRuntime() || !allowDeferred) await flush();
      return { flush, release };
    } catch (error) {
      await release();
      throw new Error(ERROR_PREFIX + (error?.message || "Retry from Settings before closing the window."));
    }
  };
}
