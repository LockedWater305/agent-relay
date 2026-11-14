#!/usr/bin/env node
/**
 * Dependency-free checks of the shipped Talk speech fallback and capture lifecycle.
 * Run: node --test scripts/test-talk-speech-fallback.mjs
 * Optional: TALK_CANDIDATE=/absolute/path/to/talk.html to test another candidate.
 * Executes the actual extracted handlers, not a rewritten speech state machine.
 * Browser/device/provider/real Electron testing is deliberately not claimed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext, Script } from "node:vm";
import test from "node:test";

const candidate = readFileSync(process.env.TALK_CANDIDATE ||
  new URL("../public/buzzy/talk.html", import.meta.url), "utf8");

function fn(name, source = candidate) {
  const match = source.match(new RegExp(`^    function ${name}\\([^]*?^    \\}`, "m"));
  assert.ok(match, `function ${name} exists`);
  return match[0];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function result(text = "recognizer words") {
  const entry = [{ transcript: text }];
  entry.isFinal = true;
  return { resultIndex: 0, results: [entry] };
}

function stream() {
  const track = { readyState: "live", stopped: 0, stop() { this.stopped++; this.readyState = "ended"; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

function harness(options = {}) {
  const log = { recs: [], recorderStarts: 0, clips: [], fetches: [], submissions: [], timers: [], notes: [],
    micRequests: [], preRollStarts: 0, probeStarts: 0, preRollStops: 0, probeStops: 0, nodes: [] };
  const input = { value: "" };
  let now = 100;
  class SR {
    constructor() { this.stops = 0; this.starts = 0; log.recs.push(this); }
    start() { this.starts++; if (options.throwStart) throw new Error("cannot start"); }
    stop() { this.stops++; if (options.syncEnd && this.onend) this.onend(); }
    abort() { this.stop(); }
  }
  function node() {
    const n = { connects: 0, disconnects: 0, connect() { this.connects++; }, disconnect() { this.disconnects++; } };
    log.nodes.push(n);
    return n;
  }
  class AudioContext {
    constructor() { this.state = "running"; this.sampleRate = 1000; this.destination = {}; }
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { return node(); }
    resume() { this.state = "running"; }
    close() { this.state = "closed"; }
  }
  const c = {
    voice: { mic: true, rec: null, speaking: false, sending: false, asr: "sr", textClaim: false,
      bargeClip: false, bargeSent: false, firstInterimAt: 0, lastPreRollSamples: 0,
      micStream: null, micCtx: null, preRoll: null, probeStream: null, probeCtx: null },
    recState: null, recAcquiring: null, capState: null, CAP_MAX_MS: 25000,
    Float32Array, Promise, Math, Date, performance: { now: () => ++now },
    window: { SpeechRecognition: SR, AudioContext, ...(options.desktop ? { beezilla: {} } : {}) },
    navigator: { mediaDevices: { getUserMedia() { const request = deferred(); log.micRequests.push(request); return request.promise; } } },
    document: { getElementById: () => input }, chatState: { jobId: "job/one", jobContext: { title: "Honey Crumb" } },
    srAvailable: () => !options.noSR,
    startRecording() { log.recorderStarts++; c.recState = {}; },
    cancelRecording() { c.recAcquiring = null; c.recState = null; },
    startCapture() { c.capState = capture(); },
    preRollStart() { log.preRollStarts++; }, probeStart() { log.probeStarts++; },
    preRollStop() { log.preRollStops++; }, probeStop() { log.probeStops++; },
    preRollPending: () => null, bargeDisarm() {}, aecSettings: () => ({}),
    polishSamples: (samples) => ({ samples }), setLastTurn() {},
    downsampleTo16k: (samples) => samples, encodeWav: (samples) => ({ wav: true, samples: samples.length }),
    brandName: (s) => s, jobNameFix: (s) => s,
    sendForTranscription(wav) { log.clips.push(wav); c.voice.sending = true; },
    sendChatMessage() { log.submissions.push(input.value); },
    setAvatarState() {}, paintVoice() {}, saveListenPref() {},
    stageNote: (note) => log.notes.push(note), rearmListening() {},
    setTimeout: (callback) => { log.timers.push(callback); return log.timers.length; },
    fetch: (url, init) => {
      log.fetches.push({ url, init });
      if (options.fetchReject) return Promise.reject(new Error("transcriber unavailable"));
      return Promise.resolve({ ok: !options.fetchError, json: async () => ({ ok: true, text: "server words" }) });
    },
  };
  function capture({ speech = true, samples = 500 } = {}) {
    return { src: node(), proc: node(), chunks: [new Float32Array(samples).fill(0.05)],
      rate: 1000, speechSeen: speech, quietSince: 0 };
  }
  const names = ["startListening", "stopListening", "clipHasSpeech", "sendTurnClip", "finishCapture", "dropCapture",
    "sendHeardTurn", "submitHeard", "asrQueryString", "releaseMic",
    "invalidateSpeechRequest", "beginSpeechRequest", "speechRequestCurrent"];
  if (options.realCapture) names.push("startCapture", "ensureMic");
  runInNewContext(names.map((name) => fn(name)).join("\n\n"), c, { filename: "talk-extracted-voice.js" });
  return { c, log, input, capture, start() { c.startListening(); return c.voice.rec; } };
}

test("shipped inline scripts compile without conflict markers", () => {
  assert.doesNotMatch(candidate, /^(?:<<<<<<<|=======|>>>>>>>)/m);
  const scripts = [...candidate.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((m) => !/\bsrc\s*=/.test(m[1]));
  assert.ok(scripts.length >= 1);
  for (const [i, script] of scripts.entries()) new Script(script[2], { filename: `talk:script-${i}` });
});

test("speech diagnostics remain available without ambient third-party memory sync", () => {
  assert.doesNotMatch(candidate, /(?:api\.honcho\.dev|honchoGetContext|honchoSyncExchange|honchoCreatePeer)/);
  assert.match(candidate, /No ambient third-party memory sync/);
  assert.match(candidate, /capture: \{ speechSeen: !!\(capState && capState\.speechSeen\), kept: clipHasSpeech\(\) \}/);
  for (const name of ["micLog", "preRollTake", "bargeFire", "probeStart", "probeStop", "polishSamples"]) fn(name);
});

test("current desktop guard blocks inactive/busy/duplicate starts without resetting per-window claims", () => {
  for (const change of [{ mic: false }, { speaking: true }, { sending: true }, { rec: {} }, { recState: {} }, { recAcquiring: {} }]) {
    const h = harness();
    Object.assign(h.c.voice, { bargeSent: true, textClaim: true });
    for (const [key, value] of Object.entries(change)) {
      if (key === "recState" || key === "recAcquiring") h.c[key] = value;
      else h.c.voice[key] = value;
    }
    h.start();
    assert.equal(h.log.recs.length, 0, JSON.stringify(change));
    assert.equal(h.log.recorderStarts, 0);
    assert.equal(h.c.voice.bargeSent, true);
    assert.equal(h.c.voice.textClaim, true);
  }
});

test("desktop and unavailable SR select recorder and never instantiate the recognizer", () => {
  for (const options of [{ desktop: true }, { noSR: true }]) {
    const h = harness(options);
    h.start();
    assert.equal(h.log.recorderStarts, 1);
    assert.equal(h.log.recs.length, 0);
  }
  const h = harness(); h.c.voice.asr = "recorder"; h.start();
  assert.equal(h.log.recorderStarts, 1);
  assert.equal(h.log.recs.length, 0);
});

test("ordinary measured speech survives no-speech and posts exactly once on end", () => {
  const h = harness(); const rec = h.start(); const capture = h.c.capState;
  assert.equal(h.c.voice.bargeClip, false);
  rec.onerror({ error: "no-speech" });
  assert.equal(h.c.capState, capture);
  rec.onend(); rec.onend();
  assert.equal(h.log.clips.length, 1);
  assert.equal(h.c.capState, null);
  assert.equal(h.c.voice.bargeSent, true);
  assert.equal(h.log.timers.length, 0);
});

test("ordinary measured speech survives a clean end with no final result", () => {
  const h = harness(); const rec = h.start(); rec.onend();
  assert.equal(h.log.clips.length, 1);
});

test("barge-gate evidence still keeps the turn even before capture has measured a new voiced frame", () => {
  const h = harness(); const rec = h.start();
  h.c.capState.speechSeen = false; h.c.voice.bargeClip = true;
  rec.onerror({ error: "no-speech" }); rec.onend();
  assert.equal(h.log.clips.length, 1);
  assert.equal(h.c.voice.bargeClip, false);
});

test("actual capture callback distinguishes voiced frames from silence before SR failure", async () => {
  for (const [level, expected] of [[0.03, 1], [0.01, 0]]) {
    const h = harness({ realCapture: true }); const rec = h.start();
    h.log.micRequests[0].resolve(stream()); await settle();
    h.c.capState.proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(500).fill(level) } });
    assert.equal(h.c.capState.speechSeen, expected === 1);
    rec.onerror({ error: "no-speech" }); rec.onend();
    assert.equal(h.log.clips.length, expected);
  }
});

test("actual barge silence endpoint posts through the renamed fallback once", async () => {
  const h = harness({ realCapture: true }); let now = 1000;
  h.c.Date = { now: () => now };
  const rec = h.start(); h.log.micRequests[0].resolve(stream()); await settle();
  const proc = h.c.capState.proc;
  const frame = (level) => proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(500).fill(level) } });
  h.c.voice.bargeClip = true;
  frame(0.03); now = 1500; frame(0); now = 2801; frame(0);
  assert.equal(h.log.clips.length, 1);
  rec.onend(); rec.onresult(result()); frame(0);
  assert.equal(h.log.clips.length, 1);
  assert.equal(h.log.submissions.length, 0);
});

test("silent and too-short windows do not post and re-arm once", () => {
  for (const props of [{ speech: false }, { speech: true, samples: 100 }]) {
    const h = harness(); const rec = h.start(); h.c.capState = h.capture(props);
    rec.onerror({ error: "no-speech" }); rec.onend(); rec.onend();
    assert.equal(h.log.clips.length, 0);
    assert.equal(h.log.fetches.length, 0);
    assert.equal(h.log.timers.length, 1);
  }
});

test("permission denial does not post captured speech or leave the mic stream alive", () => {
  const h = harness(); const rec = h.start(); const s = stream(); h.c.voice.micStream = s;
  rec.onerror({ error: "not-allowed" }); rec.onend();
  assert.equal(h.c.voice.mic, false);
  assert.equal(h.log.clips.length, 0);
  assert.equal(h.c.capState, null);
  assert.equal(h.log.timers.length, 0);
  assert.equal(s.track.stopped, 1);
  assert.equal(h.c.voice.micStream, null);
});

for (const error of ["network", "service-not-allowed"]) {
  test(`${error} keeps ordinary speech and switches the next turn to recorder without opening one over the clip`, () => {
    const h = harness({ syncEnd: true }); const rec = h.start();
    rec.onerror({ error }); rec.onend();
    assert.equal(h.log.clips.length, 1);
    assert.equal(h.log.recorderStarts, 0);
    assert.equal(h.c.voice.asr, "recorder");
    assert.equal(h.log.timers.length, 0);
    h.c.voice.sending = false; h.start();
    assert.equal(h.log.recorderStarts, 1);
  });
  test(`${error} without speech starts recorder once and stale callbacks are inert`, () => {
    const h = harness({ syncEnd: true }); const rec = h.start(); h.c.capState.speechSeen = false;
    rec.onerror({ error }); rec.onend(); rec.onerror({ error }); rec.onresult(result());
    assert.equal(h.log.clips.length, 0);
    assert.equal(h.log.recorderStarts, 1);
    assert.equal(h.log.submissions.length, 0);
    assert.equal(h.log.timers.length, 0);
  });
}

test("per-window claims reset on the next accepted turn, so two distinct clips both post", () => {
  const h = harness(); let rec = h.start(); rec.onend();
  h.c.voice.sending = false; h.c.voice.textClaim = true;
  rec = h.start();
  assert.equal(h.c.voice.textClaim, false); assert.equal(h.c.voice.bargeSent, false);
  rec.onend();
  assert.equal(h.log.clips.length, 2);
});

test("a clip fallback makes a queued final transcript inert rather than submitting the same turn twice", async () => {
  const h = harness(); const rec = h.start();
  assert.equal(h.c.sendTurnClip(), true);
  rec.onresult(result()); rec.onerror({ error: "network" }); rec.onend();
  await settle();
  assert.equal(h.log.clips.length, 1);
  assert.equal(h.log.fetches.length, 0);
  assert.equal(h.log.submissions.length, 0);
});

test("a recognizer that naturally ended cannot later submit a queued final", async () => {
  const h = harness(); const rec = h.start(); rec.onend(); rec.onresult(result());
  await settle();
  assert.equal(h.log.clips.length, 1);
  assert.equal(h.log.submissions.length, 0);
});

test("late callbacks from an older recognizer cannot stop, clear or steal a newer capture", async () => {
  const h = harness(); const old = h.start();
  h.c.stopListening();
  const fresh = h.start(); const capture = h.c.capState;
  old.onresult(result("old words")); old.onerror({ error: "network" }); old.onend();
  await settle();
  assert.equal(h.c.voice.rec, fresh);
  assert.equal(h.c.capState, capture);
  assert.equal(fresh.stops, 0);
  assert.equal(h.c.voice.asr, "sr");
  assert.equal(h.log.submissions.length, 0);
  assert.equal(h.log.clips.length, 0);
});

test("a final transcript keeps its audio across synchronous stop/end and submits one transcribed turn", async () => {
  const h = harness({ syncEnd: true }); const rec = h.start(); const capture = h.c.capState;
  rec.onresult(result()); rec.onresult(result()); rec.onend();
  await settle();
  assert.equal(h.log.clips.length, 0);
  assert.equal(h.log.fetches.length, 1);
  assert.equal(h.log.fetches[0].init.body.wav, true);
  assert.equal(h.log.fetches[0].url, "/api/buzzy/transcribe?jobId=job%2Fone&vocab=Honey%20Crumb");
  assert.deepEqual(h.log.submissions, ["server words"]);
  assert.equal(capture.proc.disconnects, 1);
});

test("a recognized turn still falls back to SR text when the transcriber fails", async () => {
  for (const options of [{ fetchReject: true }, { fetchError: true }]) {
    const h = harness(options); const rec = h.start(); rec.onresult(result("fallback words"));
    await settle();
    assert.deepEqual(h.log.submissions, ["fallback words"]);
    assert.equal(h.log.clips.length, 0);
  }
});

test("recognizer start failure selects recorder and any subsequent old callback is inert", async () => {
  const h = harness({ throwStart: true }); h.start(); const rec = h.log.recs[0];
  rec.onresult(result()); rec.onerror({ error: "network" }); rec.onend(); await settle();
  assert.equal(h.log.recorderStarts, 1);
  assert.equal(h.log.submissions.length, 0);
  assert.equal(h.log.fetches.length, 0);
});

test("Listen off makes queued recognizer results inert", async () => {
  const h = harness(); const rec = h.start(); h.c.voice.mic = false;
  h.c.stopListening(); h.c.releaseMic(); rec.onresult(result()); rec.onend(); await settle();
  assert.equal(h.log.fetches.length, 0);
  assert.equal(h.log.submissions.length, 0);
  assert.equal(h.log.clips.length, 0);
});

test("pending browser microphone acquisition after Listen off is stopped, not installed", async () => {
  const h = harness({ realCapture: true }); h.start();
  assert.equal(h.log.micRequests.length, 1);
  h.c.voice.mic = false; h.c.stopListening(); h.c.releaseMic();
  const s = stream(); h.log.micRequests[0].resolve(s); await settle();
  assert.equal(s.track.stopped, 1);
  assert.equal(h.c.voice.micStream, null);
  assert.equal(h.c.capState, null);
  assert.equal(h.log.preRollStarts, 0);
  assert.equal(h.log.probeStarts, 0);
});

test("late old capture setup cannot attach to a newer recognizer", async () => {
  const h = harness({ realCapture: true }); const old = h.start();
  h.c.stopListening(); const fresh = h.start();
  const a = stream(); const b = stream();
  h.log.micRequests[0].resolve(a); await settle();
  assert.equal(h.c.voice.rec, fresh);
  assert.equal(h.c.capState, null, "old promise must not create the new recognizer's capture");
  h.log.micRequests[1].resolve(b); await settle();
  assert.ok(h.c.capState);
  assert.equal(h.c.voice.rec, fresh);
  assert.equal(b.track.stopped, 1, "session reuse stops the redundant newly resolved stream");
  assert.equal(a.track.stopped, 0, "session retains its one live mic until Listen off");
  old.onend(); assert.ok(h.c.capState);
  h.c.voice.mic = false; h.c.stopListening(); h.c.releaseMic();
  assert.equal(a.track.stopped, 1);
});

test("browser on/off/on resolution orders retain one live stream and Stop releases all streams", async () => {
  for (const order of [[0, 1], [1, 0]]) {
    const h = harness({ realCapture: true }); h.start();
    h.c.voice.mic = false; h.c.stopListening(); h.c.releaseMic();
    h.c.voice.mic = true; const fresh = h.start();
    const streams = [stream(), stream()];
    for (const index of order) { h.log.micRequests[index].resolve(streams[index]); await settle(); }
    assert.equal(h.c.voice.rec, fresh);
    assert.ok(h.c.capState);
    assert.equal(streams.filter((s) => s.track.readyState === "live").length, 1);
    h.c.voice.mic = false; h.c.stopListening(); h.c.releaseMic();
    assert.equal(streams.filter((s) => s.track.readyState === "live").length, 0);
    assert.equal(h.c.voice.micStream, null); assert.equal(h.c.capState, null);
  }
});


test("a newly accepted recognition window clears an obsolete status note", () => {
  const h = harness(); h.c.voice.note = "Pending speech discarded"; h.start();
  assert.equal(h.c.voice.note, "");
});
