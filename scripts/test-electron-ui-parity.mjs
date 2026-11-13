#!/usr/bin/env node
/**
 * Dependency-free merge regression checks for web + local desktop UI parity.
 * Run: node scripts/test-electron-ui-parity.mjs (Node 22.13+).
 *
 * This is not browser/Electron E2E. It parses the shipped scripts, exercises the
 * real page-handler body with only h3/IO adapters, and executes Talk's microphone
 * selection code with fake recognizers. No providers, devices or network calls.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script, runInNewContext } from "node:vm";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const pageSource = read("src/lib/buzzy/pages.nitro.ts");
const talk = read("public/buzzy/talk.html");
const library = read("public/buzzy/library.html");
const nav = read("public/buzzy/nav.js");
const chat = read("public/buzzy/chat.js");
const navScript = '<script src="/buzzy/nav.js" defer></script>';
const names = [
  "index", "talk", "memory", "remember", "experts", "library", "profile",
  "landing", "login", "recipes", "wallet", "upload", "graph", "capabilities",
  "project", "sketch", "studio", "settings",
];

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((m) => !/\bsrc\s*=/.test(m[1]))
    .map((m) => m[2]);
}

function compileScripts(html, filename) {
  for (const [i, source] of inlineScripts(html).entries()) {
    new Script(source, { filename: `${filename}:script-${i + 1}` });
  }
}

// Exercise the handler without depending on a particular Nitro/h3 installation.
// Use the production handler body unchanged after TS erasure; only imports and
// the export are adapted so its real file reads and Response objects still run.
function pageHandler(readImpl = readFile) {
  const js = stripTypeScriptTypes(pageSource)
    .replace(/import\s*\{[^}]+\}\s*from\s*["']h3["'];/, "")
    .replace(/import\s*\{[^}]+\}\s*from\s*["']node:fs\/promises["'];/, "")
    .replace(/import\s*\{[^}]+\}\s*from\s*["']node:path["'];/, "")
    .replace("export default", "globalThis.handler =");
  const context = {
    defineEventHandler: (fn) => fn,
    getMethod: (event) => event.method || "GET",
    setResponseStatus: (event, status) => { event.status = status; },
    sendRedirect: (event, location, status = 302) => {
      event.status = status;
      return new Response(null, { status, headers: { location } });
    },
    readFile: readImpl, join, resolve, Buffer, Uint8Array, Response,
    process: { cwd: () => ROOT },
  };
  runInNewContext(js, context, { filename: "pages.nitro.ts" });
  return context.handler;
}

test("all public BeeZilla JS and inline scripts parse without merge markers", () => {
  let scripts = 0;
  for (const file of readdirSync(join(ROOT, "public/buzzy"))) {
    if (!/\.(?:html|js)$/.test(file)) continue;
    const source = read(`public/buzzy/${file}`);
    assert.doesNotMatch(source, /^(?:<<<<<<<|=======|>>>>>>>)/m, file);
    if (file.endsWith(".js")) {
      new Script(source, { filename: file });
      scripts += 1;
    } else {
      compileScripts(source, file);
      scripts += inlineScripts(source).length;
    }
  }
  assert.ok(scripts >= 42, `expected the full UI, found only ${scripts} scripts`);
  assert.doesNotMatch(pageSource, /^(?:<<<<<<<|=======|>>>>>>>)/m);
});

test("every current web page and desktop Settings is routed with one shared nav", async () => {
  const handler = pageHandler();
  for (const name of names) {
    const path = name === "index" ? "/buzzy" : `/buzzy/${name}`;
    const result = await handler({ path: `${path}/?job=parity-check` });
    if (name === "index") {
      // /buzzy is not a page any more: the handler redirects it to Talk. The Library
      // page is library.html, routed as /buzzy/library.
      assert.equal(result.status, 302, path);
      assert.equal(result.headers.get("location"), "/buzzy/talk", path);
      continue;
    }
    assert.equal(result.status, 200, path);
    assert.match(result.headers.get("content-type"), /text\/html/);
    const body = await result.text();
    const raw = read(`public/buzzy/${name}.html`);
    const at = raw.lastIndexOf("</body>");
    assert.equal(body, raw.slice(0, at) + navScript + raw.slice(at), path);
    assert.equal(body.split(navScript).length - 1, 1, path);
    // Talk's Word export contains a literal </body> inside JS. Injection must
    // follow the real final body tag, not break that script string.
    compileScripts(body, path);
  }
});

test("existing nav is not injected twice and production public fallback works", async () => {
  const original = `<!doctype html><body>${navScript}</body>`;
  const calls = [];
  const handler = pageHandler(async (path) => {
    calls.push(path);
    if (path === join(ROOT, ".output/public/buzzy/settings.html")) return Buffer.from(original);
    throw new Error("not present in source public");
  });
  const result = await handler({ path: "/buzzy/settings" });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), original);
  assert.deepEqual(calls, [
    join(ROOT, "public/buzzy/settings.html"),
    join(ROOT, ".output/public/buzzy/settings.html"),
  ]);
});

test("shared JS/CSS assets remain readable and unknown paths/methods are refused", async () => {
  const handler = pageHandler();
  for (const file of ["nav.js", "chat.js", "nav.css"]) {
    const result = await handler({ path: `/buzzy/${file}` });
    assert.equal(result.status, 200, file);
    assert.equal(await result.text(), read(`public/buzzy/${file}`));
  }
  for (const path of ["/buzzy/form", "/buzzy/unknown", "/buzzy/../package.json", "/buzzy/a/b"]) {
    const event = { path };
    const result = await handler(event);
    assert.equal(result.status, 404, path);
    assert.equal(event.status, 404, path);
  }
  const event = { path: "/buzzy/settings", method: "POST" };
  const result = await handler(event);
  assert.equal(event.status, 405);
  assert.equal(result.error, "method not allowed");
});

test("main's shared chat, creative pages and Library survive local integration", () => {
  for (const name of ["talk", "sketch", "studio", "library", "capabilities"]) {
    assert.ok(nav.includes(`href: "/buzzy/${name}"`), `${name} remains in shared navigation`);
  }
  assert.match(nav, /s\.src = "\/buzzy\/chat\.js"/);
  assert.match(nav, /if \(section\(\) !== "talk"\) askControl\(chrome\)/);
  assert.match(chat, /window\.BeeZillaChat = \{ mount:/);
  assert.match(chat, /bz_session_id/);
  assert.match(chat, /stream: true/);
  assert.match(chat, /data\.artifacts/);
  for (const name of ["studio", "project"]) {
    assert.match(read(`public/buzzy/${name}.html`), /BeeZillaChat\.mount/);
  }
  assert.match(read("public/buzzy/studio.html"), /\/api\/buzzy\/studio/);
  assert.match(read("public/buzzy/sketch.html"), /\/api\/buzzy\/art/);
  assert.match(library, /function loadArtifactShelf\(/);
  assert.match(library, /<audio controls/);
  assert.equal((library.match(/function renderServerFiles\(/g) || []).length, 1);
  assert.equal((talk.match(/asset: data\.audio/g) || []).length, 1);
  assert.match(talk, /asset: data\.audio \|\| data\.asset \|\| null/);
  assert.match(read("public/buzzy/capabilities.html"), /caps-account/);
  assert.match(read("public/buzzy/capabilities.html"), /\/api\/buzzy\/capabilities/);
  assert.match(read("public/buzzy/settings.html"), /window\.beezilla\?\.settings/);
  assert.match(read("public/buzzy/settings.html"), /id="nobridge"/);
});

function microphone({ desktop = false, available = true, throws = false, asr = "sr" } = {}) {
  const start = talk.indexOf("    function startListening() {");
  const end = talk.indexOf("    function stopListening() {", start);
  assert.ok(start !== -1 && end > start);
  const calls = { recorder: 0, recognition: 0, stopped: 0 };
  function Recognizer() {
    this.start = () => {
      calls.recognition += 1;
      if (throws) throw new Error("speech service unavailable");
    };
    this.stop = () => { calls.stopped += 1; };
  }
  const context = {
    voice: { rec: null, asr, mic: true }, recState: null, recAcquiring: null,
    window: { SpeechRecognition: Recognizer, ...(desktop ? { beezilla: {} } : {}) },
    srAvailable: () => available,
    startRecording: () => { calls.recorder += 1; },
    paintVoice() {}, stageNote() {}, saveListenPref() {},
  };
  runInNewContext(talk.slice(start, end), context);
  context.startListening();
  return { context, calls };
}

test("desktop always records while web SpeechRecognition and fallback remain intact", () => {
  assert.match(talk, /asr: window\.beezilla \? "recorder" : "sr"/);
  const desktop = microphone({ desktop: true });
  assert.equal(desktop.calls.recorder, 1);
  assert.equal(desktop.calls.recognition, 0);
  const browser = microphone();
  assert.equal(browser.calls.recorder, 0);
  assert.equal(browser.calls.recognition, 1);
  browser.context.startListening();
  assert.equal(browser.calls.recognition, 1, "a repeated start does not open a second recognizer");
  browser.context.voice.rec.onerror({ error: "network" });
  assert.equal(browser.calls.recorder, 1);
  assert.equal(browser.context.voice.asr, "recorder");
  assert.equal(microphone({ available: false }).calls.recorder, 1);
  const throwing = microphone({ throws: true });
  assert.equal(throwing.calls.recorder, 1);
  assert.equal(throwing.context.voice.rec, null);
  assert.equal(throwing.context.voice.asr, "recorder");
  const denied = microphone();
  denied.context.voice.rec.onerror({ error: "not-allowed" });
  assert.equal(denied.context.voice.mic, false);
  assert.equal(denied.calls.recorder, 0, "a permission denial never falls through to recording");
  assert.match(talk, /SPEECH_RMS = 0\.008/);
  assert.match(talk, /if \(ctx\.state === "suspended"\).*ctx\.resume\(\)/);
  assert.match(talk, /window\.beezilla\.app\.log\("voice: " \+ msg\)/);
});

function recorderHarness({ failSetup = false } = {}) {
  const start = talk.indexOf("    function startListening() {");
  const end = talk.indexOf("    // ── Context meter", start);
  assert.ok(start !== -1 && end > start);
  const requests = [];
  const contexts = [];
  const timers = [];
  const notes = [];
  const context = {
    voice: { rec: null, asr: "recorder", mic: false, replies: false, sending: false, speaking: false },
    navigator: { mediaDevices: { getUserMedia() {
      return new Promise((resolve, reject) => { requests.push({ resolve, reject }); });
    } } },
    window: { beezilla: {}, AudioContext: class {
      constructor() {
        this.state = "suspended";
        this.sampleRate = 48000;
        this.closed = false;
        this.destination = {};
        contexts.push(this);
      }
      resume() { this.state = "running"; return Promise.resolve(); }
      close() { this.closed = true; this.state = "closed"; return Promise.resolve(); }
      createMediaStreamSource() {
        return this.source = { connected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; } };
      }
      createScriptProcessor() {
        if (failSetup) throw new Error("Audio setup failed");
        return this.processor = { connected: false, connect() { this.connected = true; }, disconnect() { this.connected = false; } };
      }
    } },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    paintVoice() {}, setAvatarState() {}, saveListenPref() {}, saveVoicePref() {}, stopSpeaking() {},
    stageNote(note) { notes.push(note); },
    console: { log() {} },
  };
  runInNewContext(talk.slice(start, end), context);
  const stream = () => {
    const track = { stopped: false, stop() { this.stopped = true; }, getSettings() { return {}; } };
    return { track, getTracks: () => [track], getAudioTracks: () => [track] };
  };
  return { context, requests, contexts, timers, notes, stream };
}
const settleRecorder = () => new Promise((resolve) => setImmediate(resolve));

test("pending microphone acquisition is deduplicated and canceled streams are released", async () => {
  const h = recorderHarness();
  h.context.toggleMic();
  h.context.startListening();
  h.context.startRecording();
  assert.equal(h.requests.length, 1, "repeated starts share the pending acquisition");
  h.context.toggleMic();
  const stream = h.stream();
  h.requests[0].resolve(stream);
  await settleRecorder();
  assert.equal(stream.track.stopped, true, "a stream arriving after Off is immediately stopped");
  assert.equal(h.context.recState, null);
  assert.equal(h.context.recAcquiring, null);
  assert.equal(h.contexts.length, 0, "canceled streams never get an AudioContext");
});

test("rapid on/off/on never leaks either stream in either permission-resolution order", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const h = recorderHarness();
    h.context.toggleMic();
    h.context.toggleMic();
    h.context.toggleMic();
    h.context.startListening();
    assert.equal(h.requests.length, 2);
    const streams = [h.stream(), h.stream()];
    for (const i of order) { h.requests[i].resolve(streams[i]); await settleRecorder(); }
    assert.equal(streams[0].track.stopped, true, "the obsolete permission result is released");
    assert.equal(streams[1].track.stopped, false);
    assert.equal(h.context.recState.stream, streams[1], "only the current acquisition owns recording");
    assert.equal(h.contexts.length, 1);
    h.context.toggleMic();
    assert.ok(streams.every((stream) => stream.track.stopped), "Off stops every acquired track");
    assert.ok(h.contexts.every((ctx) => ctx.closed));
    assert.equal(h.context.recState, null);
    assert.equal(h.context.recAcquiring, null);
  }
});

test("stale permission errors and old callbacks cannot alter a newer recording", async () => {
  const h = recorderHarness();
  h.context.toggleMic();
  h.context.toggleMic();
  h.context.toggleMic();
  h.requests[0].reject(Object.assign(new Error("Old permission denied"), { name: "NotAllowedError" }));
  await settleRecorder();
  assert.equal(h.context.voice.mic, true, "an old error must not turn off the new request");
  assert.equal(h.notes.length, 0);
  const first = h.stream();
  h.requests[1].resolve(first);
  await settleRecorder();
  const oldAudio = h.context.recState.proc.onaudioprocess;
  const oldDiagnostic = h.timers[0];
  h.context.toggleMic();
  h.context.toggleMic();
  const second = h.stream();
  h.requests[2].resolve(second);
  await settleRecorder();
  oldAudio({ inputBuffer: { getChannelData: () => new Float32Array(2048) } });
  oldDiagnostic();
  assert.equal(h.context.recState.frames, 0, "old processor callbacks cannot write new recording state");
  assert.equal(h.notes.length, 0, "old diagnostics cannot show a failure for the new stream");
  h.context.toggleMic();
  assert.equal(first.track.stopped, true);
  assert.equal(second.track.stopped, true);
});

test("recorder setup failure releases the stream and partially created audio graph", async () => {
  const h = recorderHarness({ failSetup: true });
  h.context.toggleMic();
  const stream = h.stream();
  h.requests[0].resolve(stream);
  await settleRecorder();
  assert.equal(stream.track.stopped, true);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.contexts[0].source.connected, false);
  assert.equal(h.context.recState, null);
  assert.equal(h.context.recAcquiring, null);
  h.context.startListening();
  assert.equal(h.requests.length, 2, "failure does not leave acquisition permanently locked");
  h.context.toggleMic();
  const retry = h.stream();
  h.requests[1].resolve(retry);
  await settleRecorder();
  assert.equal(retry.track.stopped, true);
});

async function settingsHarness(result) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: id, innerHTML: "", disabled: false, hidden: false,
      style: {}, handlers: {}, classList: { toggle() {} },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      querySelectorAll() { return []; }, setAttribute() {}, removeAttribute() {},
    });
    return elements.get(id);
  }
  const byok = Object.assign(element("provider-byok"), { value: "byok", checked: true });
  const managed = Object.assign(element("provider-beezilla"), { value: "beezilla", checked: false });
  for (const id of ["key", "search-key", "music-key"]) element(id).value = "probe-secret";
  const state = { inference: null, search: null, music: null };
  const bridge = {
    get: async () => ({ ok: true, data: state }),
    saveInference: async () => result,
    saveSearch: async () => result,
    saveMusic: async () => result,
    clear: async () => result,
  };
  const script = inlineScripts(read("public/buzzy/settings.html"))[0];
  const end = script.indexOf("      // Diagnostics — desktop only.");
  assert.ok(end > 0);
  runInNewContext(script.slice(0, end), {
    window: { beezilla: { settings: bridge } },
    document: {
      getElementById: element,
      querySelector(selector) {
        const value = selector.match(/value="([^"]+)"/)?.[1];
        return value === "beezilla" ? managed : byok;
      },
      querySelectorAll: () => [byok, managed],
    },
  });
  await settleRecorder(); // initial settings refresh
  return {
    element,
    click: async (id) => {
      assert.equal(typeof element(id).handlers.click, "function", id);
      await element(id).handlers.click();
    },
  };
}

const credentialActions = [
  ["save-inference", "inference-status", "Saved.", "key"],
  ["save-search", "search-status", "Saved.", "search-key"],
  ["save-music", "music-status", "Saved.", "music-key"],
  ["clear-inference", "inference-status", "Key removed."],
  ["clear-search", "search-status", "Key removed."],
  ["clear-music", "music-status", "Key removed."],
];

test("all credential save/remove handlers warn when IPC succeeded but engine restart did not", async () => {
  for (const data of [
    { restarted: false, reason: "restartfailed" },
    { restarted: false, reason: "no supervisor" },
    {}, // Missing startup evidence is not success.
  ]) {
    const h = await settingsHarness({ ok: true, data });
    for (const [button, status, completed, input] of credentialActions) {
      await h.click(button);
      assert.equal(h.element(status).className, "status warn", button);
      assert.ok(h.element(status).textContent.startsWith(completed), button);
      assert.match(h.element(status).textContent, /did not restart.*Restart the app to apply the change/);
      assert.doesNotMatch(h.element(status).textContent, /BeeZilla (?:started|restarted)\./);
      if (data.reason) assert.ok(h.element(status).textContent.includes(data.reason), button);
      if (input) assert.equal(h.element(input).value, "", "successfully saved keys still leave the input");
    }
  }
});

test("credential UI distinguishes confirmed startup from failed credential writes", async () => {
  for (const data of [{ started: true, restarted: false }, { restarted: true, started: false }]) {
    const h = await settingsHarness({ ok: true, data });
    for (const [button, status, completed] of credentialActions) {
      await h.click(button);
      assert.equal(h.element(status).className, "status ok", button);
      assert.equal(h.element(status).textContent, `${completed} BeeZilla ${data.started ? "started" : "restarted"}.`);
    }
  }
  const h = await settingsHarness({ ok: false, error: "Credential write failed" });
  for (const [button, status, , input] of credentialActions) {
    await h.click(button);
    assert.equal(h.element(status).className, "status err", button);
    assert.equal(h.element(status).textContent, "Credential write failed");
    if (input) assert.equal(h.element(input).value, "probe-secret", "failed saves retain the entered key for retry");
  }
});
