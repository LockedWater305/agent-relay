#!/usr/bin/env node
/**
 * Regression tests for Talk's asynchronous speech ownership and diagnostic mic.
 * Run: node --test scripts/test-talk-voice-lifecycle.mjs
 * Optional TALK_CANDIDATE points to another talk.html for isolated review.
 * Only the shipped functions execute; all browser IO is deterministic and fake.
 * No browser, audio device, network, provider, dependencies or source snapshots.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(process.env.TALK_CANDIDATE ||
  new URL("../public/buzzy/talk.html", import.meta.url), "utf8");
function fn(name) {
  const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    \\}`, "m"));
  assert.ok(match, `shipped function ${name} exists`);
  return match[0];
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function response(data = { ok: true, text: "spoken words" }, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => data };
}
function element() {
  return { value: "", textContent: "", disabled: false, title: "", style: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, focus() {}, appendChild() {}, closest() { return null; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  };
}
const senders = ["sendHeardTurn", "sendForTranscription"];
function speechHarness({ realSend = false, controller = true, wav = {} } = {}) {
  const requests = [], sent = [], timers = [], notes = [], rendered = [], storage = [];
  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const c = {
    AbortController: controller ? AbortController : undefined,
    AbortSignal: { timeout: () => undefined },
    voice: { mic: true, rec: null, sending: false, speaking: false, replies: false,
      note: "", speechGeneration: 0, speechRequest: null, turnSeq: 0, cutTurn: -1 },
    chatState: { jobId: "original/job", sessionId: "original-session", boundCompanyId: "original-company",
      jobContext: { title: "Original Job" }, slots: {}, messages: [] },
    document: { getElementById: node, createElement: element, querySelector: () => null,
      addEventListener() {}, removeEventListener() {} },
    window: { location: { pathname: "/buzzy/talk" } },
    sessionStorage: { getItem: () => null },
    localStorage: { setItem: (...args) => storage.push(args), removeItem() {} },
    history: { replaceState() {} },
    fetch(url, init) { const request = deferred(); requests.push({ ...request, url, init }); return request.promise; },
    performance: { now: () => 100 }, crypto: { randomUUID: () => "fake-id" },
    setTimeout(callback) { timers.push(callback); return timers.length; }, setInterval() { return 1; }, clearInterval() {},
    finishCapture: () => wav, jobNameFix: (s) => String(s || ""), brandName: (s) => String(s || ""),
    setAvatarState() {}, paintVoice() {},
    stageNote(text) { c.voice.note = text; notes.push(text); c.paintVoice(); },
    rearmListening() { timers.push("rearm"); }, micLog() {},
    cancelRecording() {}, preRollStop() {}, bargeDisarm() {}, dropCapture() {}, probeStop() {},
    startListening() {}, stopSpeaking() {}, saveListenPref() {}, saveVoicePref() {},
    srAvailable: () => true, voicePref: () => false, listenPref: () => false, mountAvatars() {},
    toggleVoiceReplies() {}, clipHasSpeech: () => false,
    PROBE_ON: false, capState: null,
    bzJobCtx: (s) => s, resetDraftGate() {}, setBackVisible() {}, updateChrome() {},
    restoreTranscript() {}, showRecentWork() {}, resetContextMeter() {}, setChatMascot() {},
    renderChatMessages() { rendered.push(c.chatState.messages.slice()); }, renderSlotChecklist() {},
    welcomeMessage: () => "Welcome", closeSessionsDrawer() {}, showChatScreen() {}, sessionsError() {},
    loadCompanyPaper() {}, loadSessions() {},
    activeCompanyId: () => c.chatState.boundCompanyId,
    selectedModel: () => "test-model", getAuthHeaders: () => ({}),
    pendingExecute: false, CHAT_BASE: "/chat", SESSIONS_BASE: "/sessions", paperBusy: false, paperLoad: 0,
    paintContext() {}, logVoiceMetrics() {}, maybeSpeak() {}, renderPaper() {},
    sendChatMessage(event, request) {
      sent.push({ jobId: c.chatState.jobId, sessionId: c.chatState.sessionId, text: node("chatInput").value });
      if (c.voice.speechRequest === request) c.voice.speechRequest = null;
    },
  };
  const names = ["invalidateSpeechRequest", "speechContextChanged", "beginSpeechRequest", "speechRequestCurrent", "finishSpeechRequest",
    "asrQueryString", "submitHeard", "sendHeardTurn", "sendForTranscription", "stopListening", "releaseMic", "toggleMic",
    "initVoice", "goBackToRecent", "newChatNow", "openSession", "startNewChat", "applyChatCompany", "paintVoice"];
  if (realSend) names.push("sendChatMessage", "ensureChatSession", "readThisBody", "submitPaper");
  runInNewContext(names.map(fn).join("\n"), c, { filename: "talk-speech-lifecycle.js" });
  c.initVoice();
  function start(sender = "sendForTranscription", text = "recognizer fallback") {
    c[sender](sender === "sendHeardTurn" ? text : { wav: true });
    return requests.at(-1);
  }
  return { c, requests, sent, timers, notes, node, rendered, storage, start,
    stop() { c.window.BeeZillaVoice.stop(); },
    openJob(id) { c.window.BeeZillaTalk.openJob(id); },
  };
}

for (const sender of senders) {
  test(`${sender}: unchanged context submits exactly once to the original conversation`, async () => {
    const h = speechHarness(); const request = h.start(sender);
    assert.equal(request.url, "/api/buzzy/transcribe?jobId=original%2Fjob&vocab=Original%20Job");
    request.resolve(response()); await settle();
    assert.deepEqual(h.sent, [{ jobId: "original/job", sessionId: "original-session", text: "spoken words" }]);
    assert.equal(h.c.voice.speechRequest, null);
  });
  for (const outcome of ["success", "failure", "bad-json", "refused"]) {
    test(`${sender}: Stop discards delayed ${outcome} without altering a new draft`, async () => {
      const h = speechHarness(); const request = h.start(sender);
      h.stop(); h.node("chatInput").value = "new typed draft";
      const notes = h.notes.length, timers = h.timers.length;
      assert.equal(request.init.signal.aborted, true);
      if (outcome === "failure") request.reject(new Error("offline"));
      else if (outcome === "bad-json") request.resolve({ ok: true, json: () => Promise.reject(new Error("bad json")) });
      else request.resolve(response(outcome === "refused" ? { ok: false, error: "refused" } : undefined));
      await settle();
      assert.deepEqual(h.sent, []);
      assert.equal(h.node("chatInput").value, "new typed draft");
      assert.equal(h.c.voice.sending, false);
      assert.equal(h.notes.length, notes, "stale callbacks do not paint errors");
      assert.equal(h.timers.length, timers, "stale callbacks do not rearm");
      assert.match(h.node("voiceStatus").textContent, /discarded.*Listen is off/i);
    });
  }
  test(`${sender}: Stop while response JSON is pending prevents late submission`, async () => {
    const h = speechHarness(); const request = h.start(sender); const body = deferred();
    request.resolve({ ok: true, json: () => body.promise }); await settle();
    h.stop(); h.c.voice.mic = true; h.node("chatInput").value = "new draft";
    body.resolve({ ok: true, text: "stale body" }); await settle();
    assert.deepEqual(h.sent, []); assert.equal(h.node("chatInput").value, "new draft");
  });
  test(`${sender}: A→B→A navigation cannot revive an old request`, async () => {
    const h = speechHarness(); const request = h.start(sender);
    h.openJob("new-job"); h.openJob("original/job");
    assert.equal(h.c.voice.sending, false);
    assert.match(h.node("voiceStatus").textContent, /discarded.*conversation changed/i);
    h.node("chatInput").value = "new conversation draft";
    request.resolve(response()); await settle();
    assert.deepEqual(h.sent, []); assert.equal(h.node("chatInput").value, "new conversation draft");
  });
  test(`${sender}: Stop→Listen on in the same job does not revive a pending request`, async () => {
    const h = speechHarness(); const request = h.start(sender);
    h.stop(); h.c.toggleMic(); request.resolve(response()); await settle();
    assert.deepEqual(h.sent, []); assert.equal(h.c.voice.mic, true);
  });
  test(`${sender}: completion checks job, session, company and context identity even outside navigation hooks`, async () => {
    for (const mutate of [
      (c) => { c.chatState.jobId = "other"; },
      (c) => { c.chatState.sessionId = "other"; },
      (c) => { c.chatState.boundCompanyId = "other"; },
      (c) => { c.chatState = { ...c.chatState }; },
    ]) {
      const h = speechHarness(); const request = h.start(sender); mutate(h.c);
      h.node("chatInput").value = "keep me"; request.resolve(response()); await settle();
      assert.deepEqual(h.sent, []); assert.equal(h.node("chatInput").value, "keep me");
      assert.equal(h.c.voice.sending, false); assert.equal(h.c.voice.speechRequest, null);
    }
  });
  test(`${sender}: older success/failure cannot clear a newer request or submit its fallback`, async () => {
    for (const failure of [false, true]) {
      for (const newFirst of [false, true]) {
        const h = speechHarness(); const old = h.start(sender, "old fallback");
        h.stop(); h.c.toggleMic(); const fresh = h.start(sender, "new fallback");
        const token = h.c.voice.speechRequest;
        const finishOld = async () => {
          if (failure) old.reject(new Error("old failure")); else old.resolve(response({ ok: true, text: "old result" }));
          await settle();
        };
        if (newFirst) { fresh.resolve(response({ ok: true, text: "new result" })); await settle(); }
        await finishOld();
        if (!newFirst) {
          assert.equal(h.c.voice.speechRequest, token); assert.equal(h.c.voice.sending, true);
          fresh.resolve(response({ ok: true, text: "new result" })); await settle();
        }
        assert.deepEqual(h.sent.map((s) => s.text), ["new result"]);
      }
    }
  });
  test(`${sender}: no AbortController still discards stale results`, async () => {
    const h = speechHarness({ controller: false }); const request = h.start(sender);
    h.stop(); h.c.toggleMic(); request.resolve(response()); await settle(); assert.deepEqual(h.sent, []);
  });
  test(`${sender}: a late caller cannot start a request while Listen is off`, () => {
    const h = speechHarness(); h.stop(); h.start(sender);
    assert.equal(h.requests.length, 0); assert.deepEqual(h.sent, []);
  });
}

test("a superseded request is aborted and cannot clear the direct replacement", async () => {
  const h = speechHarness(); const old = h.start(); const fresh = h.start();
  assert.equal(old.init.signal.aborted, true);
  old.resolve(response()); await settle(); assert.equal(h.c.voice.sending, true); assert.deepEqual(h.sent, []);
  fresh.resolve(response({ ok: true, text: "fresh" })); await settle(); assert.equal(h.sent[0].text, "fresh");
});
test("recognized text without a clip still submits only in a live Listen session", () => {
  const h = speechHarness({ wav: null }); h.start("sendHeardTurn", "no clip fallback");
  assert.equal(h.requests.length, 0); assert.equal(h.sent[0].text, "no clip fallback");
  h.stop(); h.start("sendHeardTurn", "do not send"); assert.equal(h.sent.length, 1);
});
test("active transcriber failures keep the existing fallback/error behavior and relinquish ownership", async () => {
  const sr = speechHarness(); sr.start("sendHeardTurn").reject(new Error("offline")); await settle();
  assert.equal(sr.sent[0].text, "recognizer fallback");
  for (const failure of ["offline", "refused", "empty"]) {
    const h = speechHarness(); const request = h.start();
    if (failure === "offline") request.reject(new Error("offline"));
    else request.resolve(response(failure === "refused" ? { ok: false, error: "refused" } : { ok: true, text: "" }));
    await settle(); assert.deepEqual(h.sent, []); assert.equal(h.c.voice.speechRequest, null);
    assert.equal(h.c.voice.sending, false); assert.equal(h.timers.at(-1), "rearm");
  }
});

for (const navigate of ["goBackToRecent", "newChatNow", "company", "openSession", "startNewChat"]) {
  test(`${navigate}: real navigation revokes pending speech at intent and async commit`, async () => {
    const h = speechHarness(); const pending = h.start();
    if (navigate === "company") h.c.applyChatCompany({ id: "new-company", name: "New company" });
    else if (navigate === "openSession") h.c.openSession({ id: "next-session" });
    else h.c[navigate]();
    assert.equal(pending.init.signal.aborted, true);
    pending.resolve(response()); await settle(); assert.deepEqual(h.sent, []);
    if (navigate === "openSession" || navigate === "startNewChat") {
      const navigation = h.requests[1]; const during = h.start();
      navigation.resolve(response(navigate === "openSession" ? { messages: [] } : { session: { id: "next-session" } }));
      await settle(); assert.equal(during.init.signal.aborted, true);
      during.resolve(response()); await settle(); assert.deepEqual(h.sent, []);
    }
  });
}

for (const sender of senders) {
  for (const action of ["stop", "job", "same-job"]) {
    test(`${sender}: ${action} during chat-session creation cannot retarget speech or install the old session`, async () => {
      const h = speechHarness({ realSend: true }); h.c.chatState.sessionId = null;
      h.start(sender).resolve(response()); await settle();
      assert.equal(h.requests[1].url, "/sessions");
      if (action === "stop") { h.stop(); h.c.toggleMic(); }
      else h.openJob(action === "job" ? "new-job" : "original/job");
      h.node("chatInput").value = "new draft";
      h.requests[1].resolve(response({ session: { id: "stale-created-session", companyId: "original-company" } }));
      await settle();
      assert.equal(h.c.chatState.sessionId, null);
      assert.equal(h.node("chatInput").value, "new draft");
      assert.equal(h.requests.length, 2, "no chat/paper POST after cancellation");
      assert.equal(h.storage.length, 0, "stale session not persisted");
    });
  }
  test(`${sender}: a newly created session continues the same spoken turn to the chat POST`, async () => {
    const h = speechHarness({ realSend: true }); h.c.chatState.sessionId = null;
    h.start(sender).resolve(response()); await settle();
    h.requests[1].resolve(response({ session: { id: "created-session", companyId: "original-company" } }));
    await settle(); const chat = h.requests[2]; assert.equal(chat.url, "/chat");
    const body = JSON.parse(chat.init.body);
    assert.equal(body.jobId, "original/job"); assert.equal(body.sessionId, "created-session");
    assert.equal(body.message, "spoken words"); assert.equal(h.c.voice.speechRequest, null);
    chat.resolve(response({ ok: true, reply: "done" })); await settle();
    assert.equal(h.c.voice.sending, false);
  });
}

test("typed Send still accepts its DOM event without requiring a speech token", async () => {
  const h = speechHarness({ realSend: true }); h.c.voice.mic = false;
  h.node("chatInput").value = "typed words";
  const task = h.c.sendChatMessage({ type: "click" }); await settle();
  assert.equal(h.requests[0].url, "/chat");
  assert.equal(JSON.parse(h.requests[0].init.body).message, "typed words");
  h.requests[0].resolve(response({ ok: true, reply: "done" })); await task;
});
test("speech 'read this' handoff cannot submit a paper after Stop during session creation", async () => {
  const h = speechHarness({ realSend: true }); h.c.chatState.sessionId = null;
  h.start().resolve(response({ ok: true, text: "read this: original paper words" })); await settle();
  assert.equal(h.requests[1].url, "/sessions"); h.stop(); h.openJob("new-job");
  h.node("chatInput").value = "keep this";
  h.requests[1].resolve(response({ session: { id: "old-session" } })); await settle();
  assert.equal(h.requests.length, 2); assert.equal(h.c.chatState.sessionId, null);
  assert.equal(h.node("chatInput").value, "keep this"); assert.equal(h.c.paperBusy, false);
});
test("uncanceled speech 'read this' continues to the original paper POST", async () => {
  const h = speechHarness({ realSend: true }); h.c.chatState.sessionId = null;
  h.start().resolve(response({ ok: true, text: "read this: paper words" })); await settle();
  h.requests[1].resolve(response({ session: { id: "created-session" } })); await settle();
  assert.equal(h.requests[2].url, "/api/buzzy/papers");
  const body = JSON.parse(h.requests[2].init.body);
  assert.equal(body.jobId, "original/job"); assert.equal(body.sessionId, "created-session");
  assert.equal(body.text, "paper words"); assert.equal(h.c.voice.speechRequest, null);
  h.requests[2].resolve(response({ paper: {}, reply: "done" })); await settle();
  assert.equal(h.c.paperBusy, false);
});

function stream() {
  const tracks = [0, 1].map(() => ({ stops: 0, stop() { this.stops++; } }));
  return { tracks, getTracks: () => tracks };
}
function probeHarness({ on = true, mic = true, syncError = false } = {}) {
  const requests = [], rings = [];
  const c = { PROBE_ON: on, voice: { mic, probeStream: null, probeAcquiring: null, probeGaveUp: false },
    navigator: { mediaDevices: { getUserMedia(options) {
      if (syncError) throw new Error("sync failure");
      const request = deferred(); requests.push({ ...request, options }); return request.promise;
    } } },
    probeRingStart() { rings.push(c.voice.probeStream); }, probeRingStop() {}, aecSettings: () => ({ ec: false }),
  };
  runInNewContext(["probeStart", "probeStop"].map(fn).join("\n"), c);
  return { c, requests, rings };
}
test("probe is opt-in, Listen-only, and absent getUserMedia is harmless", () => {
  for (const options of [{ on: false }, { mic: false }]) {
    const h = probeHarness(options); h.c.probeStart(); assert.equal(h.requests.length, 0);
  }
  const h = probeHarness(); h.c.navigator.mediaDevices = null; h.c.probeStart(); assert.equal(h.requests.length, 0);
});
test("multiple pending probe starts share one acquisition and Stop releases every track", async () => {
  const h = probeHarness(); h.c.probeStart(); h.c.probeStart(); h.c.probeStart();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].options)), {
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const s = stream(); h.requests[0].resolve(s); await settle();
  assert.equal(h.c.voice.probeStream, s); assert.equal(h.c.voice.probeAcquiring, null);
  h.c.probeStart(); assert.equal(h.requests.length, 1);
  h.c.voice.mic = false; h.c.probeStop(); h.c.probeStop();
  assert.deepEqual(s.tracks.map((t) => t.stops), [1, 1]); assert.equal(h.c.voice.probeStream, null);
});
test("probe Stop before permission resolves releases the late stream without starting a ring", async () => {
  const h = probeHarness(); h.c.probeStart(); h.c.voice.mic = false; h.c.probeStop();
  const s = stream(); h.requests[0].resolve(s); await settle();
  assert.deepEqual(s.tracks.map((t) => t.stops), [1, 1]); assert.equal(h.rings.length, 0);
  assert.equal(h.c.voice.probeStream, null); assert.equal(h.c.voice.probeAcquiring, null);
});
test("probe rapid off/on releases obsolete streams in either resolution order", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const h = probeHarness(); h.c.probeStart(); h.c.probeStop(); h.c.probeStart(); h.c.probeStart();
    assert.equal(h.requests.length, 2); const streams = [stream(), stream()];
    for (const index of order) { h.requests[index].resolve(streams[index]); await settle(); }
    assert.equal(h.c.voice.probeStream, streams[1]); assert.equal(h.rings.length, 1);
    assert.deepEqual(streams[0].tracks.map((t) => t.stops), [1, 1]);
    assert.deepEqual(streams[1].tracks.map((t) => t.stops), [0, 0]);
    h.c.probeStop(); assert.deepEqual(streams[1].tracks.map((t) => t.stops), [1, 1]);
  }
});
test("obsolete probe rejection cannot poison a new session or clear its pending request", async () => {
  for (const newFirst of [false, true]) {
    const h = probeHarness(); h.c.probeStart(); h.c.probeStop(); h.c.probeStart();
    const token = h.c.voice.probeAcquiring; const s = stream();
    if (newFirst) { h.requests[1].resolve(s); await settle(); }
    h.requests[0].reject(new Error("obsolete denial")); await settle();
    assert.equal(h.c.voice.probeGaveUp, false); assert.equal(h.c.voice.probeErr || null, null);
    if (!newFirst) {
      assert.equal(h.c.voice.probeAcquiring, token);
      h.requests[1].resolve(s); await settle();
    }
    assert.equal(h.c.voice.probeStream, s); h.c.probeStop();
  }
});
test("current probe denial is one attempt per session, and Stop permits a fresh attempt", async () => {
  const h = probeHarness(); h.c.probeStart(); h.requests[0].reject(new Error("denied")); await settle();
  assert.equal(h.c.voice.probeAcquiring, null); assert.equal(h.c.voice.probeGaveUp, true);
  h.c.probeStart(); assert.equal(h.requests.length, 1);
  h.c.probeStop(); h.c.probeStart(); assert.equal(h.requests.length, 2);
  const s = stream(); h.requests[1].resolve(s); await settle(); h.c.probeStop();
  assert.deepEqual(s.tracks.map((t) => t.stops), [1, 1]);
});
test("synchronous probe permission failure relinquishes the acquisition token", () => {
  const h = probeHarness({ syncError: true }); assert.doesNotThrow(() => h.c.probeStart());
  assert.equal(h.c.voice.probeAcquiring, null); assert.equal(h.c.voice.probeGaveUp, true);
  h.c.probeStop(); assert.equal(h.c.voice.probeGaveUp, false);
});


test("successful recognized submission clears a prior cancellation note", async () => {
  const h = speechHarness(); h.c.voice.note = "Pending speech discarded";
  h.start("sendHeardTurn").resolve(response()); await settle();
  assert.equal(h.c.voice.note, "");
  assert.match(h.node("voiceStatus").textContent, /^Listening/);
});
test("terminal speech paper commands release ownership and busy state without posting", async () => {
  for (const reason of ["empty", "no-company", "paper-busy"]) {
    const h = speechHarness({ realSend: true });
    if (reason === "no-company") h.c.chatState.boundCompanyId = null;
    if (reason === "paper-busy") h.c.paperBusy = true;
    h.start().resolve(response({ ok: true, text: reason === "empty" ? "read this" : "read this: words" }));
    await settle();
    assert.equal(h.requests.length, 1); assert.equal(h.c.voice.speechRequest, null);
    assert.equal(h.c.voice.sending, false); assert.equal(h.timers.at(-1), "rearm");
  }
});
