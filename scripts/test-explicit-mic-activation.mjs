// Actual Talk boot/nav and Settings diagnostic event handlers, with only fake
// DOM, storage, media and fetch. No browser, microphone, network or provider.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import test from "node:test";

const read = path => readFileSync(new URL("../public/buzzy/" + path, import.meta.url), "utf8");
const talk = read("talk.html"), nav = read("nav.js"), settings = read("settings.html");
const scriptlets = html => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(m => !/\bsrc\s*=/.test(m[1])).map(m => m[2]);
function fn(text, name, indent = "    ") {
  const m = text.match(new RegExp("^" + indent + "function " + name + "\\([^]*?^" + indent + "\\}", "m"));
  assert.ok(m, name);
  return m[0];
}
const diagnosticBegin = settings.indexOf("      // ── microphone diagnostics");
const diagnosticEnd = settings.indexOf("    </script>", diagnosticBegin);
assert.ok(diagnosticBegin >= 0 && diagnosticEnd > diagnosticBegin);
const diagnostic = settings.slice(diagnosticBegin, diagnosticEnd);
const titleStart = nav.indexOf("  var bzTitle = {");
const titleEnd = nav.indexOf("  function voiceDock(", titleStart);
assert.ok(titleStart >= 0 && titleEnd > titleStart);
const title = nav.slice(titleStart, titleEnd);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fakeDom() {
  const nodes = new Map();
  class Element {
    constructor() {
      this.events = new Map(); this.attributes = new Map(); this.classes = new Set();
      this.style = {}; this.textContent = ""; this.innerHTML = ""; this.value = ""; this.disabled = false;
      this.children = new Map(); this.isConnected = true;
      this.classList = { toggle: (k, on) => on ? this.classes.add(k) : this.classes.delete(k) };
    }
    set id(v) { nodes.set(v, this); }
    setAttribute(k, v) { this.attributes.set(k, v); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    removeAttribute(k) { this.attributes.delete(k); }
    addEventListener(type, fn) {
      if (!this.events.has(type)) this.events.set(type, new Set());
      this.events.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.events.get(type)?.delete(fn); }
    dispatchEvent(event) { return [...(this.events.get(event.type) ?? [])].map(fn => fn(event)); }
    dispatch(type, props = {}) { return this.dispatchEvent({ type, target: this, ...props }); }
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, new Element());
      return this.children.get(selector);
    }
    appendChild() {}
  }
  const doc = new Element();
  doc.title = "BeeZilla — Chat";
  doc.getElementById = id => nodes.get(id) ?? null;
  doc.createElement = () => new Element();
  const node = id => {
    if (!nodes.has(id)) { const x = new Element(); x.id = id; }
    return nodes.get(id);
  };
  return { doc, node, forget: id => nodes.delete(id) };
}

function talkHarness({ desktop = false, savedReply = false } = {}) {
  const { doc, node } = fakeDom();
  for (const id of ["micBtn", "voiceToggle", "voiceStageEnd", "voiceStatus", "voiceStage", "voiceStageState"]) node(id);
  const activity = [], storage = new Map([["bz_listen_mode", "1"], ["bz_voice_replies", savedReply ? "1" : "0"]]);
  class Recognition {
    constructor() { activity.push("recognizer"); }
    start() { activity.push("recognition"); }
    stop() { activity.push("recognition-stop"); }
  }
  const w = { SpeechRecognition: Recognition, ...(desktop ? { beezilla: {} } : {}) };
  const scope = createContext({
    document: doc, window: w, localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    VOICE_KEY: "bz_voice_replies", LISTEN_KEY: "bz_listen_mode", PROBE_ON: false,
    voice: { armed: false, mic: false, rec: null, speaking: false, sending: false, note: "" }, capState: null, recState: null, recAcquiring: null,
    clipHasSpeech: () => false, startCapture: () => activity.push("browser-capture"),
    startRecording: () => activity.push("recorder"), invalidateSpeechRequest: () => activity.push("discard-transcription"),
    cancelRecording() {}, preRollStop() {}, mountAvatars() {}, setAvatarState() {}, toggleVoiceReplies() {}, stopSpeaking() {},
    releaseMic: () => activity.push("released"),
    section: () => "talk", setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
  });
  const names = ["voicePref", "saveVoicePref", "listenPref", "saveListenPref", "paintVoice", "srAvailable",
    "startListening", "stopListening", "toggleMic", "initVoice"];
  new Script(names.map(name => fn(talk, name)).join("\n") + "\n" + title + "\n" + fn(nav, "voiceDock", "  ") + "\ninitVoice(); voiceDock(document.createElement('span'));").runInContext(scope);
  return { activity, storage, doc, node, scope, w };
}

