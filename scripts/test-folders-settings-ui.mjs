#!/usr/bin/env node
// Tests for public/buzzy/folders.js, the Settings section that drives window.beezillaFolders.
// The page script runs unchanged against a small DOM built from the shipped settings.html: the
// folders elements, their ids and their hidden attributes come from that markup. A fake bridge
// answers like the main process would. No browser starts.
// Run: node --test --test-concurrency=1 scripts/test-folders-settings-ui.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const SCRIPT = readFileSync(new URL("../public/buzzy/folders.js", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../public/buzzy/settings.html", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeNode(tag, id, doc) {
  return {
    tagName: tag.toUpperCase(),
    id,
    attrs: {},
    children: [],
    listeners: {},
    className: "",
    hidden: false,
    disabled: false,
    _text: null,
    get textContent() {
      return this._text ?? this.children.map((child) => child.textContent).join("");
    },
    set textContent(value) {
      this.children = [];
      this._text = String(value);
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    append(...items) {
      this._text = null;
      for (const item of items) {
        this.children.push(typeof item === "string" ? { tagName: "#text", textContent: item, children: [] } : item);
      }
    },
    replaceChildren(...items) {
      this.children = [];
      this._text = null;
      this.append(...items);
    },
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    focus() {
      doc.activeElement = this;
    },
  };
}

// Elements come from the shipped markup, so a renamed id or a lost `hidden` attribute fails here.
function makeDocument() {
  const byId = new Map();
  const doc = {
    activeElement: null,
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => makeNode(tag, "", doc),
  };
  for (const match of PAGE.matchAll(/<(\w+)([^>]*?)\sid="(folders[a-z-]*)"([^>]*)>/g)) {
    const attrs = `${match[2]} ${match[4]}`;
    const node = makeNode(match[1], match[3], doc);
    node.hidden = /\shidden\b/.test(attrs);
    node.className = /class="([^"]*)"/.exec(attrs)?.[1] ?? "";
    // Plain text only: the shipped labels and messages contain no nested markup.
    const text = new RegExp(`id="${match[3]}"[^>]*>([^<]*)<`).exec(PAGE)?.[1].trim();
    if (text) node.textContent = text;
    byId.set(match[3], node);
  }
  return doc;
}

function openPage(bridge) {
  const doc = makeDocument();
  const listeners = {};
  const win = {
    beezillaFolders: bridge,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
  };
  runInNewContext(SCRIPT, { window: win, document: doc });
  return {
    doc,
    byId: (id) => doc.getElementById(id),
    fire: (type) => (listeners[type] ?? []).forEach((fn) => fn()),
  };
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}
const rowsOf = (list) => list.children.filter((child) => child.tagName === "LI");
const buttonsOf = (row) => descendants(row).filter((node) => node.tagName === "BUTTON");
const labelsOf = (row) => buttonsOf(row).map((node) => node.textContent);
const buttonNamed = (row, label) => {
  const found = buttonsOf(row).find((node) => node.textContent === label);
  assert.ok(found, `button "${label}" in the row`);
  return found;
};
const statusOf = (row) => descendants(row).find((node) => /\bpill\b/.test(node.className)).textContent;
const fileOf = (entry) => entry.children[3].textContent;

async function click(node) {
  for (const listener of node.listeners.click ?? []) await listener({ type: "click", currentTarget: node });
  await flush();
}

const grant = (id, label, extra = {}) => ({
  id,
  label,
  root: `/Users/ana/${label}`,
  createdAt: 1,
  active: false,
  paused: false,
  revoked: false,
  ...extra,
});

/** Answers like the main process: the state changes, and each call is recorded. */
function fakeBridge({ grants = [], activity = [] } = {}) {
  const state = { grants: grants.map((g) => ({ ...g })), activity: activity.slice(), next: null, pick: null, emit: null };
  const calls = [];
  const find = (id) => state.grants.find((g) => g.id === id);
  const change = (name, mutate) => async (id) => {
    calls.push([name, id]);
    if (state.next) {
      const forced = state.next;
      state.next = null;
      return forced;
    }
    const target = find(id);
    if (!target) return { ok: false, code: "not_granted", message: "no such grant" };
    mutate(target);
    return { ok: true, data: { ...target } };
  };
  return {
    calls,
    state,
    list: async () => {
      calls.push(["list"]);
      return { ok: true, data: state.grants.map((g) => ({ ...g })) };
    },
    activity: async () => {
      calls.push(["activity"]);
      return { ok: true, data: state.activity.slice() };
    },
    pick: async () => {
      calls.push(["pick"]);
      const forced = state.pick;
      state.pick = null;
      return forced ?? { ok: true, data: { granted: false } };
    },
    activate: change("activate", (g) => { g.active = true; }),
    pause: change("pause", (g) => { g.paused = true; }),
    resume: change("resume", (g) => { g.paused = false; }),
    revoke: change("revoke", (g) => { g.revoked = true; g.active = false; }),
    onActivity(callback) {
      state.emit = callback;
      return () => { state.emit = null; };
    },
  };
}

