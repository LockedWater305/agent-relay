/** Actual Connect flow with controlled promises; no browser, network or credentials. */
import assert from "node:assert/strict";
import test from "node:test";
import { connectAccount, MINT_SCRIPT, PROFILE_SCRIPT, SEARCH_MINT_SCRIPT } from "../desktop/connect.mjs";

const mint = { status: 200, body: { ok: true, token: "synthetic-only" } };
const signIn = { status: 401, body: { code: "unauthenticated" } };
const never = () => new Promise(() => {});
const baseUrl = "https://fixture.invalid";
async function within(work, ms = 650) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Connect never settled")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

for (const step of ["open", "first mint"]) {
  test(`a stalled ${step} returns an actionable connection error and closes once`, async () => {
    let closes = 0, mints = 0;
    const result = await within(connectAccount({
      baseUrl, operationTimeoutMs: 35,
      open: step === "open" ? never : async () => {},
      evaluate: () => { mints++; return never(); },
      close: () => { closes++; },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.unreachable, true);
    assert.match(result.error, /check your connection/);
    assert.equal(closes, 1);
    assert.equal(mints, step === "open" ? 0 : 1);
  });
}

test("sign-in deadline also bounds a stuck second mint", async () => {
  let attempts = 0, closes = 0;
  const result = await within(connectAccount({
    baseUrl, operationTimeoutMs: 5_000, signInDeadlineMs: 90, pollMs: 1,
    open: async () => {},
    evaluate: () => ++attempts === 1 ? signIn : never(),
    close: () => { closes++; },
  }));
  assert.equal(attempts, 2);
  assert.equal(closes, 1);
  assert.equal(result.ok, false);
  assert.equal(result.needsSignIn, true);
});

test("stalled optional search/profile and cleanup cannot block valid inference", async () => {
  const scriptOrder = [];
  const result = await within(connectAccount({
    baseUrl, operationTimeoutMs: 40,
    open: async () => {},
    evaluate: (script) => {
      scriptOrder.push(script);
      return script === MINT_SCRIPT ? mint : never();
    },
    close: never,
  }));
  assert.deepEqual(scriptOrder, [MINT_SCRIPT, SEARCH_MINT_SCRIPT, PROFILE_SCRIPT]);
  assert.equal(result.ok, true);
  assert.equal(result.token, mint.body.token);
  assert.equal(result.search.ok, false);
  assert.equal(result.account, undefined);
});

test("rejected open preserves the error and still cleans up", async () => {
  let closes = 0;
  const result = await connectAccount({
    baseUrl, operationTimeoutMs: 100,
    open: async () => { throw new Error("ERR_NAME_NOT_RESOLVED"); },
    evaluate: async () => { throw new Error("unreachable"); },
    close: () => { closes++; },
  });
  assert.equal(result.unreachable, true);
  assert.equal(closes, 1);
});

test("sign-in still proceeds through optional search and profile after an initial 401", async () => {
  const seen = [];
  const result = await connectAccount({
    baseUrl, operationTimeoutMs: 100, signInDeadlineMs: 300, pollMs: 1,
    open: async () => {},
    evaluate: async (script) => {
      seen.push(script);
      if (script === MINT_SCRIPT) return seen.length === 1 ? signIn : mint;
      if (script === SEARCH_MINT_SCRIPT) return { status: 503 };
      return { status: 200, user: { name: "Fixture", email: "fixture@invalid.example" } };
    },
    close: () => {},
  });
  assert.deepEqual(seen, [MINT_SCRIPT, MINT_SCRIPT, SEARCH_MINT_SCRIPT, PROFILE_SCRIPT]);
  assert.equal(result.ok, true);
  assert.equal(result.search.notDeployed, true);
  assert.equal(result.account.name, "Fixture");
});

for (const stage of ["first", "retry"]) {
  for (const completion of ["timeout", "rejected transport", "late valid token"]) {
    test(`window closed during ${stage} mint (${completion}) stays cancelled, not unreachable or authenticated`, async () => {
      let open = true, closes = 0, mints = 0;
      const scripts = [];
      const result = await within(connectAccount({
        baseUrl, operationTimeoutMs: 35, signInDeadlineMs: 200, pollMs: 1,
        open: async () => {},
        isOpen: () => open,
        evaluate(script) {
          scripts.push(script);
          if (script !== MINT_SCRIPT) return {};
          if (++mints === 1 && stage === "retry") return signIn;
          return Promise.resolve().then(() => {
            open = false;
            if (completion === "timeout") return never();
            if (completion === "rejected transport") throw new Error("ERR_CONNECTION_REFUSED");
            return mint;
          });
        },
        close: () => { closes++; return never(); },
      }));
      assert.equal(result.ok, false);
      assert.equal(result.cancelled, true);
      assert.equal(result.needsSignIn, true);
      assert.equal(result.unreachable, undefined);
      assert.equal(result.token, undefined);
      assert.match(result.error, /cancelled/i);
      assert.deepEqual(scripts, stage === "first" ? [MINT_SCRIPT] : [MINT_SCRIPT, MINT_SCRIPT]);
      assert.equal(closes, 1);
    });
  }
}