test("affected inline scripts still parse", () => {
  for (const html of [talk, settings]) for (const s of scriptlets(html)) new Script(s);
});
test("stored Listen paints Resume and generic clicks/typing never activate either transcriber", () => {
  for (const desktop of [false, true]) {
    const h = talkHarness({ desktop });
    assert.equal(h.scope.voice.armed, true);
    assert.equal(h.scope.voice.mic, false);
    assert.equal(h.scope.voice.replies, false);
    assert.match(h.node("voiceStatus").textContent, /paused.*Resume/i);
    assert.equal(h.node("micBtn").attributes.get("aria-label"), "Resume listening");
    assert.equal(h.node("bzVoiceMic").querySelector(".bz-voice-label").textContent, "Resume");
    assert.equal(h.doc.title, "BeeZilla — Chat");
    h.w.BeeZillaTitle.setPage("BeeZilla — Settings");
    assert.equal(h.doc.title, "BeeZilla — Settings");
    h.doc.dispatch("pointerdown"); h.doc.dispatch("keydown");
    assert.deepEqual(h.activity, []);
    assert.equal(h.scope.voice.mic, false);
    assert.equal(h.scope.voice.replies, false);
    assert.equal(h.node("voiceStage").classes.has("hidden"), true);
    assert.equal(h.storage.get("bz_voice_replies"), "0");
  }
});
test("only the explicit Talk or nav Resume starts the chosen path; Stop still releases", () => {
  for (const desktop of [false, true]) {
    const h = talkHarness({ desktop });
    h.node(desktop ? "micBtn" : "bzVoiceMic").dispatch("click");
    assert.equal(h.scope.voice.mic, true);
    assert.equal(h.scope.voice.armed, false);
    assert.equal(h.scope.voice.replies, true);
    assert.match(h.doc.title, /Listening/);
    h.w.BeeZillaTitle.setPage("BeeZilla — Library");
    assert.match(h.doc.title, /Listening/);
    assert.deepEqual(h.activity, desktop ? ["recorder"] : ["recognizer", "recognition", "browser-capture"]);
    h.node("bzVoiceStop").dispatch("click");
    assert.equal(h.scope.voice.mic, false);
    assert.equal(h.storage.get("bz_listen_mode"), "0");
    assert.ok(h.activity.includes("discard-transcription") && h.activity.includes("released"));
    assert.equal(h.doc.title, "BeeZilla — Library");
    h.doc.dispatch("pointerdown"); h.doc.dispatch("keydown");
    assert.equal(h.scope.voice.mic, false);
  }
});
test("a separately stored Speak replies preference stays available without activating the mic", () => {
  const h = talkHarness({ savedReply: true });
  assert.equal(h.scope.voice.replies, true);
  assert.equal(h.scope.voice.mic, false);
  assert.deepEqual(h.activity, []);
});

