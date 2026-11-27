import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

// Run only the real nav controller in Chromium. fetch and the page host are
// synthetic: there is no activity in an app account and zero HTTP submissions.
const source = readFileSync(
  process.argv[2] ?? fileURLToPath(new URL("../public/buzzy/nav.js", import.meta.url)),
  "utf8",
);
const from = "  function feedbackControl(nav) {";
const to = "\n  function loadCompanies() {";
assert.equal(source.split(from).length, 2);
assert.equal(source.split(to).length, 2);
const controller = source.slice(source.indexOf(from), source.indexOf(to));
const fakePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hKwAAAAASUVORK5CYII=",
  "base64",
);
const imageUrl = `data:image/png;base64,${fakePng.toString("base64")}`;
const firstDraft = "Synthetic first report, not a person’s data.";
const secondDraft = "Synthetic second report, no photo.";
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    chromiumSandbox: true,
    args: ["--enable-automation"], // Exposes CDP command line without bypassing sandbox.
  });
  const cdp = await browser.newBrowserCDPSession();
  const { arguments: argv } = await cdp.send("Browser.getBrowserCommandLine");
  assert.equal(argv.includes("--no-sandbox"), false);
  assert.equal(argv.includes("--disable-seccomp-filter-sandbox"), false);
  await cdp.detach();
});
after(async () => browser?.close());

