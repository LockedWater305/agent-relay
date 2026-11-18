import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

// Pure event/state fixtures: execute the actual public handlers with deferred
// responses and plain control objects. No browser, DOM library, server or IPC.
const root = process.env.BZ_NAV_SOURCE_ROOT || fileURLToPath(new URL("../", import.meta.url));
const project = readFileSync(path.join(root, "public/buzzy/project.html"), "utf8");
const talk = readFileSync(path.join(root, "public/buzzy/talk.html"), "utf8");
const projectStart = project.indexOf("  // A project page answers three questions");
const projectEnd = project.indexOf("</script>", projectStart);
assert.ok(projectStart >= 0 && projectEnd > projectStart);
const projectHandler = project.slice(projectStart, projectEnd);
const drawerMarker = talk.indexOf("    // ── Sessions drawer ─");
const drawerEnd = talk.indexOf("    // Handle auth/errors", drawerMarker);
assert.ok(drawerMarker >= 0 && drawerEnd > drawerMarker);
const drawerHandlers = talk.slice(drawerMarker, drawerEnd);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const ids = ["title", "meta", "sources", "deliverables", "activity", "conversation"];
function projectData(job) {
  return {
    project: { id: job, title: job + " title", status: "Deliverable ready", updatedAt: "2026-11-18T00:00:00Z" },
    sources: [{ label: job + " source", kind: "brief" }],
    deliverables: [{ name: job + " file", kind: "text", type: "text/plain", bytes: 5, url: "/file/" + job }],
    turns: [{ surface: job + " turn", created_at: "2026-11-18T00:00:00Z" }],
    messages: [{ content: job + " message", role: "user", created_at: "2026-11-18T00:00:00Z" }],
  };
}

function projectHarness(desktop) {
  const origin = desktop ? "http://127.0.0.1:3210" : "https://hosted.example.invalid";
  let url = new URL("/buzzy/project?job=first", origin), controls = {};
  const requests = [], redirects = [], events = new Map();
  const context = vm.createContext({
    URLSearchParams, Date, Promise,
    document: { getElementById(id) { return controls[id] || null; } },
    location: {
      get href() { return url.href; },
      set href(value) { redirects.push(value); url = new URL(value, url); },
      get pathname() { return url.pathname; },
      get search() { return url.search; },
    },
    fetch(href, options) {
      const response = deferred();
      const request = {
        href, options, ...response,
        success(job) { response.resolve({ status: 200, json: async () => projectData(job) }); },
        unauthorized() { response.resolve({ status: 401, json: async () => { throw new Error("unexpected JSON read"); } }); },
      };
      requests.push(request);
      return response.promise;
    },
    addEventListener(type, fn) {
      if (!events.has(type)) events.set(type, []);
      events.get(type).push(fn);
    },
    ...(desktop ? { beezilla: Object.freeze({}) } : {}),
  });
  context.window = context;
  function mount(job, page = "project") {
    Object.values(controls).forEach((node) => { node.isConnected = false; });
    url = new URL("/buzzy/" + page + (job ? "?job=" + job : ""), origin);
    controls = Object.fromEntries(ids.map((id) => [id, { id, isConnected: true, textContent: "initial " + id, innerHTML: "initial " + id }]));
    if (page === "project") vm.runInContext(projectHandler, context, { filename: "project.html:project-loader", timeout: 1000 });
    return controls;
  }
  return {
    context, requests, redirects, mount,
    visit(href) { url = new URL(href, origin); },
    emit(type) { for (const fn of events.get(type) || []) fn({ type }); },
    async flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); },
  };
}

function snapshot(controls) {
  return Object.fromEntries(ids.map((id) => [id, [controls[id].textContent, controls[id].innerHTML]]));
}

function assertProject(controls, job) {
  assert.equal(controls.title.textContent, job + " title");
  assert.ok(controls.meta.innerHTML.startsWith(job + " · updated "));
  for (const [id, value] of [["sources", "source"], ["deliverables", "file"], ["activity", "turn"], ["conversation", "message"]]) {
    assert.ok(controls[id].innerHTML.includes(job + " " + value), id + " belongs to " + job);
  }
}

