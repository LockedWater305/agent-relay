/** Dependency-free router tests: no browser, application server, or provider calls. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const sourcePath = process.env.BZ_NAV_SOURCE || new URL("../public/buzzy/nav.js", import.meta.url);
const source = readFileSync(sourcePath, "utf8");
const marker = "/**\n * The page shell: navigation that does not reload the document.";
assert.equal(source.split(marker).length, 2, "test the production shell, not a copied implementation");
const shellSource = source.slice(source.indexOf(marker));
const ORIGIN = "http://127.0.0.1:7331";
const TALK = "/buzzy/talk";
const LIBRARY = "/buzzy/library";
const MEMORY = "/buzzy/memory";
const titles = { [TALK]: "Chat", [LIBRARY]: "Library", [MEMORY]: "Memory" };
const librarySource = readFileSync(new URL("../public/buzzy/library.html", import.meta.url), "utf8");
const libraryRedirect = librarySource.match(/if \(window\.location\.pathname\.replace\([^\n]+\n\s+if \(window\.BeeZillaShell\) window\.BeeZillaShell\.go\("\/buzzy\/talk"\);\n\s+}/)?.[0];
assert.ok(libraryRedirect, "exercise Library's actual location-sensitive bootstrap guard");
const talkSource = readFileSync(new URL("../public/buzzy/talk.html", import.meta.url), "utf8");
const talkParamsStart = talkSource.indexOf("    var expertFromUrl =");
const talkParamsEnd = talkSource.indexOf("    // ── Form tab", talkParamsStart);
assert.ok(talkParamsStart > 0 && talkParamsEnd > talkParamsStart, "exercise Talk's actual query consumption");
const storeChatSession = talkSource.match(/^    function storeChatSession\([^]*?^    }/m)?.[0];
assert.ok(storeChatSession, "query consumption uses the actual selected-session storage helper");
const talkParams = storeChatSession + "\n" + talkSource.slice(talkParamsStart, talkParamsEnd);
const openJobStart = librarySource.indexOf("    function openJobChat(id) {");
const openJobEnd = librarySource.indexOf("    /* ── Documents:", openJobStart);
assert.ok(openJobStart > 0 && openJobEnd > openJobStart, "exercise Library's actual job continuation");
const openJobChat = librarySource.slice(openJobStart, openJobEnd);
const voiceStart = source.indexOf("    function startHere() {");
const voiceEnd = source.indexOf('    mic.addEventListener("click"', voiceStart);
assert.ok(voiceStart > 0 && voiceEnd > voiceStart, "exercise the actual voice-start continuation");
const startVoice = source.slice(voiceStart, voiceEnd);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only the DOM operations used by the shell are modeled. Fetched documents use
// fixture data, not an HTML parser; page and script state are real VM objects.
class Element {
  constructor(tag, owner) {
    this.tagName = tag.toUpperCase();
    this.owner = owner;
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.textContent = "";
    this.listeners = new Map();
  }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get src() { return this.hasAttribute("src") ? new URL(this.getAttribute("src"), ORIGIN).href : ""; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    child.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.notEqual(index, -1, "insertBefore reference must belong to its parent");
    this.children.splice(index, 0, child);
    child.parentNode = this;
    this.owner.onAppend?.(this, child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    assert.notEqual(index, -1, "removeChild must not remove another page's node");
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  cloneNode(deep) {
    const node = new Element(this.tagName, this.owner);
    for (const [name, value] of this.attrs) node.setAttribute(name, value);
    node.textContent = this.textContent;
    if (deep) for (const child of this.children) node.appendChild(child.cloneNode(true));
    return node;
  }
  matches(selector) {
    const parts = selector.trim().split(/\s+/);
    if (parts.length > 1) {
      return this.matches(parts.pop()) && Boolean(this.parentNode?.closest(parts.join(" ")));
    }
    const match = /^(\w+)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector);
    assert.ok(match, `unsupported test selector: ${selector}`);
    const [, tag, id, className, attr, value] = match;
    return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.id === id) &&
      (!className || (this.getAttribute("class") || "").split(/\s+/).includes(className)) &&
      (!attr || (value === undefined ? this.hasAttribute(attr) : this.getAttribute(attr) === value));
  }
  closest(selector) {
    if (this.matches(selector)) return this;
    return this.parentNode?.closest(selector) || null;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(",").map((s) => s.trim());
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((s) => child.matches(s))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(fn);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); }
}

function makeDocument() {
  const document = {
    listeners: new Map(),
    createElement(tag) { return new Element(tag, this); },
    querySelectorAll(selector) { return this.root.querySelectorAll(selector); },
    getElementById(id) { return this.root.querySelector(`#${id}`); },
    importNode(node, deep) {
      const result = node.cloneNode(deep);
      const adopt = (el) => { el.owner = this; el.children.forEach(adopt); };
      adopt(result);
      return result;
    },
    addEventListener: Element.prototype.addEventListener,
    dispatchEvent: Element.prototype.dispatchEvent,
  };
  document.root = document.createElement("html");
  document.head = document.root.appendChild(document.createElement("head"));
  document.body = document.root.appendChild(document.createElement("body"));
  return document;
}

function pageDocument(key, external = false) {
  const doc = makeDocument();
  doc.title = titles[key.split("?")[0]] || key;
  const style = doc.head.appendChild(doc.createElement("style"));
  style.textContent = `/* ${key} */`;
  const main = doc.body.appendChild(doc.createElement("main"));
  main.setAttribute("data-page", key);
  main.id = key.split("?")[0] === TALK ? "chat" : "content";
  if (external) {
    const script = doc.body.appendChild(doc.createElement("script"));
    script.setAttribute("src", "/fixture/external.js");
  }
  const script = doc.body.appendChild(doc.createElement("script"));
  script.textContent = (key.split("?")[0] === LIBRARY ? libraryRedirect + "\n" : "") +
    (key.split("?")[0] === TALK ? "var chatState = {};\n" + talkParams : "") +
    `window.pageRuns.push({ key: ${JSON.stringify(key)}, active: document.getElementById("bzPage").getAttribute("data-bz-path") });`;
  return doc;
}

function harness(initialKey = TALK) {
  const document = pageDocument(initialKey);
  // The hard-loaded page has already run its own scripts.
  document.body.querySelector("script").remove();
  let url = new URL(initialKey, ORIGIN);
  const entries = [{ href: url.href, state: { initial: true } }];
  let index = 0;
  const pushes = [], replacements = [], assignments = [];
  const events = new Map();
  const requests = [], heldFetches = new Set(), externalPages = new Set(), externalScripts = [];
  const boots = [], readyEvents = [];
  const location = {
    get href() { return url.href; },
    set href(value) { assignments.push(value); url = new URL(value, url); },
    get pathname() { return url.pathname; },
    get search() { return url.search; },
    get origin() { return url.origin; },
    replace(value) { replacements.push(value); url = new URL(value, url); entries[index].href = url.href; },
  };
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state, _title, value) {
      url = new URL(value, url);
      entries.splice(index + 1, entries.length, { href: url.href, state });
      index++;
      pushes.push(url.href);
    },
    replaceState(state, _title, value) {
      url = new URL(value, url);
      entries[index] = { href: url.href, state };
    },
    back() { this.go(-1); },
    forward() { this.go(1); },
    go(delta) {
      const target = index + delta;
      if (target < 0 || target >= entries.length) return;
      index = target;
      url = new URL(entries[index].href);
      for (const listener of events.get("popstate") || []) listener({ state: history.state });
    },
  };
  const context = vm.createContext({
    URL, URLSearchParams, Promise, Event, document, location, history, scrollY: 0, pageRuns: [],
    addEventListener(type, fn) {
      const listeners = events.get(type) || [];
      listeners.push(fn);
      events.set(type, listeners);
    },
    scrollTo(_x, y) { context.scrollY = y; },
    BeeZillaChrome: { boot() { boots.push(location.pathname); } },
    BeeZillaTitle: { page: document.title, setPage(title) { this.page = title; document.title = title; } },
    DOMParser: class { parseFromString(text) { const data = JSON.parse(text); return pageDocument(data.key, data.external); } },
    fetch(href, options) {
      const target = new URL(href);
      const key = target.pathname + target.search;
      const response = deferred();
      const request = {
        key, options,
        resolve() { response.resolve({ ok: true, text: async () => JSON.stringify({ key, external: externalPages.has(key) }) }); },
        fail() { response.reject(new Error("fixture network failure")); },
      };
      requests.push(request);
      if (!heldFetches.has(key)) request.resolve();
      return response.promise;
    },
  });
  context.window = context;
  document.onAppend = (parent, script) => {
    if (parent !== document.head || script.tagName !== "SCRIPT") return;
    if (script.src) externalScripts.push(script);
    else vm.runInContext(script.textContent, context, { timeout: 1000 });
  };
  document.addEventListener("DOMContentLoaded", () => {
    readyEvents.push(document.getElementById("bzPage")?.getAttribute("data-bz-path"));
  });
  vm.runInContext(shellSource, context, { filename: "nav.js:page-shell", timeout: 1000 });

  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  return {
    context, document, location, history, entries, pushes, replacements, assignments, requests,
    boots, readyEvents, heldFetches, externalPages, externalScripts, flush,
    get shell() { return context.BeeZillaShell; },
    async idle() { await flush(); assert.equal(this.shell.busy, false, "shell should settle"); },
    assertPage(key) {
      assert.equal(new URL(location.href).pathname + new URL(location.href).search, key, "address");
      assert.equal(this.shell.currentKey, key, "committed shell key");
      const active = document.getElementById("bzPage");
      assert.ok(active, "one active wrapper");
      assert.equal(active.getAttribute("data-bz-path"), key, "visible wrapper key");
      assert.equal(active.querySelector("main").getAttribute("data-page").split("?")[0], key.split("?")[0], "visible content");
      assert.equal(document.querySelectorAll("#bzPage").length, 1, "no cached duplicate active id");
      assert.equal(document.title, titles[key.split("?")[0]] || key, "title");
      for (const style of document.querySelectorAll("[data-bz-style]")) {
        assert.equal(Boolean(style.disabled), style.getAttribute("data-bz-style") !== key, "only active page CSS");
      }
      assert.deepEqual(assignments, [], "no unexpected hard-navigation assignment");
      assert.deepEqual(replacements, [], "no unexpected hard-navigation fallback");
    },
  };
}

test("two Talk/Library/Memory laps then Back/Forward keep URL, DOM, title, and cache aligned", async () => {
  const h = harness();
  const chat = h.document.getElementById("chat");
  const session = { draft: "keep this unfinished sentence", mic: true };
  chat.session = session;
  let signals = 0;
  chat.addEventListener("fixture", () => signals++);
  for (let lap = 0; lap < 2; lap++) {
    for (const key of [LIBRARY, MEMORY, TALK]) {
      await h.shell.go(key);
      h.assertPage(key);
    }
  }
  const entries = structuredClone(h.entries);
  assert.equal(h.history.length, 7);
  for (const [delta, expected] of [[-1, MEMORY], [1, TALK], [-1, MEMORY], [-1, LIBRARY], [-1, TALK], [1, LIBRARY]]) {
    h.history.go(delta);
    await h.idle();
    h.assertPage(expected);
    assert.deepEqual(structuredClone(h.entries), entries, "traversal never pushes or rewrites history");
  }
  h.history.back();
  await h.idle();
  h.assertPage(TALK);
  assert.equal(h.document.getElementById("chat"), chat);
  assert.equal(chat.session, session);
  chat.dispatchEvent(new Event("fixture"));
  assert.equal(signals, 1, "Talk event closures survive restore");
  assert.equal(h.requests.filter((r) => r.key === TALK).length, 0, "cached Talk does not reload");
});

test("repeated same-destination calls share work and never duplicate history", async () => {
  const h = harness();
  h.heldFetches.add(LIBRARY);
  const first = h.shell.go(LIBRARY);
  const second = h.shell.go(LIBRARY);
  assert.equal(h.shell.busy, true);
  assert.equal(first, second, "callers should await the same pending transition");
  assert.equal(h.requests.length, 1);
  assert.equal(h.history.length, 2);
  h.requests[0].resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  h.assertPage(LIBRARY);
  assert.equal(await h.shell.go(LIBRARY), true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.history.length, 2);
});

for (const staleOutcome of ["resolve", "fail"]) {
  test(`Back interrupts an unfinished fetch; stale ${staleOutcome} cannot replace Talk`, async () => {
    const h = harness();
    h.heldFetches.add(LIBRARY);
    const pending = h.shell.go(LIBRARY);
    h.history.back();
    await h.idle();
    assert.equal(h.shell.currentKey, TALK);
    assert.ok(h.document.getElementById("chat"), "previous content is kept while fetching");
    h.requests[0][staleOutcome]();
    assert.equal(await pending, false, "cancelled navigation must not report success");
    assert.equal(h.location.pathname, TALK);
    assert.equal(h.shell.currentKey, TALK);
    assert.equal(h.document.title, "Chat");
    assert.equal(h.context.pageRuns.length, 0, "obsolete fetched pages never run");
    assert.deepEqual(h.assignments, []);
    assert.deepEqual(h.replacements, []);
    assert.equal(h.history.length, 2);
    h.heldFetches.clear();
    h.history.forward();
    await h.idle();
    h.assertPage(LIBRARY);
  });
}

test("newer clicks win out-of-order fetches while intermediate history remains traversable", async () => {
  const h = harness();
  h.heldFetches.add(LIBRARY);
  const old = h.shell.go(LIBRARY);
  await h.shell.go(MEMORY);
  h.assertPage(MEMORY);
  h.requests[0].resolve();
  await old;
  h.assertPage(MEMORY);
  assert.deepEqual(Array.from(h.context.pageRuns, (r) => r.key), [MEMORY]);
  assert.equal(h.history.length, 3);
  h.heldFetches.clear();
  h.history.back();
  await h.idle();
  h.assertPage(LIBRARY);
});

test("clicking the still-displayed page cancels a pending destination without losing its state", async () => {
  const h = harness();
  const chat = h.document.getElementById("chat");
  h.heldFetches.add(LIBRARY);
  const old = h.shell.go(LIBRARY);
  await h.shell.go(TALK);
  assert.equal(h.shell.busy, false);
  assert.equal(h.location.pathname, TALK);
  assert.equal(h.shell.currentKey, TALK);
  assert.equal(h.document.getElementById("chat"), chat);
  assert.equal(h.history.length, 3, "clicking Talk creates one entry; it is not a history traversal");
  h.requests[0].resolve();
  await old;
  assert.equal(h.document.getElementById("chat"), chat);
  assert.equal(h.context.pageRuns.length, 0);
  h.heldFetches.clear();
  h.history.back();
  await h.idle();
  h.assertPage(LIBRARY);
});

test("Back then Forward during pending navigation follows the latest history entry", async () => {
  const h = harness();
  await h.shell.go(LIBRARY);
  h.heldFetches.add(MEMORY);
  const old = h.shell.go(MEMORY);
  h.history.back();
  await h.idle();
  h.assertPage(LIBRARY);
  h.history.forward();
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve();
  await h.idle();
  h.assertPage(MEMORY);
  h.requests[1].resolve();
  await old;
  h.assertPage(MEMORY);
  assert.equal(h.history.length, 3);
});

test("old network errors cannot redirect a newer completed page", async () => {
  const h = harness();
  h.heldFetches.add(LIBRARY);
  const old = h.shell.go(LIBRARY);
  await h.shell.go(MEMORY);
  h.requests[0].fail();
  await old;
  h.assertPage(MEMORY);
});

test("a superseded Library bootstrap cannot redirect the newer page after an external script loads", async () => {
  const h = harness();
  h.externalPages.add(LIBRARY);
  const library = h.shell.go(LIBRARY);
  await h.flush();
  assert.equal(h.externalScripts.length, 1);
  assert.equal(h.shell.currentKey, LIBRARY, "currentKey tracks the mounted page, not a fetched target");
  const memory = h.shell.go(MEMORY);
  await h.flush();
  assert.equal(h.requests.length, 2, "latest page can fetch while earlier scripts finish");
  assert.equal(h.document.getElementById("bzPage").getAttribute("data-bz-path"), LIBRARY);
  assert.equal(h.shell.busy, true);
  h.externalScripts[0].onload();
  await Promise.all([library, memory]);
  h.assertPage(MEMORY);
  assert.deepEqual(Array.from(h.context.pageRuns, (r) => [r.key, r.active]), [[MEMORY, MEMORY]]);
  assert.deepEqual(h.readyEvents, [MEMORY], "cancelled pages cannot run DOMContentLoaded bootstraps");
  assert.equal(h.history.length, 3, "the stale Library guard cannot insert a Talk entry");
});

test("Back and Forward can supersede queued mounts while a script is loading", async () => {
  const h = harness();
  h.externalPages.add(LIBRARY);
  const library = h.shell.go(LIBRARY);
  await h.flush();
  const memory = h.shell.go(MEMORY);
  await h.flush();
  h.history.back();
  await h.flush();
  h.externalPages.clear();
  h.externalScripts[0].onload();
  await h.flush();
  assert.equal(h.externalScripts.length, 2, "the cancelled Library bootstrap must be rebuilt");
  h.externalScripts[1].onload();
  await Promise.all([library, memory]);
  await h.idle();
  h.assertPage(LIBRARY);
  assert.deepEqual(Array.from(h.context.pageRuns, (r) => r.key), [LIBRARY], "superseded Memory never mounts");
  h.history.forward();
  await h.idle();
  h.assertPage(MEMORY);
  assert.equal(h.history.length, 3);
});

test("Talk scroll, draft state, title, and original stylesheet survive cache restoration", async () => {
  const h = harness();
  const chat = h.document.getElementById("chat");
  const style = h.document.head.querySelector("style");
  h.context.scrollY = 175;
  await h.shell.go(LIBRARY);
  assert.equal(style.disabled, true);
  assert.equal(h.shell.cache[TALK].el.querySelector("#chat"), chat);
  h.history.back();
  await h.idle();
  h.assertPage(TALK);
  assert.equal(h.context.scrollY, 175);
  assert.equal(h.document.head.querySelector("style"), style);
});

test("a cancelled first Talk bootstrap is never cached as an initialized conversation", async () => {
  const h = harness(LIBRARY);
  h.externalPages.add(TALK);
  const talk = h.shell.go(TALK);
  await h.flush();
  const incompleteChat = h.document.getElementById("chat");
  const memory = h.shell.go(MEMORY);
  await h.flush();
  h.externalScripts[0].onload();
  await Promise.all([talk, memory]);
  h.assertPage(MEMORY);
  assert.equal(h.shell.cache[TALK], undefined);
  assert.equal(h.document.getElementById("chat"), null);
  h.externalPages.clear();
  h.history.back();
  await h.idle();
  h.assertPage(TALK);
  assert.notEqual(h.document.getElementById("chat"), incompleteChat);
  assert.equal(h.requests.filter((r) => r.key === TALK).length, 2);
  assert.deepEqual(Array.from(h.context.pageRuns, (r) => r.key), [MEMORY, TALK]);
});

for (const parameter of ["job", "expert"]) {
  test(`Talk's actual ?${parameter} consumption keeps its canonical URL, cache, and draft aligned`, async () => {
    const h = harness(LIBRARY);
    await h.shell.go(TALK + `?${parameter}=fixture`);
    h.assertPage(TALK);
    const chat = h.document.getElementById("chat");
    chat.draft = "keep my context-specific draft";
    await h.shell.go(MEMORY);
    assert.equal(h.shell.cache[TALK].el.querySelector("#chat"), chat);
    assert.equal(h.shell.cache[TALK + `?${parameter}=fixture`], undefined);
    h.history.back();
    await h.idle();
    h.assertPage(TALK);
    assert.equal(h.document.getElementById("chat"), chat);
    assert.equal(chat.draft, "keep my context-specific draft");
    assert.equal(h.requests.filter((r) => r.key.startsWith(TALK)).length, 1);
    assert.equal(h.history.length, 3);
  });
}