function settingsHarness({ permission, enumerate, abort = true } = {}) {
  const { doc, node, forget } = fakeDom();
  const w = doc.createElement("window");
  const opening = [], recorders = [], requests = [], contexts = [], timers = new Map(), frames = new Map();
  let id = 0;
  class AudioContext {
    constructor() { this.state = "running"; this.closed = 0; this.disconnected = 0; contexts.push(this); }
    createMediaStreamSource() { return { connect() {}, disconnect: () => { this.disconnected++; } }; }
    createAnalyser() { return { getFloatTimeDomainData: b => b.fill(0.05) }; }
    close() { this.state = "closed"; this.closed++; return Promise.resolve(); }
  }
  class MediaRecorder {
    static isTypeSupported() { return true; }
    constructor(stream, cfg) { this.stream = stream; this.mimeType = cfg.mimeType; this.state = "inactive"; this.stops = 0; recorders.push(this); }
    start() { this.state = "recording"; }
    stop() {
      assert.equal(this.state, "recording");
      this.state = "inactive"; this.stops++;
      this.ondataavailable?.({ data: new Blob(["synthetic marker"]) });
      this.onstop?.();
    }
  }
  const logs = [], copied = [];
  Object.assign(w, { AudioContext, MediaRecorder });
  const ctx = createContext({
    $: node, window: w, document: doc, MediaRecorder, Blob, AbortController: abort ? AbortController : undefined,
    appBridge: { log: text => logs.push(text) },
    say: (element, value) => { element.textContent = value; },
    navigator: { mediaDevices: {
      getUserMedia: constraints => {
        const d = deferred(); opening.push({ ...d, constraints }); return d.promise;
      },
      enumerateDevices: enumerate ?? (() => Promise.resolve([])),
    }, permissions: { query: () => permission ?? Promise.resolve({ state: "prompt" }) },
      clipboard: { writeText: async text => copied.push(text) } },
    setTimeout: f => { timers.set(++id, f); return id; }, clearTimeout: value => timers.delete(value),
    requestAnimationFrame: f => { frames.set(++id, f); return id; }, cancelAnimationFrame: value => frames.delete(value),
    fetch: (url, init) => { const d = deferred(); requests.push({ ...d, url, init }); return d.promise; },
  });
  const ids = ["microphone", "mic-device", "mic-allow", "mic-test", "mic-status", "mic-meter", "mic-fill", "mic-result", "mic-copy", "mic-copy-status"];
  function mount() {
    for (const id of ids) { forget(id); node(id); }
    if (/<section id="microphone"[^>]*\bdata-bz-before-remove\b/.test(settings))
      node("microphone").setAttribute("data-bz-before-remove", "");
    node("mic-test").textContent = "Record 3 s & transcribe";
    const select = node("mic-device");
    select.value = "fixture-A";
    select.options = [];
    select.replaceChildren = (...options) => { select.options = options; };
    node("logs-path").textContent = "Log: /fixture-private-profile/support.log";
    new Script("(function(){\n" + diagnostic + "\n})();").runInContext(ctx);
  }
  mount();
  const emit = (id, type = "click") => node(id).dispatch(type);
  return { doc, node, w, activity: { opening, recorders, requests, contexts, timers, frames, logs, copied }, emit, mount,
    select(value) { node("mic-device").value = value; emit("mic-device", "change"); },
    get button() { return node("mic-test"); } };
}

function fakeStream() {
  const tracks = Array.from({ length: 2 }, () => ({
    stops: 0, readyState: "live", label: "Fixture input", getSettings: () => ({ sampleRate: 16000 }),
    stop() { this.stops++; this.readyState = "ended"; },
  }));
  return { tracks, getAudioTracks: () => tracks, getTracks: () => tracks };
}
const fixtureResponse = text => ({ ok: true, json: async () => ({ ok: true, text, ms: 1, model: "fixture" }) });

test("selecting an input while idle never requests access; explicit Allow uses the chosen device", async () => {
  const gate = deferred(), h = settingsHarness({ permission: gate.promise });
  h.select("fixture-B"); h.select("fixture-C");
  gate.resolve({ state: "granted" }); await flush();
  assert.equal(h.activity.opening.length, 0);
  assert.match(h.node("mic-status").textContent, /Input changed/);
  h.emit("mic-allow");
  assert.equal(h.activity.opening.length, 1);
  assert.equal(h.activity.opening[0].constraints.audio.deviceId.exact, "fixture-C");
  h.activity.opening[0].resolve(fakeStream()); await flush();
  assert.equal(h.activity.contexts.length, 1);
  assert.equal(h.activity.recorders.length, 0);
  assert.equal(h.activity.requests.length, 0);
});

