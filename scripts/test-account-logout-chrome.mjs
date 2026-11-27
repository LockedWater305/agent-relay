// Run the shipped chrome controls with an isolated DOM/cache/transport fixture.
// Native history, real cookies and cross-browser behavior remain Playwright's job.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/buzzy/nav.js", import.meta.url), "utf8");
const shell = "/**\n * The page shell: navigation that does not reload the document.";
const seam = "  window.BeeZillaChrome = { boot: boot, section: section, syncBleed: applyBleed };";
assert.equal(source.split(shell).length, 2, "find the actual shipped chrome IIFE");
const chromeSource = source.split(shell)[0];
assert.equal(chromeSource.split(seam).length, 2, "expose chrome controls only inside the fixture VM");
const fixtureSource = chromeSource.replace(seam, seam +
  "\n  window.__accountFixture = { accountControl, honeyControl, planChip };");

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.style = {};
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get title() { return this.getAttribute("title") ?? ""; }
  set title(value) { this.setAttribute("title", value); }
  set innerHTML(value) {
    assert.equal(value, "", "fixture supports emptying only; never fake HTML parsing");
    this.children.slice().forEach(child => child.remove());
  }
  appendChild(child) {
    child.remove();
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  querySelectorAll(selector) {
    const [part, ...rest] = selector.trim().split(/\s+/);
    const match = node => part.startsWith("#") ? node.id === part.slice(1)
      : part.startsWith(".") ? (node.className ?? "").split(/\s+/).includes(part.slice(1))
      : node.tag === part;
    const matches = [];
    const visit = node => {
      for (const child of node.children) {
        if (match(child)) matches.push(...(rest.length ? child.querySelectorAll(rest.join(" ")) : [child]));
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getClientRects() { return []; } // This fixture does not measure focus/visibility.
}

const signedIn = { session: { id: "verified-fixture-session", userId: "fixture" },
  user: { id: "fixture", name: "Fixture Account", email: "user@example.invalid" } };
const plan = { ok: true, plan: "pro", remaining: { inference: 19 }, planUntil: "2027-01-02" };
const urls = { auth: "/api/auth/get-session", logout: "/api/auth/sign-out",
  plan: "/api/buzzy/entitlement", honey: "/api/wallet" };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup() {
  const document = new Element("document");
  document.readyState = "loading"; // Do not boot unrelated voice, company or chat controls.
  document.createElement = tag => new Element(tag);
  document.getElementById = id => document.querySelector("#" + id);
  const chrome = document.appendChild(new Element("header")).appendChild(new Element("div"));
  const cache = new Map([
    ["bz_identity", JSON.stringify({ id: signedIn.user.id })],
    ["bz_plan", JSON.stringify({ owner: signedIn.user.id, value: plan })],
    ["bz_honey", JSON.stringify({ owner: signedIn.user.id, value: 4321 })],
  ]);
  const localStorage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) };
  const location = { href: "/buzzy/profile" };
  const listeners = new EventTarget();
  const requests = [];
  const ctx = vm.createContext({
    document, Event, CustomEvent, location, localStorage, addEventListener: listeners.addEventListener.bind(listeners),
    setInterval: () => 0,
    fetch(url, options = {}) {
      assert.ok(Object.values(urls).includes(url), "all fixture requests use the closed synthetic route set");
      return new Promise(resolve => requests.push({
        url, options,
        reply(body, status = 200) {
          const headers = { "content-type": "application/json" };
          if (url === urls.plan || url === urls.honey) {
            headers["x-bz-account-owner"] = encodeURIComponent(signedIn.user.id);
          }
          resolve(new Response(JSON.stringify(body), { status, headers }));
        },
      }));
    },
  });
  ctx.window = ctx;
  vm.runInContext(fixtureSource, ctx, { filename: "nav.js:account-chrome", timeout: 1000 });
  const { accountControl, planChip, honeyControl } = ctx.__accountFixture;
  honeyControl(chrome);
  planChip(chrome);
  accountControl(chrome);

  const request = (name, index = 0) => {
    const req = requests.filter(r => r.url === urls[name])[index];
    assert.ok(req, `expected ${name} request ${index + 1}`);
    return req;
  };
  const signOut = () => {
    const button = chrome.querySelector(".am-signout");
    assert.equal(button?.textContent, "Log out");
    button.dispatchEvent(new Event("click", { cancelable: true }));
    const action = request("logout");
    assert.equal(action.options.method, "POST");
    assert.equal(action.options.credentials, "same-origin");
    return action;
  };
  const snapshot = () => {
    const plan = document.getElementById("bzPlanChip");
    const honey = document.getElementById("bzHoneyChip");
    return {
      name: document.getElementById("accountLink").textContent,
      plan: plan.textContent, planTitle: plan.getAttribute("title"), planDisplay: plan.style.display,
      honey: honey.textContent, honeyTitle: honey.title,
      cache: ["bz_identity", "bz_plan", "bz_honey"].map(key => cache.get(key)),
      href: location.href,
    };
  };
  request("auth").reply(signedIn);
  await settle();
  assert.equal(snapshot().name, "Fixture Account");
  assert.equal(snapshot().plan, "PRO");
  assert.ok(snapshot().honeyTitle.includes("Honey Drops"));
  return { chrome, request, signOut, snapshot };
}

test("confirmed logout clears account details and late successful old replies cannot repaint them", async () => {
  const h = await setup();
  const signedIn = h.snapshot();
  h.signOut().reply({ success: true });
  await settle();
  assert.deepEqual(h.snapshot(), signedIn, "POST 200 alone is not proof the session ended");
  const confirm = h.request("auth", 1);
  assert.equal(confirm.options.cache, "no-store");
  confirm.reply(null);
  await settle();
  const signedOut = { name: "Sign in", plan: "", planTitle: null, planDisplay: "none",
    honey: "\u25c8", honeyTitle: "", cache: ["null", "null", "null"], href: "/buzzy/" };
  assert.deepEqual(h.snapshot(), signedOut, "hide all stale label, title and cache values before reload");
  h.request("honey").reply({ balance: 9876 });
  h.request("plan").reply({ ...plan, remaining: { inference: 27 }, planUntil: "2028-02-03" });
  await settle();
  assert.deepEqual(h.snapshot(), signedOut, "old 200 responses cannot resurrect private indicators");
});

test("ambiguous session confirmation preserves account details and leaves logout retry available", async () => {
  const h = await setup();
  const before = h.snapshot();
  h.signOut().reply({ success: true });
  await settle();
  h.request("auth", 1).reply({ message: "fixture unavailable" }, 503);
  await settle();
  assert.deepEqual(h.snapshot(), before);
  const button = h.chrome.querySelector(".am-signout");
  assert.equal(button.textContent, "Log out");
  assert.equal(button.disabled, false);
});