test("a newly contextualized Talk replaces an older canonical cache without hidden duplicate IDs", async () => {
  const h = harness();
  const oldChat = h.document.getElementById("chat");
  await h.shell.go(LIBRARY);
  await h.shell.go(TALK + "?job=fixture");
  h.assertPage(TALK);
  const newChat = h.document.getElementById("chat");
  assert.notEqual(newChat, oldChat);
  assert.equal(h.document.querySelectorAll("#chat").length, 1);
  assert.equal(h.document.querySelectorAll('[data-bz-style="/buzzy/talk"]').length, 1);
  await h.shell.go(MEMORY);
  h.history.back();
  await h.idle();
  h.assertPage(TALK);
  assert.equal(h.document.getElementById("chat"), newChat);
});

test("an out-of-shell navigation cancels an old fetch's mount and failure redirect", async () => {
  const h = harness();
  h.heldFetches.add(LIBRARY);
  const old = h.shell.go(LIBRARY);
  await h.shell.go("/outside");
  h.requests[0].fail();
  await old;
  assert.equal(h.location.pathname, "/outside");
  assert.equal(h.shell.busy, false);
  assert.deepEqual(h.assignments, [ORIGIN + "/outside"]);
  assert.deepEqual(h.replacements, []);
});

for (const existingTalkApi of [false, true]) {
  test(`a cancelled Library job-navigation continuation cannot undo newer navigation (Talk API ${existingTalkApi})`, async () => {
    const h = harness(LIBRARY);
    h.heldFetches.add(TALK);
    h.context.jobOpens = [];
    h.context.sessionStorage = { setItem() {} };
    h.context.catalog = { jobs: [{ id: "fixture-job", messages: [] }] };
    h.context.state = {};
    for (const name of ["snapshotCurrent", "saveState", "jobTitle", "jobStatus"]) h.context[name] = () => {};
    if (existingTalkApi) {
      h.context.BeeZillaTalk = { openJob(id) { h.context.jobOpens.push(id); h.history.replaceState({}, "", TALK); return true; } };
    }
    vm.runInContext(`function softGo(href) { return window.BeeZillaShell.go(href); }\n${openJobChat}`, h.context);
    const job = h.context.openJobChat("fixture-job");
    await h.shell.go(MEMORY);
    h.requests[0].resolve();
    await job;
    await h.idle();
    h.assertPage(MEMORY);
    assert.deepEqual(h.context.jobOpens, [], "cancelled actions cannot change Talk's conversation");
    assert.equal(h.history.length, 3, "no late fallback Talk?job entry");
  });
}