test("late permission after an input change is discarded without replacing a new stream", async () => {
  const h = settingsHarness();
  h.emit("mic-allow");
  h.select("fixture-B");
  assert.equal(h.activity.opening.length, 1);
  h.emit("mic-allow");
  const old = fakeStream(), active = fakeStream();
  h.activity.opening[1].resolve(active); await flush();
  h.activity.opening[0].resolve(old); await flush();
  assert.deepEqual(old.tracks.map(t => t.stops), [1, 1]);
  assert.deepEqual(active.tracks.map(t => t.stops), [0, 0]);
  assert.equal(h.activity.contexts.length, 1);
  assert.match(h.node("mic-status").textContent, /Microphone ready/);
});

test("input change during device enumeration drops the old stream before it can attach a meter", async () => {
  const slow = deferred();
  let reads = 0;
  const h = settingsHarness({ enumerate: () => ++reads === 2 ? slow.promise : Promise.resolve([]) });
  const [oldDone] = h.emit("mic-test"), old = fakeStream();
  h.activity.opening[0].resolve(old); await flush();
  assert.equal(h.activity.contexts.length, 0);
  h.select("fixture-B");
  assert.deepEqual(old.tracks.map(t => t.stops), [1, 1]);
  assert.equal(h.activity.opening.length, 1);
  h.emit("mic-allow");
  h.activity.opening[1].resolve(fakeStream()); await flush();
  slow.resolve([{ deviceId: "obsolete", kind: "audioinput" }]); await oldDone;
  assert.equal(h.activity.contexts.length, 1);
  assert.equal(h.activity.recorders.length, 0);
  assert.doesNotMatch(h.node("mic-device").innerHTML, /obsolete/);
});

test("an obsolete permission rejection cannot replace the current input's status", async () => {
  const h = settingsHarness(), [oldDone] = h.emit("mic-test");
  h.select("fixture-B");
  h.emit("mic-allow");
  h.activity.opening[1].resolve(fakeStream()); await flush();
  h.activity.opening[0].reject(new Error("old permission result")); await oldDone;
  assert.match(h.node("mic-status").textContent, /Microphone ready/);
  assert.equal(h.activity.recorders.length, 0);
  assert.equal(h.activity.requests.length, 0);
});

test("input change closes the current meter and recorder and discards queued old output", async () => {
  const h = settingsHarness(), [done] = h.emit("mic-test");
  const stream = fakeStream();
  h.activity.opening[0].resolve(stream); await flush();
  const old = h.activity.recorders[0], ondata = old.ondataavailable, onstop = old.onstop;
  const oldTimer = [...h.activity.timers.values()][0], oldFrame = [...h.activity.frames.values()][0];
  h.select("fixture-C");
  ondata({ data: new Blob(["obsolete fixture"]) }); onstop(); oldTimer(); oldFrame();
  await done;
  assert.equal(h.activity.opening.length, 1);
  assert.equal(h.activity.requests.length, 0);
  assert.equal(old.stops, 1);
  assert.deepEqual(stream.tracks.map(t => t.stops), [1, 1]);
  assert.equal(h.activity.contexts[0].disconnected, 1);
  assert.equal(h.activity.contexts[0].closed, 1);
  assert.equal(h.activity.timers.size, 0);
  assert.equal(h.activity.frames.size, 0);
  assert.equal(h.node("mic-meter").hidden, true);
  assert.equal(h.node("mic-fill").style.width, "0%");
  assert.equal(h.button.disabled, false);
  assert.match(h.node("mic-result").textContent, /Not tested on this input/);
});