test("the Settings page keeps the section hidden, loads folders.js after its own script, and keeps the bridge checks", () => {
  assert.match(PAGE, /<section id="folders" hidden>/);
  assert.match(PAGE, /<\/script>\s*<script src="\/buzzy\/folders\.js" defer><\/script>\s*<\/body>/);
  assert.match(PAGE, /window\.beezilla\?\.settings/);
  assert.match(PAGE, /id="nobridge"/);
  for (const id of ["folders", "folders-add", "folders-status", "folders-list", "folders-empty", "folders-activity", "folders-activity-empty"]) {
    assert.match(PAGE, new RegExp(`id="${id}"`), id);
  }
});

test("the page script builds its DOM from createElement and textContent only", () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
});

test("in a browser tab, without the bridge, the section stays hidden and nothing is wired", async () => {
  const page = openPage(undefined);
  await flush();
  assert.equal(page.byId("folders").hidden, true);
  assert.equal(page.byId("folders-add").listeners.click, undefined);
  assert.equal(rowsOf(page.byId("folders-list")).length, 0);
});

test("each row shows its status and only the actions that state allows", async () => {
  const bridge = fakeBridge({
    grants: [
      grant("g1", "Docs"),
      grant("g2", "Notes", { active: true }),
      grant("g3", "Old", { active: true, paused: true }),
      grant("g4", "Gone", { revoked: true }),
    ],
  });
  const page = openPage(bridge);
  await flush();
  assert.equal(page.byId("folders").hidden, false);
  const rows = rowsOf(page.byId("folders-list"));
  assert.deepEqual(rows.map(statusOf), ["Off", "On", "Paused", "Removed"]);
  assert.deepEqual(rows.map(labelsOf), [["Turn on", "Remove"], ["Pause", "Remove"], ["Resume", "Remove"], []]);
  assert.equal(buttonNamed(rows[0], "Turn on").attrs["aria-label"], "Turn on: Docs");
  assert.equal(page.byId("folders-empty").hidden, true);
  assert.equal(page.byId("folders-activity-empty").hidden, false);
});

test("Remove asks in place; Keep leaves the grant alone; only the confirmed Remove revokes", async () => {
  const bridge = fakeBridge({ grants: [grant("g1", "Docs")] });
  const page = openPage(bridge);
  await flush();
  const list = page.byId("folders-list");

  await click(buttonNamed(rowsOf(list)[0], "Remove"));
  let row = rowsOf(list)[0];
  assert.deepEqual(labelsOf(row), ["Keep folder", "Remove folder"]);
  assert.match(row.textContent, /This is final/);
  assert.equal(page.doc.activeElement, buttonNamed(row, "Keep folder"), "focus lands on Keep");
  assert.deepEqual(bridge.calls.filter(([name]) => name === "revoke"), []);

  await click(buttonNamed(row, "Keep folder"));
  row = rowsOf(list)[0];
  assert.deepEqual(labelsOf(row), ["Turn on", "Remove"]);
  assert.equal(page.doc.activeElement, buttonNamed(row, "Remove"), "focus returns to Remove");
  assert.equal(bridge.state.grants[0].revoked, false);

  await click(buttonNamed(row, "Remove"));
  await click(buttonNamed(rowsOf(list)[0], "Remove folder"));
  assert.deepEqual(bridge.calls.filter(([name]) => name === "revoke"), [["revoke", "g1"]]);
  row = rowsOf(list)[0];
  assert.equal(statusOf(row), "Removed");
  assert.deepEqual(labelsOf(row), []);
  assert.equal(page.byId("folders-status").textContent, "Removed “Docs”. Add it again to read it.");
});

test("turn on, pause and resume update the row; a refusal shows the broker's message", async () => {
  const bridge = fakeBridge({ grants: [grant("g1", "Docs")] });
  const page = openPage(bridge);
  await flush();
  const list = page.byId("folders-list");

  await click(buttonNamed(rowsOf(list)[0], "Turn on"));
  assert.equal(statusOf(rowsOf(list)[0]), "On");
  assert.equal(page.byId("folders-status").className, "status ok");
  await click(buttonNamed(rowsOf(list)[0], "Pause"));
  assert.equal(statusOf(rowsOf(list)[0]), "Paused");
  await click(buttonNamed(rowsOf(list)[0], "Resume"));
  assert.equal(statusOf(rowsOf(list)[0]), "On");

  bridge.state.next = { ok: false, code: "revoked", message: "the grant has been revoked" };
  await click(buttonNamed(rowsOf(list)[0], "Pause"));
  assert.equal(page.byId("folders-status").textContent, "the grant has been revoked");
  assert.equal(page.byId("folders-status").className, "status err");
  assert.equal(statusOf(rowsOf(list)[0]), "On", "a refused change leaves the row as the broker has it");
});