test("the actual Library job continuation still runs after successful navigation", async () => {
  const h = harness(LIBRARY);
  h.context.jobOpens = [];
  h.context.sessionStorage = { setItem() {} };
  h.context.catalog = { jobs: [{ id: "fixture-job", messages: [] }] };
  h.context.state = {};
  for (const name of ["snapshotCurrent", "saveState", "jobTitle", "jobStatus"]) h.context[name] = () => {};
  h.context.BeeZillaTalk = { openJob(id) { h.context.jobOpens.push(id); return true; } };
  vm.runInContext(`function softGo(href) { return window.BeeZillaShell.go(href); }\n${openJobChat}`, h.context);
  await h.context.openJobChat("fixture-job");
  h.assertPage(TALK);
  assert.deepEqual(h.context.jobOpens, ["fixture-job"]);
});

test("voice start is not scheduled after its Talk navigation was superseded", async () => {
  const h = harness(LIBRARY);
  const timers = [];
  h.context.engine = () => null;
  h.context.paint = () => {};
  h.context.setTimeout = (callback) => timers.push(callback);
  h.heldFetches.add(TALK);
  vm.runInContext(startVoice, h.context);
  h.context.startHere();
  const talk = h.shell.go(TALK);
  await h.shell.go(MEMORY);
  h.requests[0].resolve();
  assert.equal(await talk, false);
  await h.flush();
  h.assertPage(MEMORY);
  assert.equal(timers.length, 0);
  h.heldFetches.clear();
  h.context.startHere();
  await h.idle();
  h.assertPage(TALK);
  assert.equal(timers.length, 1, "a successful request still schedules the requested voice start");
});

test("query-distinct routes are traversed, not mistaken for the displayed page", async () => {
  const h = harness();
  for (const key of [LIBRARY + "?q=first", LIBRARY + "?q=second"]) {
    await h.shell.go(key);
    h.assertPage(key);
  }
  h.history.back();
  await h.idle();
  h.assertPage(LIBRARY + "?q=first");
  assert.equal(h.history.length, 3);
});

test("latest fetch failure reloads the existing history entry, including after Back", async () => {
  const h = harness();
  await h.shell.go(LIBRARY);
  await h.shell.go(MEMORY);
  h.heldFetches.add(LIBRARY);
  h.history.back();
  h.requests.at(-1).fail();
  await h.idle();
  assert.deepEqual(h.replacements, [ORIGIN + LIBRARY]);
  assert.deepEqual(h.assignments, []);
  assert.equal(h.pushes.length, 2, "traversal fallback must not push");
  assert.equal(h.history.length, 3);
  assert.equal(h.location.pathname, LIBRARY);
});