test("changing inputs aborts an in-flight test and a late response cannot touch the replacement", async () => {
  for (const abort of [true, false]) {
    const h = settingsHarness({ abort });
    const [oldDone] = h.emit("mic-test");
    h.activity.opening[0].resolve(fakeStream()); await flush();
    [...h.activity.timers.values()][0](); await flush();
    const old = h.activity.requests[0], body = deferred();
    old.resolve({ ok: true, json: () => body.promise }); await flush();
    h.select("fixture-B");
    if (abort) assert.equal(old.init.signal.aborted, true);
    assert.equal(h.activity.opening.length, 1);
    const [newDone] = h.emit("mic-test");
    body.resolve({ ok: true, text: "obsolete fixture", model: "fixture" }); await oldDone;
    assert.equal(h.button.disabled, true);
    assert.match(h.node("mic-result").textContent, /Not tested on this input/);
    assert.doesNotMatch(h.activity.logs.join("\n"), /obsolete fixture/);
    h.activity.opening[1].resolve(fakeStream()); await flush();
    [...h.activity.timers.values()][0](); await flush();
    h.activity.requests[1].resolve(fixtureResponse("new fixture")); await newDone;
    assert.match(h.node("mic-result").textContent, /new fixture/);
    assert.equal(h.button.disabled, false);
  }
});

test("explicit Record still produces exactly one synthetic test and reuses an explicit Allow", async () => {
  const h = settingsHarness();
  h.emit("mic-allow");
  const [done] = h.emit("mic-test");
  const [repeat] = h.emit("mic-test");
  await repeat;
  assert.equal(h.activity.opening.length, 1);
  h.activity.opening[0].resolve(fakeStream()); await flush();
  assert.equal(h.activity.recorders.length, 1);
  [...h.activity.timers.values()][0](); await flush();
  assert.equal(h.activity.requests.length, 1);
  assert.equal(h.activity.requests[0].url, "/api/buzzy/transcribe");
  assert.equal(h.activity.requests[0].init.method, "POST");
  h.activity.requests[0].resolve(fixtureResponse("explicit fixture"));
  await done;
  assert.match(h.node("mic-result").textContent, /explicit fixture/);
  assert.equal(h.button.textContent, "Record 3 s & transcribe");
});

test("pagehide retires a pending permission, and BFCache only restores explicit controls", async () => {
  const h = settingsHarness(), [oldDone] = h.emit("mic-test"), old = fakeStream();
  h.w.dispatch("pagehide", { persisted: true });
  assert.equal(h.button.disabled, false);
  h.emit("mic-allow");  // even an old queued click while suspended cannot open
  assert.equal(h.activity.opening.length, 1);
  h.w.dispatch("pageshow", { persisted: true });
  assert.equal(h.activity.opening.length, 1, "restore must not request a stream");
  const [freshDone] = h.emit("mic-test");
  const fresh = fakeStream();
  h.activity.opening[1].resolve(fresh);
  h.activity.opening[0].resolve(old);
  await oldDone; await flush();
  assert.deepEqual(old.tracks.map(t => t.stops), [1, 1]);
  assert.deepEqual(fresh.tracks.map(t => t.stops), [0, 0]);
  assert.equal(h.activity.contexts.length, 1);
  assert.equal(h.activity.recorders.length, 1);
  assert.equal(h.button.disabled, true, "obsolete finally must not reset the new test");
  [...h.activity.timers.values()][0](); await flush();
  h.activity.requests[0].resolve(fixtureResponse("restored explicit test"));
  await freshDone;
  assert.match(h.node("mic-result").textContent, /restored explicit test/);
});

