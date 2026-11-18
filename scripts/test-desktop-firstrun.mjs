#!/usr/bin/env node
/**
 * E2E: first run with nothing configured.
 *
 * A brand-new install has no key, so every message gets the "I can't connect"
 * refusal. Handing a non-technical user a window that cannot do anything is how a
 * desktop app feels broken on day one — so a first run with no inference opens
 * Settings instead.
 *
 * Two launches, both requiring a clean exit and a positively loaded chat page:
 *   1. empty data dir        -> onboarding fires, Settings window opens
 *   2. seeded inference.json -> no onboarding (a configured user is not nagged)
 *
 * Run: node scripts/test-desktop-firstrun.mjs
 * Uses native Electron on macOS; Linux requires xvfb-run and a working sandbox.
 * Missing launch prerequisites FAIL rather than reporting a passing skip.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveInference } from "./lib/inference.mjs";
import { desktopLaunchPlan, desktopLaunchStatus, runDesktopLaunch, withDesktopSandbox } from "./lib/desktop-test-harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const launch = (paths) => runDesktopLaunch(
  desktopLaunchPlan({ root: ROOT, paths, mode: "firstrun" }),
  { timeoutMs: 150_000 },
);

// ── 1. empty install ────────────────────────────────────────────────────────
await withDesktopSandbox("firstrun", async (paths) => {
  const result = await launch(paths);
  const status = desktopLaunchStatus(result);
  check("a fresh install launches and exits cleanly", status.ok, status.detail);
  check("a fresh install reports no inference", status.ok && /onboarding: no inference configured/.test(result.out));
  check("a fresh install opens the Settings window", status.ok && /settings window opened .*\/buzzy\/settings(?:\s|$)/.test(result.out));
  check("the first-run Settings page finishes loading", status.ok && /\[desktop-test\] page loaded .*\/buzzy\/settings(?:\s|$)/.test(result.out));
});

// ── 2. configured install is left alone ─────────────────────────────────────
await withDesktopSandbox("firstrun-configured", async (paths) => {
  saveInference(paths.data, { provider: "byok", key: "sk-configured-probe-123456", baseUrl: "https://example.test/v1", model: "" });
  const result = await launch(paths);
  const status = desktopLaunchStatus(result);
  check("a configured install launches and exits cleanly", status.ok, status.detail);
  // A crash, timeout, or single-instance early exit is not a clean start.
  check("a configured install does not open onboarding", status.ok && !/onboarding: no inference/.test(result.out));
  check("a configured install does not open Settings", status.ok && !/settings window opened/.test(result.out));
});

console.log(`\nfirst-run E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
