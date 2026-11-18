/**
 * BeeZilla chat — a mountable surface, not a page.
 *
 * The owner's words: "I dont want to be tied to just the 'talk' page for talking
 * to Beezilla." So this file is the conversation, and any page can host it.
 *
 *   <script src="/buzzy/chat.js"></script>
 *   <script>
 *     var chat = BeeZillaChat.mount(document.getElementById("slot"), {
 *       title: "Ask about this project",
 *       jobId: "job_123",            // optional: the turn is recorded against it
 *       placeholder: "What changed?",
 *     });
 *   </script>
 *
 * It rides the SAME contract as talk.html — POST /api/buzzy/chat with stream:true,
 * SSE frames event: stage | tool | text | done | error. Before each turn the
 * owned-session resolver selects this item's conversation. Talk's global selected
 * session is neither evidence of this item's scope nor this component's to change.
 * Duplicating the reader instead of refactoring talk.html is deliberate: Talk's
 * voice lane is large and working, and a rewrite to share it would risk the mic.
 */
(function () {
  "use strict";

  var CHAT = "/api/buzzy/chat";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function styled(root) {
    if (document.getElementById("bz-chat-css")) return;
    var s = document.createElement("style");
    s.id = "bz-chat-css";
    s.textContent = [
      ".bzc{display:flex;flex-direction:column;gap:.5rem;background:#151515;border:1px solid #242424;border-radius:14px;padding:.75rem;height:100%;min-height:260px;color:#f2f2f2;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif}",
      ".bzc-head{display:flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9rem}",
      ".bzc-log{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:.45rem;padding-right:.2rem}",
      ".bzc-b{padding:.45rem .65rem;border-radius:10px;max-width:92%;white-space:pre-wrap;word-wrap:break-word}",
      ".bzc-u{background:#1f1f1f;align-self:flex-end}",
      ".bzc-a{background:#101010;border:1px solid #242424;align-self:flex-start}",
      ".bzc-stage{color:#8d8d8d;font-size:.78rem}",
      ".bzc-row{display:flex;gap:.4rem}",
      ".bzc-in{flex:1;background:#101010;border:1px solid #242424;color:#f2f2f2;border-radius:9px;padding:.45rem .6rem;font:inherit}",
      ".bzc-btn{background:#ffd40d;color:#111;border:0;border-radius:9px;padding:.45rem .8rem;font-weight:600;cursor:pointer}",
      ".bzc-btn:disabled{opacity:.5;cursor:default}",
      ".bzc-card{display:flex;gap:.5rem;align-items:center;background:#0c0c0c;border:1px solid #242424;border-radius:10px;padding:.4rem .5rem}",
      ".bzc-card img{max-width:110px;border-radius:6px;display:block}",
      ".bzc-card a{color:#ffd40d;text-decoration:none;font-size:.8rem}",
    ].join("");
    document.head.appendChild(s);
  }

  function authHeaders() {
    try {
      var t = localStorage.getItem("bz_token") || localStorage.getItem("bz_access_token");
      return t ? { Authorization: "Bearer " + t } : {};
    } catch (_) { return {}; }
  }

  function mount(host, opts) {
    if (!host) throw new Error("BeeZillaChat.mount needs an element");
    opts = opts || {};
    // Re-mounting a host retires its old callbacks, even before DOM removal.
    if (host.bzChatOwner) host.bzChatOwner.destroy();
    styled(host);
    host.innerHTML = "";

    var root = el("div", "bzc");
    var head = el("div", "bzc-head", opts.title || "BeeZilla");
    var log = el("div", "bzc-log");
    var stage = el("div", "bzc-stage");
    var row = el("div", "bzc-row");
    var input = el("input", "bzc-in");
    input.type = "text";
    input.placeholder = opts.placeholder || "Ask BeeZilla…";
    var sendBtn = el("button", "bzc-btn", "Send");
    row.appendChild(input);
    row.appendChild(sendBtn);
    root.appendChild(head);
    root.appendChild(log);
    root.appendChild(stage);
    root.appendChild(row);
    host.appendChild(root);

    function bubble(kind, text) {
      var b = el("div", "bzc-b " + kind, text || "");
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      return b;
    }

    function card(art) {
      var c = el("div", "bzc-card");
      if (art.kind === "image" && art.url) {
        var img = el("img");
        img.src = art.url;
        img.alt = "";
        c.appendChild(img);
      }
      var a = el("a", null, art.kind === "image" ? "Open image" : (art.name || "Download"));
      a.href = art.url || "#";
      a.target = "_blank";
      a.rel = "noopener";
      c.appendChild(a);
      var size = el("span", null, Math.round((art.bytes || 0) / 1024) + " KB");
      size.style.color = "#8d8d8d";
      size.style.fontSize = ".78rem";
      c.appendChild(size);
      log.appendChild(c);
      log.scrollTop = log.scrollHeight;
    }

    var invalidJob = Object.prototype.hasOwnProperty.call(opts, "jobId") &&
      (typeof opts.jobId !== "string" || !opts.jobId.trim());
    var jobId = typeof opts.jobId === "string" && opts.jobId ? opts.jobId : null;
    var route = pageKey();
    var retired = false, hidden = false, turn = null, observer = null;
    var owner = { destroy: destroy };
    host.bzChatOwner = owner;

    function pageKey() { return location.pathname.replace(/\.html$/, "") + location.search; }
    function mounted() {
      return !retired && host.bzChatOwner === owner && root.parentNode === host && root.isConnected;
    }
    function current(op) { return mounted() && !hidden && pageKey() === route && turn === op; }
    function cancel() {
      var old = turn;
      turn = null;
      if (old) {
        old.controller.abort();
        if (old.reader) Promise.resolve(old.reader.cancel()).catch(function () {});
      }
      if (mounted()) {
        input.disabled = false;
        sendBtn.disabled = false;
        if (old) stage.textContent = "Conversation changed. Any already accepted turn may still finish in its original conversation.";
      }
    }
    function navigated() { cancel(); }
    function pageHidden() { hidden = true; cancel(); }
    function pageShown() { hidden = false; }
    function destroy() {
      cancel();
      retired = true;
      if (observer) observer.disconnect();
      window.removeEventListener("popstate", navigated);
      window.removeEventListener("pagehide", pageHidden);
      window.removeEventListener("pageshow", pageShown);
      // A retained old handle must not erase a newer mount on the same host.
      if (host.bzChatOwner === owner) {
        delete host.bzChatOwner;
        if (root.parentNode === host) host.removeChild(root);
      }
    }
    window.addEventListener("popstate", navigated);
    window.addEventListener("pagehide", pageHidden);
    window.addEventListener("pageshow", pageShown);
    observer = new MutationObserver(function () { if (!mounted()) destroy(); });
    observer.observe(document.body, { childList: true, subtree: true });

    function errorMessage(data, fallback) {
      return data && typeof data.error === "string" && data.error ? data.error : fallback;
    }
    function validSession(s, requestedJob) {
      return s && typeof s === "object" && !Array.isArray(s) &&
        typeof s.id === "string" && /^[A-Za-z0-9_-]+$/.test(s.id) &&
        (s.jobId === null || (typeof s.jobId === "string" && s.jobId.length > 0)) &&
        (s.companyId === null || (typeof s.companyId === "string" && s.companyId.length > 0)) &&
        (!requestedJob || s.jobId === requestedJob);
    }

    async function send() {
      var draft = input.value || "", text = draft.trim();
      if (!text || turn || !mounted() || hidden || pageKey() !== route) return;
      if (invalidJob) { stage.textContent = "Could not identify this project. Reopen it before sending."; return; }
      // Claim ownership BEFORE the first await. Enter and click share this turn.
      var op = { controller: new AbortController(), reader: null };
      turn = op;
      input.disabled = true;
      sendBtn.disabled = true;
      stage.textContent = "Opening this conversation…";
      var sent = null, live = null, liveText = "", started = performance.now();
      var headers = Object.assign({ "Content-Type": "application/json" }, authHeaders());
      var requestedJob = jobId;
      try {
        // Never pair a URL's job with bz_session_id. The authenticated resolver
        // owner-checks the requested item and resumes only its company/job scope.
        // Resolve again each turn so a removed/reassigned item cannot use a cache.
        var resolved = await fetch("/api/buzzy/sessions", {
          method: "POST", credentials: "same-origin", headers: headers,
          body: JSON.stringify(requestedJob ? { jobId: requestedJob } : {}),
          signal: op.controller.signal,
        });
        if (!current(op)) return;
        var selection = await resolved.json();
        if (!current(op)) return;
        if (!resolved.ok || !selection || selection.error || selection.ok === false || !validSession(selection.session, requestedJob)) {
          throw new Error(errorMessage(selection, "Could not verify this conversation. Try again."));
        }
        var session = selection.session;
        var selectedJob = requestedJob || session.jobId;
        // Keep the question until selection succeeds; a refused resolver does not
        // consume it or create a misleading sent bubble. Never auto-retry a turn.
        if (input.value === draft) input.value = "";
        sent = bubble("bzc-u", text);
        live = bubble("bzc-a", "");
        stage.textContent = "Working…";
        var body = { message: text, stream: true, sessionId: session.id };
        if (selectedJob) body.jobId = selectedJob;
        var res = await fetch(CHAT, {
          method: "POST", credentials: "same-origin", headers: headers,
          body: JSON.stringify(body), signal: op.controller.signal,
        });
        if (!current(op)) return;
        var ctype = res.headers.get("content-type") || "", data;
        if (!res.ok || !res.body || ctype.indexOf("text/event-stream") === -1) {
          data = await res.json();
          if (!current(op)) return;
          if (!res.ok) {
            var refusal = new Error(errorMessage(data, "The turn failed."));
            // These codes are returned only by admission before any turn/usage
            // write. Unknown transport/server failures may already be accepted.
            refusal.notSent = data && (
              (res.status === 400 && data.code === "bad_chat_scope") ||
              (res.status === 404 && data.code === "chat_scope_unavailable") ||
              (res.status === 409 && data.code === "chat_scope_mismatch") ||
              (res.status === 401 && data.code === "signed_out"));
            throw refusal;
          }
        } else {
          op.reader = res.body.getReader();
          var dec = new TextDecoder(), buf = "", finalData = null;
          function frame(f) {
            var ev = "message", lines = [];
            f.split("\n").forEach(function (line) {
              if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
              else if (line.indexOf("data:") === 0) lines.push(line.slice(5).trim());
            });
            if (!lines.length) return;
            var p;
            try { p = JSON.parse(lines.join("\n")); } catch (_) { return; }
            if (!p || typeof p !== "object") return;
            if (ev === "text") { liveText += p.t || ""; live.textContent = liveText; log.scrollTop = log.scrollHeight; }
            else if (ev === "stage") { stage.textContent = p.label || p.phase || "Working…"; }
            else if (ev === "tool") { stage.textContent = p.state === "running" ? "Working — " + String(p.name || "a tool").replace(/_/g, " ") + "…" : "Writing the reply…"; }
            else if (ev === "done") finalData = p;
            else if (ev === "error") throw new Error(errorMessage(p, "The turn failed."));
          }
          while (true) {
            var r = await op.reader.read();
            if (!current(op)) return;
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            var i;
            while ((i = buf.indexOf("\n\n")) !== -1) { frame(buf.slice(0, i)); buf = buf.slice(i + 2); }
          }
          if (!finalData) throw new Error("The turn ended without a reply.");
          data = finalData;
        }
        if (!current(op)) return;
        if (!data || typeof data !== "object" || Array.isArray(data) || data.error || data.ok === false) {
          throw new Error(errorMessage(data, "The turn failed."));
        }
        if ((data.sessionId != null && data.sessionId !== session.id) ||
            (selectedJob && data.jobId != null && data.jobId !== selectedJob)) {
          throw new Error("The reply did not match this conversation.");
        }
        // The unscoped Ask surface can create an item. Adoption is private to this
        // mount and happens only after the entire matching reply has completed.
        jobId = selectedJob || (typeof data.jobId === "string" && data.jobId ? data.jobId : null);
        stage.textContent = Math.round(performance.now() - started) / 1000 + "s";
        if (data.reply) live.textContent = data.reply;
        else if (!liveText) live.textContent = "(no reply)";
        (data.artifacts || []).forEach(card);
        if (data.audio && data.audio.url) card({ kind: "audio", url: data.audio.url, name: data.audio.name, bytes: data.audio.bytes });
      } catch (e) {
        if (!current(op)) return;
        if (live && e.notSent) {
          if (!input.value || input.value === draft) {
            input.value = draft;
            if (sent && sent.parentNode === log) log.removeChild(sent);
            if (live.parentNode === log) log.removeChild(live);
            stage.textContent = "Question not sent: " + e.message + " Your question is kept.";
          } else {
            // Keep the original question visible, marked not sent, without
            // overwriting a programmatically newer draft in the composer.
            stage.textContent = "Your newer draft is kept.";
            live.textContent = "Question not sent: " + e.message;
          }
        } else if (live) { stage.textContent = ""; live.textContent = "That turn failed: " + e.message; }
        else stage.textContent = "Conversation not opened: " + e.message + " Your question is kept; try again.";
      } finally {
        if (op.reader) Promise.resolve(op.reader.cancel()).catch(function () {});
        if (turn === op) {
          turn = null;
          if (mounted()) { input.disabled = false; sendBtn.disabled = false; }
        }
      }
    }

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });

    return {
      root: root,
      say: function (t) { if (mounted() && !hidden && pageKey() === route) bubble("bzc-a", t); },
      destroy: destroy,
    };
  }

  window.BeeZillaChat = { mount: mount, version: "1" };
})();