test("add: a cancelled picker adds nothing, a new grant shows as Off, and an error shows its message", async () => {
  const bridge = fakeBridge({});
  const page = openPage(bridge);
  await flush();
  const add = page.byId("folders-add");
  const list = page.byId("folders-list");

  await click(add);
  assert.equal(page.byId("folders-status").textContent, "No folder was added.");
  assert.equal(rowsOf(list).length, 0);
  assert.equal(page.byId("folders-empty").hidden, false);
  assert.equal(add.disabled, false);
  assert.equal(add.textContent, "Add a folder…");

  const taxes = grant("g9", "Taxes");
  bridge.state.grants.push(taxes);
  bridge.state.pick = { ok: true, data: { granted: true, grant: taxes } };
  await click(add);
  assert.equal(page.byId("folders-status").textContent, "Added “Taxes”. It is off until you turn it on.");
  assert.equal(page.byId("folders-status").className, "status ok");
  assert.deepEqual(rowsOf(list).map(statusOf), ["Off"]);
  assert.deepEqual(labelsOf(rowsOf(list)[0]), ["Turn on", "Remove"]);

  bridge.state.pick = {
    ok: false,
    code: "root_refused",
    message: "the home folder and the folders above it cannot be granted; choose a folder inside home",
  };
  await click(add);
  assert.match(page.byId("folders-status").textContent, /cannot be granted/);
  assert.equal(page.byId("folders-status").className, "status err");
});

test("activity is newest first, keeps 50, and a live entry joins the top; search rows show no text", async () => {
  const history = Array.from({ length: 60 }, (_, i) => ({
    at: i + 1, grantId: "g1", op: "readFile", path: `f${i + 1}`, ok: true, reason: null,
  }));
  const bridge = fakeBridge({ grants: [grant("g1", "Docs", { active: true })], activity: history });
  const page = openPage(bridge);
  await flush();
  const feed = page.byId("folders-activity");
  assert.equal(feed.children.length, 50);
  assert.equal(fileOf(feed.children[0]), "f60");
  assert.equal(fileOf(feed.children[49]), "f11");
  assert.equal(page.byId("folders-activity-empty").hidden, true);

  bridge.state.emit({ at: 100, grantId: "g1", op: "search", path: null, ok: true, reason: "limit", query: "secret words" });
  assert.equal(feed.children.length, 50);
  const top = feed.children[0];
  assert.equal(top.children[1].textContent, "Searched");
  assert.equal(top.children[2].textContent, "Docs");
  assert.equal(fileOf(top), "—");
  assert.equal(top.children[4].textContent, "stopped at the match limit");
  assert.doesNotMatch(feed.textContent, /secret words/, "the query is never shown");
});

test("activity rows say why an entry was refused, name the top folder, and a grant change refreshes the list", async () => {
  const bridge = fakeBridge({ grants: [grant("g1", "Docs")] });
  const page = openPage(bridge);
  await flush();
  const feed = page.byId("folders-activity");
  const listsBefore = bridge.calls.filter(([name]) => name === "list").length;

  bridge.state.emit({ at: 5, grantId: "g1", op: "readFile", path: "a.txt", ok: false, reason: "inactive" });
  assert.equal(feed.children[0].children[4].textContent, "refused (inactive)");
  bridge.state.emit({ at: 6, grantId: "g1", op: "listDir", path: "", ok: true, reason: null });
  assert.equal(fileOf(feed.children[0]), "(top folder)");

  bridge.state.grants.push(grant("g2", "Notes"));
  bridge.state.emit({ at: 7, grantId: "g2", op: "grant", path: null, ok: true, reason: null });
  await flush();
  assert.equal(bridge.calls.filter(([name]) => name === "list").length, listsBefore + 1);
  assert.equal(rowsOf(page.byId("folders-list")).length, 2);
});

test("leaving the page stops the activity callback", async () => {
  const bridge = fakeBridge({ grants: [grant("g1", "Docs")] });
  const page = openPage(bridge);
  await flush();
  assert.equal(typeof bridge.state.emit, "function");
  page.fire("pagehide");
  assert.equal(bridge.state.emit, null);
});
