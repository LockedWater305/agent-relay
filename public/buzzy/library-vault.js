/* Local Library history. This is app-owned content, never host filesystem access.
 * The old key is an immutable recovery copy. Only exact records enter the local
 * authenticated vault; no other localStorage values or remote URLs are sent. */
(function () {
  "use strict";
  if (window.BeeZillaLibraryVault || !window.beezilla) return;
  var LEGACY = "bz_docs_v1", PREFIX = "bz_docs_v2_pending:";
  var ENDPOINT = "/api/buzzy/library-vault";
  var cache = new Map(), nextRef = 0, metadata = null, ready = false, busy = null;
  var listener = null, notice = "Loading durable Library history…", timer = null;
  var frozen = Boolean(window.__bzLibraryVaultBarrier), dirty = false;
  var encoder = new TextEncoder();
  var MAX_BYTES = 8 * 1024 * 1024;
  function canonical(record) {
    var d = record && record.document;
    if (!record || typeof record.jobId !== "string" || !record.jobId || record.jobId.length > 120 || !d || Array.isArray(d) || typeof d !== "object") throw new Error("A saved Library record has an unsupported shape. Its local copy is unchanged.");
    var keys = Object.keys(d);
    if (keys.some(function (k) { return !["name", "md", "createdAt", "updatedAt", "_vaultRef"].includes(k); }) || typeof d.name !== "string" || !d.name || d.name.length > 1024 || typeof d.md !== "string") throw new Error("A saved Library record has unsupported fields. Its local copy is unchanged.");
    var doc = { name: d.name, md: d.md };
    ["createdAt", "updatedAt"].forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(d, key)) {
        if (typeof d[key] !== "number" || !Number.isSafeInteger(d[key]) || d[key] < 0 || d[key] > 8.64e15) throw new Error("A saved Library timestamp is invalid. Its local copy is unchanged.");
        doc[key] = d[key];
      }
    });
    [record.jobId, doc.name, doc.md].forEach(function (value) {
      if (value.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("A saved document contains text the database cannot preserve. Its local copy is unchanged.");
    });
    var normalized = { jobId: record.jobId, document: doc };
    var text = JSON.stringify(normalized);
    if (encoder.encode(text).byteLength > MAX_BYTES) throw new Error("A saved Library record is too large to migrate automatically. Its local copy is unchanged.");
    return { record: normalized, text: text };
  }
  function flatten(raw) {
    if (raw === null) return [];
    var all = JSON.parse(raw);
    if (!all || Array.isArray(all) || typeof all !== "object") throw new Error("The older Library cache cannot be read. Its local copy is unchanged.");
    var rows = [];
    Object.keys(all).forEach(function (jobId) {
      if (!Array.isArray(all[jobId])) throw new Error("The older Library cache contains an invalid folder. Its local copy is unchanged.");
      all[jobId].forEach(function (document) { rows.push(canonical({ jobId: jobId, document: document }).record); });
    });
    return rows;
  }
  function pending() {
    var rows = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      var raw = localStorage.getItem(key), value = JSON.parse(raw);
      if (!value || value.version !== 1 || typeof value.storeId !== "string" || typeof value.generation !== "string" || !/^\d+$/.test(value.generation)) throw new Error("A pending Library save cannot be read. Its local copy is unchanged.");
      rows.push({ key: key, raw: raw, value: value, record: canonical(value.record).record });
      if (rows.length > 10000) throw new Error("Too many pending Library saves. Nothing was removed.");
    }
    return rows;
  }
  async function hash(record) {
    var bytes = await crypto.subtle.digest("SHA-256", encoder.encode(canonical(record).text));
    return Array.from(new Uint8Array(bytes), function (n) { return n.toString(16).padStart(2, "0"); }).join("");
  }
  function add(record) {
    var value = canonical(record);
    if (cache.has(value.text)) return false;
    cache.set(value.text, { record: value.record, ref: "vault_" + (++nextRef) });
    return true;
  }
  function emit(changed) { if (listener) listener(Boolean(changed)); }
  function status() { return { ready: ready, frozen: frozen || Boolean(window.__bzLibraryVaultBarrier), message: notice, storeId: metadata && metadata.storeId, generation: metadata && metadata.generation }; }
  async function api(path, init) {
    var res = await fetch(ENDPOINT + path, Object.assign({ credentials: "same-origin", redirect: "error", cache: "no-store" }, init));
    var data = await res.json();
    if (!res.ok || !data || !data.ok) throw new Error(data && data.error || "Library history could not be saved locally. Retry before changing the runtime.");
    return data;
  }
  function sameMeta(data, meta) { return data.storeId === meta.storeId && data.generation === meta.generation; }
  async function importRows(meta, rows) {
    var acknowledgments = [], offset = 0;
    while (offset < rows.length) {
      var batch = [], size = 2;
      while (offset < rows.length && batch.length < 50) {
        var record = canonical(rows[offset]).record;
        var bytes = encoder.encode(JSON.stringify(record)).byteLength + 1;
        if (batch.length && size + bytes > MAX_BYTES) break;
        batch.push(record); size += bytes; offset++;
      }
      var result = await api("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: batch, expectedStoreId: meta.storeId, expectedGeneration: meta.generation }) });
      if (!sameMeta(result, meta) || !Array.isArray(result.stored)) throw new Error("The local Library changed during a save. Nothing was removed; retry.");
      var expected = new Set(batch.map(function (r) { return canonical(r).text; }));
      for (var r of result.stored) {
        var text = canonical(r).text;
        if (!expected.has(text) || r.hash !== await hash(r)) throw new Error("Library save acknowledgment did not match the document. Local copies are unchanged.");
        expected.delete(text); acknowledgments.push(r.hash);
      }
      if (expected.size) throw new Error("Some Library records were not acknowledged. Local copies are unchanged.");
    }
    return acknowledgments;
  }
  async function synchronize() {
    var meta = await api("?metadata=1");
    if (typeof meta.storeId !== "string" || typeof meta.generation !== "string" || !/^\d+$/.test(meta.generation)) throw new Error("The local Library returned invalid storage identity.");
    var old = flatten(localStorage.getItem(LEGACY)), pendingRows = pending(), migrate = [];
    if (meta.generation === "0") {
      // Replaying exact records is idempotent and also repairs a restored
      // older DB snapshot. Origin receipts are not proof the DB still has data.
      migrate = old;
    }
    var eligible = pendingRows.filter(function (p) { return p.value.storeId === meta.storeId && p.value.generation === meta.generation; });
    var stale = pendingRows.length !== eligible.length || (meta.generation !== "0" && old.length > 0);
    var merged = new Map();
    migrate.concat(eligible.map(function (p) { return p.record; })).forEach(function (row) { merged.set(canonical(row).text, row); });
    await importRows(meta, Array.from(merged.values()));
    // No quota-consuming receipt is needed. Only exact committed pending
    // records are removed; the legacy recovery copy is never modified.
    eligible.forEach(function (p) { if (localStorage.getItem(p.key) === p.raw) localStorage.removeItem(p.key); });
    var restored = [], after = "0", pages = 0;
    for (;;) {
      var page = await api("?after=" + encodeURIComponent(after) + "&limit=50");
      if (!sameMeta(page, meta) || !Array.isArray(page.records)) throw new Error("The local Library changed while history was loading. Retry.");
      page.records.forEach(function (r) { restored.push(canonical(r).record); });
      if (page.done) break;
      if (typeof page.nextCursor !== "string" || !/^\d+$/.test(page.nextCursor) || BigInt(page.nextCursor) <= BigInt(after) || ++pages > 10000) throw new Error("Library history pagination did not advance. Existing copies are unchanged.");
      after = page.nextCursor;
    }
    // Recheck local pending records after awaits, so a newer same-origin save
    // cannot disappear from the view while an earlier batch is being saved.
    var latest = pending().filter(function (p) { return p.value.storeId === meta.storeId && p.value.generation === meta.generation; });
    var previous = cache;
    cache = new Map();
    restored.concat(latest.map(function (p) { return p.record; })).forEach(function (record) {
      var value = canonical(record), old = previous.get(value.text);
      if (old) cache.set(value.text, old); else add(record);
    });
    metadata = { storeId: meta.storeId, generation: meta.generation };
    ready = true;
    notice = stale ? "Library history saved locally. Older recovery copies from a different store or data reset were not imported." : "Library history saved in this device’s database.";
    emit(true);
  }
  function refresh() {
    if (busy) { dirty = true; return busy; }
    dirty = false;
    busy = synchronize().catch(function (error) { notice = error.message; emit(false); throw error; }).finally(function () {
      busy = null;
      if (dirty && !frozen && !window.__bzLibraryVaultBarrier) { dirty = false; schedule(); }
    });
    return busy;
  }
  function schedule() {
    if (timer || frozen || window.__bzLibraryVaultBarrier) return;
    timer = setTimeout(function () { timer = null; void refresh().catch(function () {}); }, 20);
  }
  // Do not render a legacy copy before the database deletion generation is known.
  window.BeeZillaLibraryVault = {
    status: status,
    onChange: function (fn) { listener = fn; },
    load: function () {
      var all = Object.create(null);
      cache.forEach(function (item) {
        var r = item.record;
        if (!all[r.jobId]) all[r.jobId] = [];
        all[r.jobId].push(Object.assign({}, r.document, { _vaultRef: item.ref }));
      });
      return all;
    },
    save: function (all) {
      if (!ready || frozen || window.__bzLibraryVaultBarrier) { notice = "Library history is waiting for the runtime transition. New archive entries are paused."; emit(false); return false; }
      try {
        var rows = flatten(JSON.stringify(all)), changed = false;
        rows.forEach(function (row) {
          if (cache.has(canonical(row).text)) return;
          // One key per record avoids cross-window read/modify/write loss.
          var key = PREFIX + crypto.randomUUID();
          localStorage.setItem(key, JSON.stringify({ version: 1, storeId: metadata.storeId, generation: metadata.generation, record: row }));
          add(row); changed = true;
        });
        if (!changed) return true;
        notice = "Saving Library history locally…";
        emit(false); schedule(); return true;
      } catch (error) { notice = "Library history was not saved: " + error.message; emit(false); return false; }
    },
    refresh: refresh,
    freeze: function () { frozen = true; if (timer) { clearTimeout(timer); timer = null; } emit(false); },
    resume: function () { frozen = false; emit(false); schedule(); }
  };
  void refresh().catch(function () {});
})();