test("pagehide stops the active test and earlier queued timer, recorder and RAF cannot send", async () => {
  const h = settingsHarness(), [done] = h.emit("mic-test"), stream = fakeStream();
  h.activity.opening[0].resolve(stream); await flush();
  const rec = h.activity.recorders[0], ondata = rec.ondataavailable, onstop = rec.onstop;
  const timer = [...h.activity.timers.values()][0], frame = [...h.activity.frames.values()][0];
  h.w.dispatch("pagehide", { persisted: false });
  assert.deepEqual(stream.tracks.map(t => t.stops), [1, 1], "tracks stop before pagehide returns");
  assert.equal(rec.stops, 1);
  assert.equal(h.activity.contexts[0].closed, 1);
  assert.equal(h.activity.contexts[0].disconnected, 1);
  assert.equal(h.activity.timers.size + h.activity.frames.size, 0);
  ondata({ data: new Blob(["stale fixture"]) }); onstop(); timer(); frame();
  await done;
  assert.equal(h.activity.requests.length, 0);
  assert.equal(h.node("mic-meter").hidden, true);
  assert.match(h.node("mic-status").textContent, /Microphone is off/);
});

test("pagehide aborts the diagnostic POST and a late body cannot repaint restored Settings", async () => {
  for (const abort of [true, false]) {
    const h = settingsHarness({ abort }), [done] = h.emit("mic-test"), stream = fakeStream();
    h.activity.opening[0].resolve(stream); await flush();
    [...h.activity.timers.values()][0](); await flush();
    const request = h.activity.requests[0], body = deferred();
    request.resolve({ ok: true, json: () => body.promise }); await flush();
    h.w.dispatch("pagehide", { persisted: true });
    if (abort) assert.equal(request.init.signal.aborted, true);
    assert.deepEqual(stream.tracks.map(t => t.stops), [1, 1]);
    h.w.dispatch("pageshow", { persisted: true });
    body.resolve({ ok: true, text: "abandoned synthetic result" }); await done;
    assert.equal(h.activity.opening.length, 1);
    assert.equal(h.node("mic-result").textContent, "Not tested yet.");
    assert.doesNotMatch(h.activity.logs.join("\n"), /abandoned synthetic result/);
  }
});

// Keep the real go() promise/guard sequencing and stashCurrent()/restore()
// decisions. Only fetch, wrapping/importing the fixture DOM and rendering are
// stubs; no real browser, audio or network runs.
function shellHarness(h) {
  const SETTINGS = "/buzzy/settings", BASE = "https://fixture.invalid";
  let active, url = new URL(SETTINGS, BASE);
  const trace = [], held = new Map();
  const hidden = {
    appendChild(page) { active = null; page.parentNode = hidden; trace.push(["keep-alive", page.key]); },
    removeChild(page) { assert.equal(page.parentNode, hidden); page.parentNode = null; },
  };
  function wrap(key) {
    const page = h.doc.createElement("div");
    page.key = key;
    page.id = "bzPage";
    page.setAttribute("data-bz-path", key);
    page.owner = key === SETTINGS ? h.node("microphone") : h.doc.createElement("main");
    page.querySelector = () => null;
    page.querySelectorAll = () => page.owner.attributes.has("data-bz-before-remove") ? [page.owner] : [];
    return page;
  }
  const lookup = h.doc.getElementById;
  h.doc.getElementById = id => id === "bzPage" ? active : id === "bzPageCache" ? hidden : lookup(id);
  h.doc.querySelectorAll = () => [];
  h.doc.body = {
    removeChild(page) {
      assert.equal(active, page);
      trace.push(["remove", page.key]);
      page.owner.isConnected = false;
      active = null;
    },
    insertBefore(page, container) {
      assert.equal(container, hidden);
      assert.equal(active, null);
      active = page;
      page.parentNode = this;
      trace.push(["mount", page.key]);
    },
  };
  active = wrap(SETTINGS);
  active.parentNode = h.doc.body;
  const context = createContext({
    URL, Event, location: { get href() { return url.href; }, origin: BASE },
    history: { pushState: (_, __, path) => { url = new URL(path, BASE); } },
    window: h.w, document: h.doc,
    ensurePageWrapper: () => active, adoptStyles() {}, buildFromDoc: (_, key) => wrap(key),
    DOMParser: class { parseFromString() { return { title: "Synthetic destination" }; } },
    fetch(href) {
      const wait = held.get(new URL(href).pathname);
      return wait?.promise ?? Promise.resolve({ ok: true, text: async () => "fixture" });
    },
    runScripts(page) {
      if (page.key === SETTINGS) { h.mount(); page.owner = h.node("microphone"); }
      return Promise.resolve();
    },
  });
  new Script(`var currentKey = "${SETTINGS}", currentReady = true, cache = {},
    busy = false, navigationId = 0, pendingNavigation = null, commitQueue = Promise.resolve(),
    KEEP_ALIVE = ["/buzzy/talk"];
    function finish(key) { currentKey = key; currentReady = true; }
    ${["keyOf", "isShellPath", "keepAlive", "stashCurrent", "restore", "go"].map(name => fn(nav, name, "  ")).join("\n")}`).runInContext(context);
  return { go: path => context.go(path), trace, held, get active() { return active; } };
}

