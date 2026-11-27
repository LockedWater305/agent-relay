// Portable Settings Feedback contract. Actual inline source, minimal DOM/event
// doubles; no Electron, external packages, OS clipboard or network.
// Run: node --test scripts/test-desktop-feedback.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { pageScripts, shellInlineBatches } from "./build-desktop-csp.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const settings = read("../public/buzzy/settings.html");
const nav = read("../public/buzzy/nav.js");
const scripts = pageScripts(settings, "Settings Feedback test");
const bodies = scripts.filter((script) => script.textContent.includes('const mount = $("feedback-mount")'));
assert.equal(bodies.length, 1, "exercise the shipped Settings Feedback block");
const inline = bodies[0].textContent;
const start = inline.indexOf("      const appBridge = window.beezilla?.app;");
const end = inline.indexOf("      if (appBridge?.logs) {", start);
assert.ok(start >= 0 && end > start);
const feedback = inline.slice(start, end);
const runFeedback = new vm.Script(feedback, { filename: "settings.html:Feedback" });
const local = "http://127.0.0.1:7331/buzzy/settings";

function fixture({ href = local, preload = true, subframe = false } = {}) {
  class Element extends EventTarget {
    constructor(id) { super(); this.id = id; }
    value = "";
    textContent = "";
    selectionStart = 0;
    selectionEnd = 0;
    click() { this.dispatchEvent(new Event("click")); }
    focus() { document.activeElement = this; }
    select() {
      if (this.refuseSelection) throw new Error("fixture: native text selection unavailable");
      if (!this.ignoreSelection) { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    }
  }
  const mount = new Element("feedback-mount");
  const nodes = new Map([[mount.id, mount]]);
  const effects = [];
  const unexpected = (name) => (...args) => {
    effects.push(name);
    throw new Error("Unexpected Feedback effect: " + name);
  };
  const document = { execCommand: unexpected("legacy clipboard") };
  mount.insertAdjacentHTML = (where, html) => {
    assert.equal(where, "afterend");
    assert.match(html, /<section id="feedback-panel"[^>]*data-bz-before-remove>/);
    assert.match(html, /<label for="feedback-draft">/);
    assert.match(html, /<textarea id="feedback-draft"[^>]*autocomplete="off"[^>]*spellcheck="false"/);
    assert.match(html, /id="feedback-status" role="status"/);
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
      assert.ok(!nodes.has(match[1]));
      nodes.set(match[1], new Element(match[1]));
    }
    assert.doesNotMatch(html, /<script\b|\bon\w+=/i);
  };
  mount.remove = () => nodes.delete(mount.id);
  const events = new EventTarget();
  const window = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  window.top = subframe ? {} : window;
  if (preload) window.beezilla = { app: {
    version: unexpected("version IPC"), logs: unexpected("logs IPC"),
    log: unexpected("diagnostic IPC"), openLogs: unexpected("native logs IPC"),
  } };
  const location = new URL(href);
  const originalHref = location.href;
  const blocked = (name) => new Proxy({}, { get: unexpected(name + " read"), set: unexpected(name + " write") });
  const context = {
    window, location, document, $: (id) => nodes.get(id) ?? null,
    fetch: unexpected("network"), history: blocked("history"),
    navigator: blocked("navigator"), localStorage: blocked("local storage"), sessionStorage: blocked("session storage"),
    console: blocked("log"), setTimeout: unexpected("timer"),
  };
  const run = () => runFeedback.runInNewContext(context, { timeout: 1000 });
  return { nodes, window, document, run, assertPrivate() {
    assert.deepEqual(effects, []);
    assert.equal(location.href, originalHref);
  } };
}

test("Feedback still passes the shipped initial HTML and shell script CSP tokenizer", async () => {
  assert.equal(bodies[0].inBody, true);
  const batches = await shellInlineBatches(nav, scripts);
  assert.equal(batches.filter((chunk) => chunk.includes(feedback)).length, 1);
  assert.match(nav, /querySelectorAll\("\[data-bz-before-remove\]"\)[\s\S]{0,150}new Event\("bz:before-remove"\)/);
  assert.match(settings, /<div id="feedback-mount" hidden><\/div>/);
  assert.doesNotMatch(settings.replace(inline, ""), /id="feedback-draft"/, "the shared HTML has no live report field");
});

for (const [name, options] of [
  ["no app preload", { preload: false }],
  ["wrong local path", { href: "http://127.0.0.1:7331/buzzy/talk" }],
  ["unbound bare loopback", { href: "http://127.0.0.1/buzzy/settings" }],
  ["hosted site even with a lookalike bridge", { href: "https://example.invalid/buzzy/settings" }],
  ["subframe with a lookalike bridge", { subframe: true }],
]) test("Feedback remains unmounted with " + name, () => {
  const f = fixture(options);
  f.run();
  assert.deepEqual([...f.nodes.keys()], ["feedback-mount"]);
  f.assertPrivate();
});

test("Settings Feedback selects only literal typed text and never claims to copy", () => {
  const f = fixture({ href: local + ".html" }); f.run();
  const [draft, select, status] = ["draft", "select", "status"].map((key) => f.nodes.get("feedback-" + key));
  assert.ok(draft && select && status);
  draft.value = "   "; select.click();
  assert.match(status.textContent, /write something/i);
  const exact = '  Literal <img src=x> & "quotes"\nSame typed text.  ';
  draft.value = exact; draft.dispatchEvent(new Event("input"));
  assert.equal(status.textContent, "");
  select.click();
  assert.equal(f.document.activeElement, draft);
  assert.equal(draft.value.slice(draft.selectionStart, draft.selectionEnd), exact);
  assert.match(status.textContent, /^Text selected\..*Copy.*Nothing was sent\.$/);
  assert.doesNotMatch(status.textContent, /copied|copy complete/i);

  for (const option of ["refuseSelection", "ignoreSelection"]) {
    draft.selectionStart = draft.selectionEnd = 0;
    draft[option] = true; select.click(); draft[option] = false;
    assert.match(status.textContent, /could not select.*manually.*nothing was sent/i);
    assert.equal(draft.value, exact, "manual copy retains the typed draft");
  }
  f.assertPrivate();
});

test("Clear, pagehide, and owned shell removal erase; removing retires the listener", () => {
  const f = fixture(); f.run();
  const [draft, clear, panel, status] = ["draft", "clear", "panel", "status"].map((key) => f.nodes.get("feedback-" + key));
  draft.value = "manual clear"; clear.click();
  assert.equal(draft.value, "");
  assert.match(status.textContent, /^Draft cleared\. Nothing was sent\.$/);
  assert.equal(f.document.activeElement, draft);
  draft.value = "visible before pagehide";
  const pagehide = Object.assign(new Event("pagehide"), { persisted: true });
  f.window.dispatchEvent(pagehide);
  assert.deepEqual([draft.value, status.textContent], ["", ""]);
  f.window.dispatchEvent(new Event("pageshow"));
  assert.equal(draft.value, "", "showing again cannot revive the draft");
  draft.value = "visible before shell teardown";
  panel.dispatchEvent(new Event("bz:before-remove"));
  assert.deepEqual([draft.value, status.textContent], ["", ""]);
  draft.value = "retired fixture only";
  f.window.dispatchEvent(pagehide);
  assert.equal(draft.value, "retired fixture only", "closed owner's pagehide callback was detached");
  f.assertPrivate();
});
