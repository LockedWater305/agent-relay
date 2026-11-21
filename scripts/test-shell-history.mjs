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
    this.innerHTML = "";
    this.value = "";
    this.listeners = new Map();
    const classNames = new Set();
    this.classList = {
      add: name => classNames.add(name), remove: name => classNames.delete(name), contains: name => classNames.has(name),
      toggle(name, force = !classNames.has(name)) { if (force) classNames.add(name); else classNames.delete(name); return force; },
    };
  }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get src() { return this.hasAttribute("src") ? new URL(this.getAttribute("src"), ORIGIN).href : ""; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get firstChild() { return this.children[0] || null; }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(value) {
    if (this.disabled === Boolean(value)) return;
    if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled");
    this.disabledChanged?.();
  }
  contains(node) { for (let el = node; el; el = el.parentNode) if (el === this) return true; return false; }
  focus() {}
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

function pageDocument(key, external = false, decorate) {
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
  decorate?.(key, main, script);
  return doc;
}

export function harness(initialKey = TALK, decorate) {
  const document = pageDocument(initialKey, false, decorate);
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
    DOMParser: class { parseFromString(text) { const data = JSON.parse(text); return pageDocument(data.key, data.external, decorate); } },
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
    context, document, location, history, entries, pushes, replacements, assignments, requests, events,
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

// Two retained Talk visits own different DOM nodes with the same IDs. Use the
// real shell's cache/traversal and the shipped sender, renderers and event wiring.
// The network and media hooks are inert; no app or sockets start in this suite.
const workTalk = TALK + "?mode=work";
const typedDraft = "  Work on the originating conversation  ";
const siblingDraft = "A different pending draft";
const moneyCheckSource = readFileSync(new URL("../public/buzzy/money-check.js", import.meta.url), "utf8");

function talkTurnHarness() {
  const known = new Map();
  const requests = [];
  const effects = [];
  const reply = deferred();
  const h = harness(TALK, (key, main, script) => {
    if (key.split("?")[0] !== TALK) return;
    const add = (parent, id) => { const el = parent.appendChild(main.owner.createElement("div")); el.id = id; return el; };
    const screen = add(main, "chatScreen");
    const composer = add(screen, "composerCard");
    for (const id of ["chatInput", "chatSend", "chatDoIt", "chatError"]) add(composer, id);
    add(screen, "chatMessages");
    const banner = add(screen, "draftBanner");
    for (const id of ["draftBody", "draftWarning", "restorePrevious", "downloadCsvBtn", "moneyCheck", "approveDraft", "confirmOutward", "draftMeta", "draftSendNote"]) add(banner, id);
    script.textContent += `\nwindow.mountTalkTurn(${JSON.stringify(key)});`;
  });
  const fetchShell = h.context.fetch;
  Object.assign(h.context, {
    AbortSignal, ReadableStream, TextDecoder, performance: { now: () => 0 },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(node, options) {
        assert.equal(node.id, "chatSend");
        assert.equal(options.attributeFilter.includes("disabled"), true);
        node.disabledChanged = () => queueMicrotask(() => this.callback([{ target: node, attributeName: "disabled" }]));
      }
    },
    setTimeout() { effects.push("timer"); }, setInterval() { return 1; }, clearInterval() {},
    fetch(href, init) {
      if (!href.startsWith("/api/")) return fetchShell(href, init);
      assert.equal(href, "/api/buzzy/chat", "no other API is used in these tests");
      assert.equal(init.method, "POST");
      requests.push(JSON.parse(init.body));
      return reply.promise;
    },
    rememberTalkTurn(key, visit) { known.set(key, visit); },
    typedFixtureEffect(effect) { effects.push(effect); },
    mountTalkTurn(key) {
      const functions = ["chatContextSnapshot", "chatContextCurrent", "sendChatMessage", "ensureChatSession",
        "readThisBody", "streamTextTurn", "renderChatMessages", "paintChatInputAvailability", "draftBodyEl",
        "openDraftReview", "setDraftWarning", "renderMoneyCheck", "currentMoneyCheck", "briefLinesForCheck",
        "paperFactsForCheck", "paintDraftGate", "approvalMatches", "mdTableToCsv", "esc"];
      // The f875 preimage has all event wiring inline. Later revisions may use a
      // binder within that same block. Run both through the exact current wiring.
      if (talkSource.includes("    function bindTypedChatComposer(")) functions.push("bindTypedChatComposer");
      const production = functions.map(name => {
        const body = talkSource.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, "m"));
        assert.ok(body, `Talk's actual ${name} is required`);
        return body[0];
      }).join("\n");
      const bindings = talkSource.match(/^    \/\/ Wire up chat events\n[^]*?(?=^    \/\/ .*Chat \/ Work mode wiring)/m)?.[0];
      const labels = talkSource.match(/^    const SLOT_LABELS = \{[^]*?^    \};/m)?.[0];
      assert.ok(bindings && labels, "Talk's actual bindings and brief labels are required");
      vm.runInContext(`(function () {
        const key = ${JSON.stringify(key)}, work = key !== ${JSON.stringify(TALK)};
        const node = id => document.getElementById(id);
        const chatState = {sessionId: work ? "work-owner" : "other-owner", sessionVerified: true, slots: {},
          mode: work ? "work" : "chat", messages: [{ role: "assistant", content: work ? "Work history" : "Other history" }],
          paper: work ? {kind: "invoice", facts: [{key:"amount", label:"Amount", value:"$100.00", status:"confirmed"}]} : null};
        const chatNavigation = {generation: 0}, voice = {mic: false, replies: false, turnSeq: 0};
        const SESSIONS_BASE = "/api/buzzy/sessions", CHAT_BASE = "/api/buzzy/chat";
        let pendingExecute = false;
        function activeCompanyId() { return null; }
        function getAuthHeaders() { return {}; }
        function selectedModel() { return "fixture"; }
        function shouldOfferWork() { return false; }
        function setChatMascot() {}
        function renderSlotChecklist() {}
        function paintContext() {}
        function maybeSpeak() { typedFixtureEffect("speak"); }
        function startListening() { typedFixtureEffect("listen"); }
        function logVoiceMetrics() { typedFixtureEffect("metrics"); }
        ${labels}
        ${production}
        ${bindings}
        for (const id of ["chatError", "draftBanner", "draftWarning", "restorePrevious", "moneyCheck"]) node(id).classList.add("hidden");
        node("confirmOutward").disabled = true;
        renderChatMessages();
        const view = node("chatScreen");
        rememberTalkTurn(key, {view, node: id => view.querySelector("#" + id)});
      })();`, h.context, { filename: "actual Talk turn and controls", timeout: 1000 });
    },
  });
  vm.runInContext(moneyCheckSource, h.context, { filename: "money-check.js", timeout: 1000 });
  h.context.mountTalkTurn(TALK); // model the initial hard load, before the shell creates its wrapper
  return { h, known, requests, effects, reply };
}

