import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { handleInternalBrandKit } from "../src/lib/internal-brand-kit.server.ts";

const page = "/internal/brand-kit";
const image = page + "/assets/sample.png";
const stylesheet = page + "/assets/test.css";
const html = "<!doctype html><title>Synthetic gate fixture</title>";
const pngFixture = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
let sandbox;
let env;
const request = (path, cookie, init = {}) => new Request("https://example.test" + path, {
  ...init,
  headers: { ...(cookie ? { cookie: "fixture=" + cookie } : {}), ...init.headers },
});
const auth = {
  async getSessionUser(headers) {
    assert.deepEqual([...headers.keys()], ["cookie"], "only the cookie reaches the verifier");
    const id = headers.get("cookie")?.slice("fixture=".length);
    if (id === "broken-session") throw Error("Synthetic auth backend error");
    if (!["admin", "operator", "viewer", "disabled", "unverified", "unassigned", "broken-role"].includes(id)) return null;
    return { id, emailVerified: id !== "unverified" };
  },
  async getRoleById(id) {
    if (id === "broken-role") throw Error("Synthetic role backend error");
    return id === "unassigned" ? null : ["viewer", "operator"].includes(id) ? id : "admin";
  },
  async isUserDisabled(id) { return id === "disabled"; },
};

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "kit-gate-test-"));
  const dir = join(sandbox, "private-mount");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), html);
  await writeFile(join(dir, "assets/sample.png"), pngFixture);
  await writeFile(join(dir, "assets/test.css"), "h1 { color: black; }");
  await writeFile(join(dir, "assets/disallowed.svg"), "<svg></svg>");
  await writeFile(join(dir, "assets/disallowed.html"), "Not a safe asset");
  await writeFile(join(sandbox, "unmounted.png"), "not inside the kit");
  await symlink(join(sandbox, "unmounted.png"), join(dir, "assets/linked.png"));
  await writeFile(join(dir, "assets/oversize.png"), "");
  await truncate(join(dir, "assets/oversize.png"), 25 * 1024 * 1024);
  await mkdir(join(sandbox, "public"));
  await writeFile(join(sandbox, "public/index.html"), html);
  env = { DEVBOARDS_SURFACE: "admin", DATABASE_URL: "configured-fixture", BEEZILLA_INTERNAL_BRAND_KIT_DIR: dir };
});
after(() => rm(sandbox, { recursive: true, force: true }));

const verifyNoStore = (res) => {
  assert.match(res.headers.get("cache-control"), /private.*no-store/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(res.headers.get("x-robots-tag"), /noindex/);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
};
async function expectDenied(path, cookie, init, override = env, deps = auth) {
  const res = await handleInternalBrandKit(request(path, cookie, init), deps, override);
  assert.equal(res.status, 404, path + " / " + (cookie ?? "no session"));
  verifyNoStore(res);
  assert.equal(await res.text(), init?.method === "HEAD" ? "" : "Not found");
}

test("disabled by default; missing runtime config, local auth-off and non-admin services never call auth", async () => {
  const unexpected = new Proxy({}, { get() { assert.fail("disabled route called auth"); } });
  for (const cfg of [{}, {...env, DEVBOARDS_SURFACE:"app"}, {...env, DATABASE_URL:""}, {...env, VITE_AUTH_ENABLED:"false"},
    {...env, BEEZILLA_INTERNAL_BRAND_KIT_DIR:"relative"}, {...env, BEEZILLA_INTERNAL_BRAND_KIT_DIR:undefined}]) {
    for (const path of [page,image]) await expectDenied(path,"admin",undefined,cfg,unexpected);
  }
});

test("signed-out/ordinary/unverified/disabled/unassigned accounts cannot fetch HTML or direct assets", async () => {
  for (const session of [undefined, "unknown", "viewer", "operator", "disabled", "unverified", "unassigned", "broken-session", "broken-role"]) {
    for (const path of [page,image,stylesheet]) {
      await expectDenied(path,session);
      await expectDenied(path,session,{method:"HEAD"});
    }
  }
  for (const path of [page,image]) await expectDenied(path,undefined,{headers:{
    Authorization:"Bearer fake", "x-user-id":"admin", "x-user-role":"admin", "x-forwarded-user":"admin",
  }});
});

test("authorized admin receives the existing file bytes, strict CSP, and no HTTP cache", async () => {
  const index = await handleInternalBrandKit(request(page, "admin"), auth, env);
  verifyNoStore(index);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(index.headers.get("content-security-policy"), /default-src 'none'.*img-src 'self'.*style-src 'self'/);
  assert.equal(await index.text(), html);
  const asset = await handleInternalBrandKit(request(image, "admin"), auth, env);
  verifyNoStore(asset);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), pngFixture);
  const head = await handleInternalBrandKit(request(stylesheet, "admin", {method:"HEAD"}), auth, env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(await head.text(), "");
});

test("only the explicit endpoint and supported real files are served; no public paths, nesting or symlinks", async () => {
  for (const path of ["/assets/sample.png","/public/internal/brand-kit", page+"/index.html", page+"/assets/",
    page+"/assets/linked.png",page+"/assets/oversize.png",page+"/assets/missing.png",
    page+"/assets/disallowed.svg",page+"/assets/disallowed.html",page+"/assets/.hidden.png",
    page+"/assets/some%2Fsample.png",page+"/assets/some%5Csample.png",page+"/assets/%2e%2e/sample.png",
    page+"/assets/some/sample.png"]) await expectDenied(path,"admin");
  await expectDenied(page,"admin",{method:"POST"});
  for (const path of [page,image]) {
    await expectDenied(path,"admin",undefined,{...env,BEEZILLA_INTERNAL_BRAND_KIT_DIR:process.cwd()});
    await expectDenied(path,"admin",undefined,{...env,BEEZILLA_INTERNAL_BRAND_KIT_DIR:join(sandbox,"public")});
  }
});

test("revoking the database role immediately denies a subsequent direct image request", async () => {
  let role = "admin";
  const deps = {...auth,getRoleById:async()=>role};
  assert.equal((await handleInternalBrandKit(request(page,"admin"),deps,env)).status,200);
  role = "operator";
  await expectDenied(image,"admin",undefined,env,deps);
});