for (const desktop of [false, true]) {
  const mode = desktop ? "desktop origin/bridge" : "hosted origin";

  test(mode + ": a late Project A response cannot overwrite Project B", async () => {
    const h = projectHarness(desktop);
    const a = h.mount("A");
    const b = h.mount("B");
    h.requests[1].success("B");
    await h.flush();
    assertProject(b, "B");
    const settled = snapshot(b), detached = snapshot(a);
    h.requests[0].success("A");
    await h.flush();
    assert.deepEqual(snapshot(b), settled);
    assert.deepEqual(snapshot(a), detached, "retired controls also stay untouched");
    assert.deepEqual(h.redirects, []);
  });

  test(mode + ": a response whose JSON resolves after navigation cannot overwrite the new page", async () => {
    const h = projectHarness(desktop), body = deferred();
    h.mount("A");
    h.requests[0].resolve({ status: 200, json: () => body.promise });
    await h.flush();
    const b = h.mount("B");
    h.requests[1].success("B");
    await h.flush();
    body.resolve(projectData("A"));
    await h.flush();
    assertProject(b, "B");
  });

  test(mode + ": an old same-job request cannot write into a fresh Back/Forward mount", async () => {
    const h = projectHarness(desktop);
    h.mount("A");
    h.mount("B");
    const newest = h.mount("A");
    h.requests[2].success("A-new");
    await h.flush();
    const settled = snapshot(newest);
    h.requests[0].success("A-old");
    h.requests[1].success("B");
    await h.flush();
    assert.deepEqual(snapshot(newest), settled, "same URL does not grant ownership to old controls");
  });

  test(mode + ": a retired Project 401 cannot redirect Talk", async () => {
    const h = projectHarness(desktop);
    h.mount("A");
    const current = h.mount(null, "talk"), before = snapshot(current);
    h.requests[0].unauthorized();
    await h.flush();
    assert.deepEqual(h.redirects, []);
    assert.deepEqual(snapshot(current), before);
  });

  test(mode + ": a pending shell destination is not hijacked by the mounted Project's 401", async () => {
    const h = projectHarness(desktop);
    const a = h.mount("A");
    h.visit("/buzzy/library"); // Shell updates URL before the next page is ready.
    h.requests[0].unauthorized();
    await h.flush();
    assert.deepEqual(h.redirects, []);
    assert.equal(a.title.textContent, "Could not load project");
    h.visit("/buzzy/project?job=A"); // Back retains the still-mounted owner.
    h.emit("popstate");
    assert.equal(a.meta.textContent, "signed_out", "failure remains visible rather than an endless loading state");
  });

  test(mode + ": the still-mounted Project may finish while a destination is pending, then survive Back", async () => {
    const h = projectHarness(desktop), a = h.mount("A");
    h.visit("/buzzy/studio?job=B");
    h.requests[0].success("A");
    await h.flush();
    h.visit("/buzzy/project?job=A");
    h.emit("popstate");
    assertProject(a, "A");
    assert.equal(h.requests.length, 1, "no lost completion or duplicate read");
  });

  test(mode + ": minimize-like visibility changes keep the same pending page owner", async () => {
    const h = projectHarness(desktop), a = h.mount("A");
    h.emit("visibilitychange");
    h.requests[0].success("A");
    await h.flush();
    assertProject(a, "A");
    assert.equal(h.requests[0].href, "/api/buzzy/projects/A");
    assert.equal(h.requests[0].options.credentials, "same-origin");
  });

  test(mode + ": active 401 and read errors keep the existing behavior", async () => {
    const h = projectHarness(desktop), a = h.mount("A");
    h.requests[0].unauthorized();
    await h.flush();
    assert.deepEqual(h.redirects, ["/buzzy/landing"]);
    assert.equal(a.meta.textContent, "signed_out");
    const b = h.mount("B");
    h.requests[1].reject(new Error("fixture read failed"));
    await h.flush();
    assert.equal(b.title.textContent, "Could not load project");
    assert.equal(b.meta.textContent, "fixture read failed");
  });

  test(mode + ": an old read error cannot repaint disconnected controls", async () => {
    const h = projectHarness(desktop), a = h.mount("A");
    h.mount(null, "library");
    const before = snapshot(a);
    h.requests[0].reject(new Error("late failure"));
    await h.flush();
    assert.deepEqual(snapshot(a), before);
  });
}

function drawerHarness() {
  function control(initial = []) {
    const classes = new Set(initial), attributes = {};
    return { attributes, classList: {
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, has(name) { return classes.has(name); },
      contains(name) { return classes.has(name); },
    }, setAttribute(name, value) { attributes[name] = value; } };
  }
  const drawer = control(), overlay = control(["hidden"]);
  const timers = new Map();
  let next = 0, loads = 0;
  const context = vm.createContext({
    document: { getElementById(id) { return id === "sessionsDrawer" ? drawer : overlay; } },
    loadSessions() { loads++; },
    setTimeout(fn, delay) { assert.equal(delay, 180); timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(drawerHandlers, context, { filename: "talk.html:sessions-drawer", timeout: 1000 });
  return { context, drawer, overlay, timers, get loads() { return loads; },
    runTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    assertOpen() {
      assert.equal(drawer.classList.contains("open"), true);
      assert.equal(drawer.attributes["aria-hidden"], "false");
      assert.equal(overlay.classList.contains("hidden"), false);
    },
  };
}

test("Talk History close then quick reopen keeps its overlay and accessibility state open", () => {
  const h = drawerHarness();
  h.context.openSessionsDrawer();
  h.context.closeSessionsDrawer();
  h.context.openSessionsDrawer();
  h.runTimers();
  h.assertOpen();
  assert.equal(h.loads, 2);
});

test("repeated History closes use only the latest close timer", () => {
  const h = drawerHarness();
  h.context.openSessionsDrawer();
  h.context.closeSessionsDrawer();
  h.context.closeSessionsDrawer();
  assert.equal(h.timers.size, 1);
  assert.equal(h.drawer.attributes["aria-hidden"], "true");
  h.runTimers();
  assert.equal(h.drawer.classList.contains("open"), false);
  assert.equal(h.overlay.classList.contains("hidden"), true);
});

test("History open-close-open-close keeps only the final close and can reopen again", () => {
  const h = drawerHarness();
  h.context.openSessionsDrawer();
  h.context.closeSessionsDrawer();
  h.context.openSessionsDrawer();
  h.context.closeSessionsDrawer();
  assert.equal(h.timers.size, 1);
  h.runTimers();
  h.context.openSessionsDrawer();
  h.assertOpen();
});
