import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Production handlers, FileReader completion, and submitPaper; only browser UI,
// a synthetic file, and the network transport are replaced.
const html = readFileSync(new URL("../public/buzzy/talk.html", import.meta.url), "utf8");
function cut(a, b) {
  const start = html.indexOf(a), end = html.indexOf(b, start + 1);
  assert.ok(start >= 0 && end > start, a);
  return html.slice(start, end);
}
const code = [
  cut("    function bytesToBase64(", "    function readThisBody("),
  cut("    function ensureChatSession(", "    // The composer's"),
  cut('    document.getElementById("paperRead").onclick', '    document.getElementById("paperToggle").onclick'),
  "return { setEpoch(value) { chatEpoch = value; } };",
].join("\n");

function fixture() {
  let company = "co_fixture_original";
  const state = { sessionId: "sess_" + "a".repeat(20), jobId: "job_fixture_original", messages: [], paper: null };
  const elements = new Map();
  for (const id of ["paperRead", "paperNote", "paperFile", "paperPaste", "talkBar", "chatInput", "paperDrop"]) {
    const handlers = new Map();
    elements.set(id, {
      handlers, value: "", files: [], textContent: "",
      classList: { add() {}, remove() {} },
      addEventListener(name, callback) { handlers.set(name, [...(handlers.get(name) || []), callback]); },
    });
  }
  const requests = [], pending = [], media = [];
  class FileReader {
    readAsText(file) { pending.push({ reader: this, file }); }
    readAsArrayBuffer(file) { pending.push({ reader: this, file }); }
  }
  const document = { getElementById(id) { return elements.get(id); } };
  const window = { addEventListener() {}, location: { href: "/buzzy/talk" } };
  const fetch = async (url, init) => {
    assert.equal(url, "/api/buzzy/papers", "no real connection or unrelated session/asset request");
    const input = JSON.parse(init.body);
    requests.push(input);
    return { ok: true, status: 200, json: async () => ({ ok: true, paper: { id: "paper_fixture", jobId: input.jobId }, reply: "Fixture only" }) };
  };
  const instantiate = new Function("document", "window", "HTMLTextAreaElement", "FileReader", "chatState",
    "activeCompanyId", "fetch", "renderChatMessages", "renderPaper", "bzJobUrl", "paperBusy", "paperLoad", "chatEpoch", "submitMedia", code);
  const controller = instantiate(document, window, class {}, FileReader, state, () => company, fetch,
    () => {}, paper => { state.paper = paper; }, () => {}, false, 0, 0,
    file => { media.push(file); });

  function trigger(kind, file) {
    if (kind === "picker") {
      elements.get("paperFile").files = [file];
      elements.get("paperRead").onclick();
    } else {
      const event = { preventDefault() {}, dataTransfer: { files: [file] } };
      for (const handler of elements.get(kind).handlers.get("drop")) handler(event);
    }
  }
  return { company(v) { company = v; }, controller, pending, requests, media, state, trigger, elements };
}
const afterCallbacks = () => new Promise(resolve => setImmediate(resolve));
const sample = new File(["Fixture only, not a real document."], "fixture.txt", { type: "text/plain" });

for (const [control, scope] of [["picker", "company"], ["paperDrop", "job"], ["talkBar", "conversation"]]) {
  test(control + " does not send a file from the previous " + scope, async () => {
    const x = fixture();
    x.trigger(control, sample);
    const [{ reader, file }] = x.pending;
    assert.equal(file, sample);
    assert.equal(x.requests.length, 0, "waits for the asynchronous local read");
    if (scope === "company") x.company("co_fixture_newer");
    if (scope === "job") x.state.jobId = "job_fixture_newer";
    if (scope === "conversation") x.state.sessionId = "sess_" + "b".repeat(20);
    const newerPaper = { id: "paper_newer" };
    x.state.paper = newerPaper;
    x.state.messages = [{ role: "user", content: "Newer conversation only" }];
    x.elements.get("paperNote").textContent = "Newer note";
    reader.result = "Fixture only, not a real document.";
    reader.onload();
    await afterCallbacks();
    assert.deepEqual(x.requests, []);
    assert.equal(x.state.paper, newerPaper);
    assert.equal(x.state.messages.length, 1);
    assert.equal(x.elements.get("paperNote").textContent, "Newer note");

    // An explicit new selection still follows the now-current scope.
    x.trigger(control, sample);
    const newReader = x.pending.at(-1).reader;
    newReader.result = "Fresh fixture selection";
    newReader.onload();
    await afterCallbacks();
    assert.equal(x.requests.length, 1);
    assert.equal(x.requests[0].companyId, scope === "company" ? "co_fixture_newer" : "co_fixture_original");
    assert.equal(x.requests[0].jobId, x.state.jobId);
    assert.equal(x.requests[0].sessionId, x.state.sessionId);
    assert.equal(x.requests[0].text, "Fresh fixture selection");
  });
}

test("a retired FileReader error does not change the current note or conversation", async () => {
  for (const control of ["picker", "paperDrop", "talkBar"]) {
    const x = fixture();
    x.trigger(control, sample);
    x.controller.setEpoch(1); // a navigation away and back can keep the same ids
    x.elements.get("paperNote").textContent = "Newer note";
    x.pending[0].reader.onerror();
    await afterCallbacks();
    assert.deepEqual(x.requests, []);
    assert.deepEqual(x.state.messages, []);
    assert.equal(x.elements.get("paperNote").textContent, "Newer note");
  }
});

test("a current read failure remains visible and pasted paper still submits immediately", async () => {
  const x = fixture();
  x.trigger("picker", sample);
  x.pending[0].reader.onerror();
  await afterCallbacks();
  assert.equal(x.elements.get("paperNote").textContent, "Couldn't read that file.");
  x.elements.get("paperFile").files = [];
  x.elements.get("paperPaste").value = "Synthetic paste only.";
  x.elements.get("paperRead").onclick();
  await afterCallbacks();
  assert.equal(x.pending.length, 1, "pasted text never opens a FileReader");
  assert.equal(x.requests.length, 1);
  assert.equal(x.requests[0].fileKind, "paste");
  assert.equal(x.requests[0].text, "Synthetic paste only.");
});

test("a current PDF and media use their existing separate intake paths", async () => {
  const x = fixture();
  const bytes = Uint8Array.of(0x25, 0x50, 0x44, 0x46);
  const file = new File([bytes], "fixture.pdf", { type: "application/pdf" });
  x.trigger("talkBar", file);
  assert.equal(x.pending.length, 1);
  x.pending[0].reader.result = bytes.buffer;
  x.pending[0].reader.onload();
  await afterCallbacks();
  assert.equal(x.requests.length, 1);
  assert.equal(x.requests[0].fileKind, "pdf");
  assert.equal(x.requests[0].dataBase64, "JVBERg==");
  const photo = new File(["fixture media"], "fixture.png", { type: "image/png" });
  x.trigger("paperDrop", photo);
  await afterCallbacks();
  assert.deepEqual(x.media, [photo]);
  assert.equal(x.requests.length, 1, "media has not been sent to the paper endpoint");
  assert.equal(x.pending.length, 1, "media bypasses the paper FileReader");
});