async function form(t, responses) {
  const page = await browser.newPage();
  t.after(() => page.close());
  // Abort everything at the Playwright boundary too; only the synthetic fetch
  // below records calls. FileReader, screenshot preview, controls are real DOM.
  await page.route("**/*", (route) => route.abort());
  await page.setContent("<style>#bzFeedback:not(.open){display:none}</style><nav id='surface'></nav>");
  await page.clock.install();
  await page.evaluate((modes) => {
    window.calls = [];
    window.pendingFeedback = [];
    const stall = (signal) => new Promise((_ok, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    window.fetch = (url, options) => {
      const n = window.calls.push({
        url, method: options.method, payload: JSON.parse(options.body),
      });
      const receipt = { ok: true, ref: ["BZ-FB-ABCDEF", "BZ-FB-GHJKLM"][n - 1], received_at: "2026-11-27T00:00:00.000Z" };
      const reply = (patch = {}, status = 201) => Promise.resolve({
        ok: status >= 200 && status < 300, status, json: async () => ({ ...receipt, ...patch }),
      });
      switch (modes[n - 1]) {
        case "503":
          return Promise.resolve({
            ok: false, json: async () => ({ ok: false, error: "Synthetic inbox temporarily unavailable." }),
          });
        case "offline":
          return Promise.reject(new TypeError("Synthetic offline"));
        case "hung-headers":
          return stall(options.signal);
        case "hung-body":
          return Promise.resolve({ ok: true, json: () => stall(options.signal) });
        case "ok": return reply();
        case "deferred-ok": return new Promise(resolve => {
          window.pendingFeedback.push(() => reply().then(resolve));
        });
        case "missing-ref": return reply({ ref: undefined });
        case "numeric-ref": return reply({ ref: 123456 });
        case "bad-alphabet": return reply({ ref: "BZ-FB-ABCD01" });
        case "trailing-line-break": return reply({ ref: receipt.ref + "\n" });
        case "nonboolean-ok": return reply({ ok: "true" });
        case "missing-time": return reply({ received_at: undefined });
        case "invalid-time": return reply({ received_at: "not-a-date" });
        case "noncanonical-time": return reply({ received_at: "2026-11-27T00:00:00Z" });
        case "wrong-http-code": return reply({}, 200);
        default:
          throw new Error("Unexpected attempted write");
      }
    };
  }, responses);
  await page.addScriptTag({
    content: `function section() { return "talk"; }\n${controller}\nfeedbackControl(document.getElementById("surface"));`,
  });
  await page.getByRole("button", { name: "Feedback", exact: true }).click();
  await page.locator("#bzFbText").fill(firstDraft);
  await page.locator("#bzFbShot").setInputFiles({
    name: "synthetic.png", mimeType: "image/png", buffer: fakePng,
  });
  await page.locator("#bzFbShotImg").waitFor({ state: "visible" });
  return { page, calls: () => page.evaluate(() => window.calls) };
}

test("explicit 503 preserves text and screenshot and supports a single deliberate retry", async (t) => {
  const { page, calls } = await form(t, ["503", "ok"]);
  const send = page.locator("#bzFbSend");
  await send.click();
  assert.equal(await page.locator("#bzFbStatus").textContent(), "Synthetic inbox temporarily unavailable.");
  assert.equal(await page.locator("#bzFbStatus").isVisible(), true);
  assert.equal(await page.locator("#bzFbText").inputValue(), firstDraft);
  assert.equal(await page.locator("#bzFbShotImg").getAttribute("src"), imageUrl);
  assert.equal(await send.isEnabled(), true);
  assert.equal((await calls()).length, 1);
  await send.click();
  await page.getByText("BZ-FB-GHJKLM").waitFor();
  const sent = await calls();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
});

test("a rejected network request retains both attachments and re-enables retry", async (t) => {
  const { page, calls } = await form(t, ["offline"]);
  const send = page.locator("#bzFbSend");
  await send.click();
  assert.match(await page.locator("#bzFbStatus").textContent(), /try again|could not confirm/i);
  assert.equal(await page.locator("#bzFbText").inputValue(), firstDraft);
  assert.equal(await page.locator("#bzFbShotImg").getAttribute("src"), imageUrl);
  assert.equal(await send.isEnabled(), true);
  assert.equal((await calls()).length, 1);
});

for (const outcome of ["hung-headers", "hung-body"]) {
  test(`${outcome} restores a retry without automatic or parallel POST`, async (t) => {
    const { page, calls } = await form(t, [outcome, "ok"]);
    const send = page.locator("#bzFbSend");
    await send.click();
    assert.equal(await send.isEnabled(), false);
    // Exercise JS guard too, bypassing the native disabled-control click path.
    await send.dispatchEvent("click");
    assert.equal((await calls()).length, 1);
    await page.clock.fastForward(60000);
    assert.equal(await send.isEnabled(), true, "a missing response must not disable the form forever");
    assert.match(await page.locator("#bzFbStatus").textContent(), /could not confirm.*retrying could send it twice/i);
    assert.equal(await page.getByRole("button", { name: "Try again" }).isVisible(), true);
    assert.equal(await page.locator("#bzFbText").inputValue(), firstDraft);
    assert.equal(await page.locator("#bzFbShotImg").getAttribute("src"), imageUrl);
    assert.equal((await calls()).length, 1, "outcome is unknown; never retry automatically");
    await send.click();
    await page.getByText("BZ-FB-GHJKLM").waitFor();
    const sent = await calls();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
  });
}

test("Send another captures the new text and does not resend the old screenshot", async (t) => {
  const { page, calls } = await form(t, ["ok", "ok"]);
  await page.locator("#bzFbSend").click();
  await page.getByText("BZ-FB-ABCDEF").waitFor();
  await page.getByRole("button", { name: "Send another" }).click();
  assert.equal(await page.locator("#bzFbText").inputValue(), "");
  await page.locator("#bzFbText").fill(secondDraft);
  await page.locator("#bzFbSend").click();
  await page.getByText("BZ-FB-GHJKLM").waitFor();
  const sent = await calls();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, "/api/buzzy/feedback");
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].payload.body, firstDraft);
  assert.equal(sent[0].payload.screenshot, imageUrl);
  assert.deepEqual(
    { body: sent[1].payload.body, screenshot: sent[1].payload.screenshot ?? null },
    { body: secondDraft, screenshot: null },
  );
});

async function queueReads(page) {
  // The same real file controls fire change; only completion order is controlled.
  await page.evaluate(() => {
    window.queuedReads = [];
    window.FileReader = class {
      readAsDataURL(file) {
        window.queuedReads.push({ name: file.name, reader: this });
      }
    };
    window.completePhotoRead = (name, marker) => {
      const job = window.queuedReads.find((read) => read.name === name);
      job.reader.result = "data:image/png;base64," + btoa(marker);
      job.reader.onload();
    };
  });
}
const pick = (page, name) => page.locator("#bzFbShot").setInputFiles({
  name, mimeType: "image/png", buffer: fakePng,
});
const resolvePhoto = (page, name, marker) => page.evaluate(([file, sentinel]) =>
  window.completePhotoRead(file, sentinel), [name, marker]);