test("real shell commits Settings cleanup before replacement and preserves Talk keep-alive", async () => {
  const h = settingsHarness(), shell = shellHarness(h);
  const [done] = h.emit("mic-test"), stream = fakeStream(), pane = shell.active.owner;
  h.activity.opening[0].resolve(stream); await flush();
  const rec = h.activity.recorders[0], oldStop = rec.onstop;
  pane.addEventListener("bz:before-remove", () => {
    assert.equal(pane.isConnected, true);
    assert.deepEqual(stream.tracks.map(t => t.stops), [1, 1]);
    assert.equal(h.activity.frames.size, 0);
    shell.trace.push(["revoked", "/buzzy/settings"]);
  });

  const held = deferred();
  shell.held.set("/buzzy/library", held);
  const superseded = shell.go("/buzzy/library");
  assert.equal(await shell.go("/buzzy/settings"), true);
  held.resolve({ ok: true, text: async () => "stale destination" });
  assert.equal(await superseded, false);
  assert.deepEqual(shell.trace, []);
  assert.deepEqual(stream.tracks.map(t => t.stops), [0, 0], "a superseded hop leaves the actually mounted Settings alone");

  assert.equal(await shell.go("/buzzy/talk"), true);
  assert.deepEqual(shell.trace, [["revoked", "/buzzy/settings"], ["remove", "/buzzy/settings"], ["mount", "/buzzy/talk"]]);
  assert.equal(h.w.events.get("pagehide")?.size, 0);
  assert.equal(h.w.events.get("pageshow")?.size, 0);
  oldStop(); await done;
  assert.equal(h.activity.requests.length, 0);

  const cached = shell.active;
  cached.owner.setAttribute("data-bz-before-remove", "");
  cached.owner.addEventListener("bz:before-remove", () => assert.fail("Talk was discarded rather than cached"));
  assert.equal(await shell.go("/buzzy/settings"), true);
  assert.notEqual(shell.active.owner, pane);
  assert.equal(h.w.events.get("pagehide")?.size, 1);
  assert.equal(h.activity.opening.length, 1, "fresh Settings never resumes capture");
  assert.equal(await shell.go("/buzzy/talk"), true);
  assert.equal(shell.active, cached);
});

test("a Settings permission granted after real shell detach cannot attach to the reopened pane", async () => {
  const h = settingsHarness(), shell = shellHarness(h), [done] = h.emit("mic-test"), old = fakeStream();
  assert.equal(await shell.go("/buzzy/talk"), true);
  assert.equal(await shell.go("/buzzy/settings"), true);
  h.emit("mic-allow");
  const fresh = fakeStream();
  h.activity.opening[1].resolve(fresh); await flush();
  h.activity.opening[0].resolve(old); await flush();
  assert.deepEqual(old.tracks.map(t => t.stops), [1, 1]);
  assert.deepEqual(fresh.tracks.map(t => t.stops), [0, 0]);
  assert.equal(h.activity.contexts.length, 1);
  assert.equal(h.activity.recorders.length, 0);
  assert.equal(h.activity.requests.length, 0);
  assert.match(h.node("mic-status").textContent, /Microphone ready/);
  await done;
});

