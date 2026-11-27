/**
 * Run from the repository root with:
 *   node scripts/test-auth-session-contract.mjs
 *
 * This mounts the same H3 auth handler as Nitro and uses the real Better Auth
 * package and embedded database. No live service, mail or known accounts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H3 } from "h3";
import { createServer } from "vite";

const origin = "http://127.0.0.1:8090";
const dataDir = await mkdtemp(join(tmpdir(), "bz-auth-contract-"));
for (const key of [
  "DATABASE_URL",
  "BETTER_AUTH_ALLOWED_HOSTS",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "GROK_AUTH_CLIENT_ID",
  "GROK_AUTH_CLIENT_SECRET",
  "GROK_AUTH_ISSUER",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
]) delete process.env[key];
process.env.BZ_RUNTIME = "local";
process.env.BZ_DATA_DIR = dataDir;
process.env.BZ_LOCAL_TOKEN = "synthetic-auth-contract-token";
process.env.BZ_LOCAL_OWNER_NAME = "Fixture Owner";
process.env.BZ_LOCAL_OWNER_EMAIL = "owner@example.invalid";
process.env.VITE_AUTH_ENABLED = "false";
process.env.BETTER_AUTH_URL = origin;
process.env.BETTER_AUTH_SECRET = "synthetic-auth-contract-secret-only";
process.env.BETTER_AUTH_TELEMETRY = "0";
const vite = await createServer({
  configFile: false,
  appType: "custom",
  server: { middlewareMode: true, watch: null, hmr: false },
});
const { default: authApi } = await vite.ssrLoadModule("/src/lib/auth-api.nitro.ts");
const { getPglite } = await vite.ssrLoadModule("/src/lib/db.ts");

const app = new H3();
app.get("/api/auth/get-session", authApi);
app.post("/api/auth/sign-out", authApi);
const request = (path, init = {}) => app.fetch(new Request(origin + path, init));
const readSignedOut = async (response) => {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.json(), null);
  assert.equal(response.headers.getSetCookie().length, 0);
};

try {
  process.env.BZ_RUNTIME = "cloud";
  await readSignedOut(await request("/api/auth/get-session"));
  const logout = await request("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { success: true });
  const cookies = logout.headers.getSetCookie();
  for (const name of ["session_token", "session_data", "dont_remember"]) {
    assert.ok(cookies.some(cookie => cookie.startsWith(`agent-relay.${name}=`) &&
      /(?:^|;)\s*max-age=0(?:;|$)/i.test(cookie)));
  }
  console.log("PASS hosted signed-out payload and idempotent sign-out");

  process.env.BZ_RUNTIME = "local";
  const authorized = { authorization: `Bearer ${process.env.BZ_LOCAL_TOKEN}` };
  for (const headers of [{}, { authorization: "Bearer wrong" }, { ...authorized, host: "non-loopback.invalid" }]) {
    await readSignedOut(await request("/api/auth/get-session", { headers }));
  }
  console.log("PASS local missing or wrong token, and rejected Host, are definitive JSON signed-out results");
  const response = await request("/api/auth/get-session", { headers: authorized });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.ok(!body.includes(process.env.BZ_LOCAL_TOKEN), "do not disclose the launch credential");
  const { session, user } = JSON.parse(body);
  assert.equal(session.id, "local-session");
  assert.equal(session.userId, "local_owner");
  assert.equal(session.token, "local");
  assert.equal(user.name, "Fixture Owner");
  assert.equal(user.email, "owner@example.invalid");
  assert.equal(response.headers.getSetCookie().length, 0);
  console.log("PASS local authorized workspace identity is uncached and does not create hosted cookies");
} finally {
  try {
    await (await getPglite()).close();
  } finally {
    await vite.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