test("late FileReader result from replaced photo can never overwrite the current attachment", async (t) => {
  const { page, calls } = await form(t, ["ok"]);
  await queueReads(page);
  await pick(page, "older.png");
  await pick(page, "newest.png");
  await resolvePhoto(page, "newest.png", "NEW");
  await resolvePhoto(page, "older.png", "OLD");
  const expected = "data:image/png;base64,TkVX";
  const preview = await page.locator("#bzFbShotImg").getAttribute("src");
  await page.locator("#bzFbSend").click();
  await page.getByText("BZ-FB-ABCDEF").waitFor();
  const [post] = await calls();
  assert.deepEqual({ preview, upload: post.payload.screenshot }, { preview: expected, upload: expected });
});

test("removing the attachment invalidates the pending FileReader even with the same mounted input", async (t) => {
  const { page, calls } = await form(t, ["ok"]);
  await queueReads(page);
  await pick(page, "pending.png");
  await page.locator("#bzFbShotDrop").click();
  await resolvePhoto(page, "pending.png", "OLD");
  const visible = await page.locator("#bzFbShotImg").isVisible();
  await page.locator("#bzFbSend").click();
  await page.getByText("BZ-FB-ABCDEF").waitFor();
  const [post] = await calls();
  assert.deepEqual({ visible, upload: post.payload.screenshot ?? null }, { visible: false, upload: null });
});

for (const outcome of [
  "missing-ref", "numeric-ref", "bad-alphabet", "trailing-line-break", "nonboolean-ok",
  "missing-time", "invalid-time", "noncanonical-time", "wrong-http-code",
]) {
  test(`an unconfirmed ${outcome} preserves this draft and attachment without auto-retry`, async (t) => {
    const { page, calls } = await form(t, [outcome, "ok"]);
    await page.locator("#bzFbSend").click();
    await page.waitForFunction(() => {
      const send = document.getElementById("bzFbSend");
      return document.getElementById("bzFbAgain") || (window.calls.length === 1 && send && !send.disabled);
    });
    assert.equal(await page.locator("#bzFbAgain").count(), 0, "invalid reply cannot advance to a receipt");
    assert.equal(await page.locator("#bzFbText").inputValue(), firstDraft);
    assert.equal(await page.locator("#bzFbShotImg").getAttribute("src"), imageUrl);
    assert.match(await page.locator("#bzFbStatus").textContent(), /could not confirm.*retrying could send it twice/i);
    assert.equal((await calls()).length, 1);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByText("BZ-FB-GHJKLM", { exact: true }).waitFor();
    const sent = await calls();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
  });
}