async function finishCachedTurn(response) {
  const f = talkTurnHarness();
  const { h } = f;
  const other = f.known.get(TALK).node;
  other("chatInput").value = siblingDraft;
  assert.equal(await h.shell.go(workTalk), true);
  const origin = f.known.get(workTalk).node;
  origin("chatInput").value = typedDraft;
  const sending = origin("chatSend").onclick();
  await h.flush();
  assert.equal(origin("chatSend").disabled, true);
  assert.equal(origin("chatDoIt").disabled, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].sessionId, "work-owner");
  h.history.back();
  await h.idle();
  h.assertPage(TALK);
  assert.equal(h.document.getElementById("chatInput"), other("chatInput"));
  other("chatSend").disabled = true;
  await h.flush();
  const snapshot = () => [other("chatInput").value, other("chatError").textContent, other("chatMessages").innerHTML,
    other("chatSend").disabled, other("chatDoIt").disabled, other("draftBanner").classList.contains("hidden"),
    other("draftBody").value, other("draftWarning").textContent, other("approveDraft").disabled];
  const before = snapshot();
  f.reply.resolve(response);
  await sending;
  await h.flush();
  assert.deepEqual(snapshot(), before, "the mounted sibling never receives the cached Talk turn");
  h.history.forward();
  await h.idle();
  h.assertPage(workTalk);
  assert.equal(h.document.getElementById("chatInput"), origin("chatInput"));
  assert.equal(origin("chatSend").disabled, false);
  assert.equal(f.requests.length, 1, "Back/Forward and replies do not send again or approve work");
  assert.deepEqual(f.effects, [], "no new audio, Listen, or turn metrics from a cached result");
  return origin;
}

test("Back during a cold typed refusal leaves the other Talk alone and restores draft, Send and Do it on Forward", async () => {
  const origin = await finishCachedTurn(Response.json({ ok: false, notSent: true, code: "no_inference_config",
    error: "Set up inference in Settings. This chat request was not sent to an inference provider." }, { status: 503 }));
  assert.equal(origin("chatInput").value, typedDraft);
  assert.equal(origin("chatDoIt").disabled, false, "the original companion control follows its own Send");
  assert.match(origin("chatError").textContent, /Your draft is back/);
  assert.doesNotMatch(origin("chatMessages").innerHTML, /Work on the originating conversation/);
});

test("Back during a stored typed reply preserves both Talk transcripts and shows the replay on its own Forward", async () => {
  const origin = await finishCachedTurn(Response.json({ ok: true, reconciled: true, reply: "Stored work reply", slots: {} }));
  assert.match(origin("chatMessages").innerHTML, /Stored work reply/);
  assert.equal(origin("chatInput").value, "");
});

test("Back during a Work SSE draft keeps the review and its existing approval gates in the originating Talk", async () => {
  const draft = "Check the work proposal\n\n| Total | $125.00 |";
  const warning = "The total needs review.";
  const outcome = { ok: true, reply: draft, warning, draft: true, jobId: "fixture-job", slots: {}, previousDraft: "Earlier draft" };
  const origin = await finishCachedTurn(new Response(`event: done\ndata: ${JSON.stringify(outcome)}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }));
  assert.match(origin("chatMessages").innerHTML, /Check the work proposal/);
  assert.equal(origin("draftBanner").classList.contains("hidden"), false);
  assert.equal(origin("draftBody").value, draft);
  assert.equal(origin("draftWarning").textContent, warning);
  assert.equal(origin("restorePrevious").classList.contains("hidden"), false);
  assert.match(origin("moneyCheck").innerHTML, /\$100\.00/);
  assert.equal(origin("approveDraft").disabled, true, "the actual amount check still blocks approval");
  assert.equal(origin("confirmOutward").disabled, true, "nothing is automatically approved");
});
