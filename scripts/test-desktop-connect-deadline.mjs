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

const optionalSearch = { status: 200, body: { ok: true, token: "synthetic-search-only" } };
const optionalProfile = { status: 200, user: { name: "Fixture", email: "fixture@invalid.example" } };

for (const [name, delayedStep] of [["search", SEARCH_MINT_SCRIPT], ["profile", PROFILE_SCRIPT]]) {
  for (const completion of ["timeout", "rejected transport", "late valid response"]) {
    test(`window closed during optional ${name} (${completion}) leaves no inference, search or profile result to save`, async () => {
      let open = true, closes = 0;
      const scripts = [];
      const result = await within(connectAccount({
        baseUrl, operationTimeoutMs: 35,
        open: async () => {},
        isOpen: () => open,
        evaluate(script) {
          scripts.push(script);
          if (script === MINT_SCRIPT) return mint;
          const valid = script === SEARCH_MINT_SCRIPT ? optionalSearch : optionalProfile;
          if (script !== delayedStep) return valid;
          return Promise.resolve().then(() => {
            open = false;
            if (completion === "timeout") return never();
            if (completion === "rejected transport") throw new Error("ERR_CONNECTION_REFUSED");
            return valid;
          });
        },
        close: () => { closes++; return never(); },
      }));
      assert.equal(result.ok, false);
      assert.equal(result.cancelled, true);
      assert.equal(result.needsSignIn, true);
      assert.equal(result.unreachable, undefined);
      assert.equal(result.token, undefined);
      assert.equal(result.search?.token, undefined);
      assert.equal(result.account, undefined);
      assert.deepEqual(scripts, name === "search"
        ? [MINT_SCRIPT, SEARCH_MINT_SCRIPT] : [MINT_SCRIPT, SEARCH_MINT_SCRIPT, PROFILE_SCRIPT]);
      assert.equal(closes, 1);
    });
  }
}

test("normal owned cleanup after successful optional results does not cancel Connect", async () => {
  let open = true, closes = 0;
  const result = await within(connectAccount({
    baseUrl, operationTimeoutMs: 100,
    open: async () => {},
    isOpen: () => open,
    evaluate: (script) => script === MINT_SCRIPT ? mint
      : script === SEARCH_MINT_SCRIPT ? optionalSearch : optionalProfile,
    close: () => { closes++; open = false; },
  }));
  assert.equal(open, false);
  assert.equal(closes, 1);
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, undefined);
  assert.equal(result.token, mint.body.token);
  assert.equal(result.search.token, optionalSearch.body.token);
  assert.deepEqual(result.account, optionalProfile.user);
});

test("closing an initial navigation reports cancellation, not a connection error", async () => {
  let open = true, closes = 0, calls = 0;
  const result = await within(connectAccount({
    baseUrl, operationTimeoutMs: 100,
    open: async () => {
      open = false; // Window destroyed while its original loadURL rejects.
      throw new Error("ERR_ABORTED");
    },
    isOpen: () => open,
    evaluate: () => { calls++; },
    close: () => { closes++; },
  }));
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false);
  assert.equal(result.unreachable, undefined);
  assert.match(result.error, /cancelled/i);
  assert.equal(calls, 0);
  assert.equal(closes, 1);
});

test("closing the waiting sign-in window between polls stays cancelled and an immediate new Connect succeeds", async () => {
  let open = true, checks = 0, mints = 0, closes = 0, waiting;
  const pollDelayReached = new Promise((resolve) => { waiting = resolve; });
  const first = connectAccount({
    baseUrl, operationTimeoutMs: 100, signInDeadlineMs: 500, pollMs: 45,
    open: async () => {},
    isOpen: () => {
      if (++checks === 2) waiting(); // Initial 401 was observed; poll sleep is about to start.
      return open;
    },
    evaluate: async () => { mints++; return signIn; },
    close: () => { closes++; },
  });
  await within(pollDelayReached);
  open = false;
  const cancelled = await within(first);
  assert.equal(cancelled.cancelled, true);
  assert.match(cancelled.error, /cancelled/i);
  assert.equal(cancelled.token, undefined);
  assert.equal(mints, 1, "closing during the delay must not start another mint");
  assert.equal(closes, 1);
  const retried = await within(connectAccount({
    baseUrl, operationTimeoutMs: 100, open: async () => {}, isOpen: () => true, close: () => {},
    evaluate: async (script) => script === MINT_SCRIPT ? mint : script === SEARCH_MINT_SCRIPT ? optionalSearch : optionalProfile,
  }));
  assert.equal(retried.ok, true);
  assert.equal(retried.token, mint.body.token);
  assert.deepEqual(retried.account, optionalProfile.user);
});