const resolveEarlierReceipt = (page) => page.evaluate(() => window.pendingFeedback.shift()());
async function hasReceipt(page) {
  await page.getByText(/BZ-FB-ABCDEF/).first().waitFor();
}
async function retainedDraft(page) {
  assert.equal(await page.locator("#bzFbText").count(),1,"the older receipt must not replace the live draft");
}
test("a valid receipt confirms only the original payload and keeps newer typed edits editable", async t => {
  const {page,calls}=await form(t,["deferred-ok","ok"]);
  await page.locator("#bzFbSend").click();
  await page.locator("#bzFbText").fill(secondDraft);
  await resolveEarlierReceipt(page); await hasReceipt(page);
  const [earlier]=await calls();
  assert.equal(earlier.payload.body,firstDraft);
  await retainedDraft(page);
  assert.equal(await page.locator("#bzFbText").inputValue(),secondDraft);
  assert.match(await page.locator("#bzFbStatus").textContent(),/earlier.*BZ-FB-ABCDEF.*current draft has not been sent/i);
  assert.equal((await calls()).length,1);
  await page.getByRole("button",{name:"Send current draft"}).click();
  await page.getByText("BZ-FB-GHJKLM",{exact:true}).waitFor();
  assert.equal((await calls())[1].payload.body,secondDraft);
});
test("a valid older receipt preserves a replacement screenshot even when no text changed", async t => {
  const {page,calls}=await form(t,["deferred-ok","ok"]);
  await page.locator("#bzFbSend").click();
  await queueReads(page);
  await pick(page,"replacement.png");
  await resolvePhoto(page,"replacement.png","NEW");
  await resolveEarlierReceipt(page); await hasReceipt(page);
  assert.equal((await calls())[0].payload.screenshot,imageUrl);
  await retainedDraft(page);
  assert.equal(await page.locator("#bzFbShotImg").getAttribute("src"),"data:image/png;base64,TkVX");
  assert.equal((await calls()).length,1);
  await page.getByRole("button",{name:"Send current draft"}).click();
  await page.getByText("BZ-FB-GHJKLM",{exact:true}).waitFor();
  assert.equal((await calls())[1].payload.screenshot,"data:image/png;base64,TkVX");
});
test("pending file selection survives receipt before its FileReader result", async t => {
  const {page,calls}=await form(t,["deferred-ok"]);
  await page.locator("#bzFbSend").click();
  await queueReads(page);
  await pick(page,"still-reading.png");
  await resolveEarlierReceipt(page); await hasReceipt(page);
  await retainedDraft(page);
  await page.getByRole("button",{name:"Send current draft"}).click();
  assert.match(await page.locator("#bzFbShotHint").textContent(),/wait for the screenshot/i);
  assert.equal((await calls()).length,1,"do not send an older attachment while its replacement is being read");
  await resolvePhoto(page,"still-reading.png","NEW");
  assert.equal(await page.locator("#bzFbShotImg").getAttribute("src"),"data:image/png;base64,TkVX");
  assert.equal((await calls()).length,1);
});
test("close and reopen retain newer edits when their original receipt arrived while hidden", async t => {
  const {page,calls}=await form(t,["deferred-ok"]);
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.locator("#bzFbSend").click();
  await page.locator("#bzFbText").fill(secondDraft);
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await resolveEarlierReceipt(page);
  await page.getByRole("button",{name:"Feedback",exact:true}).click();
  await hasReceipt(page);
  await retainedDraft(page);
  assert.equal(await page.locator("#bzFbText").inputValue(),secondDraft);
  assert.equal((await calls()).length,1);
  assert.deepEqual(errors,[]);
});
test("a receipt with no intervening edits can reopen without focusing a removed textarea", async t => {
  const {page}=await form(t,["deferred-ok"]);
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.locator("#bzFbSend").click();
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await resolveEarlierReceipt(page);
  await page.getByRole("button",{name:"Feedback",exact:true}).click();
  await hasReceipt(page);
  assert.equal(await page.locator("#bzFbText").count(),0);
  assert.deepEqual(errors,[]);
  assert.equal(await page.locator("#bzFbAgain").evaluate(el=>el===document.activeElement),true);
});
test("new diagnostic consent while a receipt is pending stays with the unsent draft", async t => {
  const {page,calls}=await form(t,["deferred-ok"]);
  await page.locator("#bzFbSend").click();
  await page.locator("#bzFbDiag").check();
  await resolveEarlierReceipt(page); await hasReceipt(page);
  const [posted]=await calls();
  assert.equal("diag" in posted.payload,false);
  await retainedDraft(page);
  assert.equal(await page.locator("#bzFbDiag").isChecked(),true);
  assert.equal((await calls()).length,1);
});

test("Feedback keyboard Escape restores launcher focus without discarding a report", async (t) => {
  const { page, calls } = await form(t, []);
  const launcher = page.getByRole("button", { name: "Feedback", exact: true });
  await page.locator("#bzFbText").focus();
  await page.keyboard.press("Escape");
  await page.locator("#bzFeedback").waitFor({ state: "hidden" });
  assert.equal(await launcher.evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#bzFbText").inputValue(), firstDraft);
  assert.equal(await page.locator("#bzFbShotImg").getAttribute("src"), imageUrl);
  assert.equal((await calls()).length, 0);
});

test("Feedback minimize and restore expose the correct accessible state and keep the draft", async (t) => {
  const { page, calls } = await form(t, []);
  const launcher = page.getByRole("button", { name: "Feedback", exact: true });
  const toggle = page.locator("#bzFeedback .bz-panel-min");
  const formText = page.locator("#bzFbText");
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await launcher.getAttribute("aria-expanded"), "false");
  assert.equal(await toggle.getAttribute("aria-label"), "Restore feedback");
  await page.keyboard.press("Enter");
  assert.equal(await launcher.getAttribute("aria-expanded"), "true");
  assert.equal(await toggle.getAttribute("aria-label"), "Minimize feedback");
  assert.equal(await formText.evaluate((el) => document.activeElement === el), true);
  assert.equal(await formText.inputValue(), firstDraft);
  assert.equal((await calls()).length, 0);
});