test("Settings microphone denial is actionable and keeps native details private", async () => {
  const h = settingsHarness({ permission: Promise.resolve({ state: "denied" }) });
  await flush();
  assert.match(h.node("mic-status").textContent, /access was denied.*privacy settings/i);
  assert.equal(h.activity.opening.length, 0);
  h.emit("mic-allow");
  const fault = new Error("fixture-native-device-detail");
  fault.name = "NotAllowedError";
  h.activity.opening[0].reject(fault); await flush();
  assert.match(h.node("mic-status").textContent, /access was denied.*privacy settings/i);
  assert.doesNotMatch(h.activity.logs.join("\n"), /fixture-native-device-detail|fixture-A/);
});

test("a muted device is not immediately reported ready", async () => {
  const h = settingsHarness(), stream = fakeStream();
  stream.tracks[0].muted = true;
  h.emit("mic-allow");
  h.activity.opening[0].resolve(stream); await flush();
  assert.match(h.node("mic-status").textContent, /opened but is muted/);
  assert.doesNotMatch(h.node("mic-status").textContent, /Microphone ready/);
});

test("Settings shows its explicit test transcript locally but keeps support diagnostics private", async () => {
  const h = settingsHarness({ enumerate: () => Promise.resolve([{ kind: "audioinput", label: "fixture-device-label", deviceId: "fixture-A" }]) });
  const [done] = h.emit("mic-test");
  const stream = fakeStream();
  stream.tracks[0].label = "fixture-device-label";
  h.activity.opening[0].resolve(stream); await flush();
  [...h.activity.timers.values()][0](); await flush();
  h.activity.requests[0].resolve(fixtureResponse("fixture-private-spoken-words"));
  await done;
  assert.match(h.node("mic-result").textContent, /fixture-private-spoken-words/);
  await h.emit("mic-copy")[0];
  const copied = h.activity.copied.at(-1);
  assert.match(copied, /last result: Transcribed/);
  assert.doesNotMatch(copied + h.activity.logs.join("\n"), /fixture-private-spoken-words|fixture-device-label|fixture-private-profile|fixture-A/);
});

test("after a Settings reload, a Local Only refusal explains what typed chat still needs", async () => {
  const h = settingsHarness();
  h.w.dispatch("pagehide"); h.mount();
  const [done] = h.emit("mic-test");
  h.activity.opening[0].resolve(fakeStream()); await flush();
  [...h.activity.timers.values()][0](); await flush();
  h.activity.requests[0].resolve({ ok: false, status: 409, json: async () => ({ ok: false,
    code: "transcription_local_only", error: "fixture-provider-account-detail" }) });
  await done;
  assert.match(h.node("mic-result").textContent, /Local Only.*Typed chat in Local Only needs a local inference service.*Base URL/i);
  await h.emit("mic-copy")[0];
  assert.doesNotMatch(h.node("mic-result").textContent + h.activity.copied.at(-1) + h.activity.logs.join("\n"), /fixture-provider-account-detail/);
});

test("Settings enumerates device names as text and retains only an available selection", async () => {
  const label = 'Sand & Stone "Input"';
  const h = settingsHarness({ enumerate: () => Promise.resolve([
    { kind: "audioinput", deviceId: "fixture-A", label },
    { kind: "audioinput", deviceId: "fixture-B", label: "" },
  ]) });
  await flush();
  const select = h.node("mic-device");
  assert.deepEqual(Array.from(select.options, ({ value, textContent }) => [value, textContent]), [
    ["", "System default"], ["fixture-A", label], ["fixture-B", "Microphone 2"],
  ]);
  assert.equal(select.value, "fixture-A");
  const missing = settingsHarness({ enumerate: () => Promise.resolve([
    { kind: "audioinput", deviceId: "fixture-replacement", label: "" },
  ]) });
  await flush();
  assert.equal(missing.node("mic-device").value, "");
});
