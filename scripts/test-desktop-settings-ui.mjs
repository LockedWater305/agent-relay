#!/usr/bin/env node
/**
 * E2E: the settings SCREEN, driven the way a person drives it.
 *
 * The bridge test proves IPC works. This proves there is a product: the real
 * page renders, the radio switches, a key can be pasted and saved, the status
 * line reports it, and the "now configured" line updates — in a real window.
 *
 * Run: node scripts/test-desktop-settings-ui.mjs
 * Uses native Electron on macOS; Linux requires xvfb-run and a working sandbox.
 * Missing launch prerequisites FAIL rather than reporting a passing skip.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopLaunchPlan, desktopLaunchStatus, runDesktopLaunch, withDesktopSandbox } from "./lib/desktop-test-harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

await withDesktopSandbox("settings-ui", async (paths) => {
  const out = await runDesktopLaunch(desktopLaunchPlan({ root: ROOT, paths, mode: "settings-ui" }));
  const status = desktopLaunchStatus(out, "/buzzy/settings");
  check("the settings launch exits cleanly with a loaded page", status.ok, status.detail);

  const line = out.out.split("\n").find((l) => l.includes("SETTINGS_DRIVE_RESULT:"));
  let parsed = null;
  if (status.ok && line) {
    try {
      parsed = JSON.parse(line.slice(line.indexOf("SETTINGS_DRIVE_RESULT:") + "SETTINGS_DRIVE_RESULT:".length));
    } catch {
      parsed = null;
    }
  }

  check("the settings page returns a successful launch result", Boolean(parsed), line ? line.slice(0, 140) : "no result line: the settings UI did not finish");
  check("the page finds the preload bridge", parsed?.hasBridge === true, String(parsed?.hasBridge));
  check("the form is present", parsed?.formPresent === true, String(parsed?.formPresent));
  check("controls are enabled", parsed?.buttonsEnabled === true, String(parsed?.buttonsEnabled));
  check("choosing 'my own key' reveals the key field", parsed?.byokFieldsShown === true, String(parsed?.byokFieldsShown));
  check(
    "the empty-state copy matches the selected option",
    /paste your key/i.test(parsed?.emptyNote ?? "") && !/will refuse/i.test(parsed?.emptyNote ?? ""),
    parsed?.emptyNote ?? "(empty)",
  );
  check("Remove key is disabled while nothing is configured", parsed?.clearDisabledWhenEmpty === true, String(parsed?.clearDisabledWhenEmpty));
  check("saving reports success in the UI", /Saved/i.test(parsed?.statusText ?? ""), parsed?.statusText ?? "(empty)");
  check("the form reflects the saved key", /your own key/i.test(parsed?.currentText ?? ""), (parsed?.currentText ?? "").slice(0, 100));
  check("the UI never shows the key itself", Boolean(parsed) && !/sk-drive-probe/.test(JSON.stringify(parsed)), "checked status + current lines");
});
console.log(`\nsettings screen E2E: ${failures === 0 ? "passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
