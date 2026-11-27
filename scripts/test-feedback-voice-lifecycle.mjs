import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const input = process.argv[2] ?? fileURLToPath(new URL("../public/buzzy/nav.js", import.meta.url));
const source = readFileSync(input, "utf8");
const start = "  function feedbackControl(nav) {";
const end = "\n  function loadCompanies() {";
assert.equal(source.split(start).length, 2);
assert.equal(source.split(end).length, 2);
const controller = source.slice(source.indexOf(start), source.indexOf(end));
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    chromiumSandbox: true,
    args: ["--enable-automation"], // Exposes CDP command-line attestation, not a sandbox override.
    headless: true,
  });
  const cdp = await browser.newBrowserCDPSession();
  const { arguments: argv } = await cdp.send("Browser.getBrowserCommandLine");
  assert.equal(argv.includes("--no-sandbox"), false);
  assert.equal(argv.includes("--disable-seccomp-filter-sandbox"), false);
  await cdp.detach();
});
after(async () => browser?.close());

async function website(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  // No real endpoints, permissions, audio device, or report content.
  await page.route("**/*", route => route.abort());
  await page.setContent("<style>#bzFeedback:not(.open){display:none}</style><nav id='surface'></nav>");
  await page.evaluate(() => {
    const report = [];
    const pendingVoice = [];
    const pendingPermission = [];
    const ctx = [];
    const tracks = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true, value: {
        getUserMedia: () => new Promise((resolve, reject) => pendingPermission.push({resolve, reject})),
      },
    });
    window.AudioContext = class {
      constructor() {
        this.state = "running"; this.sampleRate = 16000; this.destination = {};
        this.closes = 0; ctx.push(this);
      }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        this.proc = { connect() {}, disconnect() {} }; return this.proc;
      }
      async close() { this.closes++; this.state = "closed"; }
    };
    window.fetch = (url, options) => {
      if (url === "/api/buzzy/feedback/transcribe") {
        if (!(options.body instanceof Blob) || options.body.type !== "audio/wav" || options.body.size < 44)
          throw new Error("Expected synthetic WAV");
        return new Promise((resolve, reject) => pendingVoice.push({resolve, reject}));
      }
      if (url === "/api/buzzy/feedback") {
        report.push(JSON.parse(options.body));
        return Promise.resolve({ok:true,json:async()=>({ok:true,ref:"BZ-FB-SYNTH"})});
      }
      throw new Error("Unexpected network request");
    };
    window.fixture = {
      resolvePermission(i) {
        const track = { stops:0, stop() { this.stops++; } };
        tracks[i] = track;
        pendingPermission[i].resolve({ getTracks: () => [track] });
      },
      rejectPermission(i) { pendingPermission[i].reject(new Error("Synthetic denied")); },
      voice(i, value) { pendingVoice[i].resolve({ok:true,json:async()=>({text:value})}); },
      voiceError(i) { pendingVoice[i].reject(new Error("Synthetic late error")); },
      feed() {
        const active = ctx.at(-1)?.proc;
        active.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(7000) } });
      },
      stats() { return {
        requested:pendingPermission.length, contextCount:ctx.length,
        closes:ctx.map(x=>x.closes), stops:tracks.map(x=>x?.stops ?? 0),
        transcriptions:pendingVoice.length, reports:report.length,
      }; },
    };
  });
  await page.addScriptTag({content:`function section() { return "talk"; }\n${controller}\nfeedbackControl(document.getElementById("surface"));`});
  const open = page.getByRole("button", {name:"Feedback", exact:true});
  await open.click();
  return {
    page, open, mic:page.locator("#bzFbMic"), hint:page.locator("#bzFbHint"), text:page.locator("#bzFbText"),
    close:page.getByRole("button", {name:"Close", exact:true}), send:page.locator("#bzFbSend"),
    stats:() => page.evaluate(() => window.fixture.stats()),
    permission:i => page.evaluate(i => window.fixture.resolvePermission(i), i),
    voice:(i,v) => page.evaluate(([i,v]) => window.fixture.voice(i,v), [i,v]),
    voiceError:i => page.evaluate(i => window.fixture.voiceError(i), i),
    feed:() => page.evaluate(() => window.fixture.feed()),
  };
}
async function begin(q) {
  await q.mic.click();
  await q.permission(0);
  await q.page.locator("#bzFbMic[aria-pressed=true]").waitFor();
}
async function requestTranscript(q) {
  await begin(q); await q.feed(); await q.mic.click();
  assert.equal((await q.stats()).transcriptions,1);
}
test("explicit Speak and Stop append voice only to its own current draft; release hardware", async t => {
  const q = await website(t);
  await q.text.fill("Current typing.");
  await requestTranscript(q);
  await q.voice(0,"SYNTHETIC WORDS");
  await q.page.getByText("Said what you wanted? You can edit it.").waitFor();
  assert.equal(await q.text.inputValue(), "Current typing. SYNTHETIC WORDS");
  assert.deepEqual(await q.stats(),{requested:1,contextCount:1,closes:[1],stops:[1],transcriptions:1,reports:0});
});
for(const disposition of ["text", "error"]) test("late transcription " + disposition + " cannot alter a new report after Send another", async t => {
  const q = await website(t);
  await q.text.fill("Original synthetic body");
  await requestTranscript(q);
  await q.send.click();
  await q.page.getByText("BZ-FB-SYNTH").waitFor();
  await q.page.getByRole("button",{name:"Send another"}).click();
  await q.text.fill("New independent draft");
  if (disposition === "text") await q.voice(0,"OLD PRIVATE SENTINEL");
  else await q.voiceError(0);
  assert.deepEqual(
    {draft:await q.text.inputValue(), hint:await q.hint.textContent()},
    {draft:"New independent draft", hint:"Up to 60 seconds."},
  );
});
test("permission granted after Close stops the returned track without starting or uploading voice", async t => {
  const q=await website(t);
  await q.mic.click();
  assert.equal((await q.stats()).requested,1);
  await q.close.click();
  await q.permission(0);
  assert.deepEqual(await q.stats(),{requested:1,contextCount:0,closes:[],stops:[1],transcriptions:0,reports:0});
  await q.open.click();
  assert.equal(await q.mic.getAttribute("aria-pressed"),"false");
});
test("closing during active capture stops the current track and discards voice without transcription", async t => {
  const q=await website(t);
  await q.text.fill("Typed draft is kept.");
  await begin(q); await q.feed();
  await q.close.click();
  assert.deepEqual(await q.stats(),{requested:1,contextCount:1,closes:[1],stops:[1],transcriptions:0,reports:0});
  await q.open.click();
  assert.equal(await q.mic.getAttribute("aria-pressed"),"false");
  assert.equal(await q.text.inputValue(),"Typed draft is kept.");
});
test("pending permission after the receipt cannot capture in the new draft", async t => {
  const q=await website(t);
  await q.text.fill("Original synthetic body");
  await q.mic.click();
  await q.send.click();
  await q.page.getByText("BZ-FB-SYNTH").waitFor();
  await q.page.getByRole("button",{name:"Send another"}).click();
  await q.permission(0);
  assert.deepEqual(await q.stats(),{requested:1,contextCount:0,closes:[],stops:[1],transcriptions:0,reports:1});
  assert.equal(await q.mic.getAttribute("aria-pressed"),"false");
});
test("repeated Speak while permission is pending contains one acquisition", async t => {
  const q=await website(t);
  await q.mic.click();
  await q.mic.dispatchEvent("click");
  assert.equal((await q.stats()).requested,1);
  await q.permission(0);
  await q.page.locator("#bzFbMic[aria-pressed=true]").waitFor();
  assert.equal((await q.stats()).contextCount,1);
});
test("old permission cannot consume the fresh Speak request after reopening", async t => {
  const q=await website(t);
  await q.mic.click();
  await q.close.click();
  await q.open.click();
  await q.mic.click();
  await q.permission(0);
  assert.deepEqual(await q.stats(),{requested:2,contextCount:0,closes:[],stops:[1],transcriptions:0,reports:0});
  await q.permission(1);
  await q.page.locator("#bzFbMic[aria-pressed=true]").waitFor();
  await q.feed(); await q.mic.click();
  await q.voice(0,"ONLY THE CURRENT VOICE");
  await q.page.getByText("Said what you wanted? You can edit it.").waitFor();
  assert.equal(await q.text.inputValue(),"ONLY THE CURRENT VOICE");
  assert.deepEqual(await q.stats(),{requested:2,contextCount:1,closes:[1],stops:[1,1],transcriptions:1,reports:0});
});
test("replacing the form with the receipt releases current hardware without uploading voice", async t => {
  const q=await website(t);
  await q.text.fill("Only this typed body is sent.");
  await begin(q); await q.feed(); await q.send.click();
  await q.page.getByText("BZ-FB-SYNTH").waitFor();
  assert.deepEqual(await q.stats(),{requested:1,contextCount:1,closes:[1],stops:[1],transcriptions:0,reports:1});
});
test("partial audio setup failure also releases the track and context", async t => {
  const q=await website(t);
  await q.page.evaluate(() => {
    window.AudioContext.prototype.createScriptProcessor = () => { throw new Error("Synthetic graph failure"); };
  });
  await q.mic.click(); await q.permission(0);
  assert.deepEqual(await q.stats(),{requested:1,contextCount:1,closes:[1],stops:[1],transcriptions:0,reports:0});
  assert.equal(await q.mic.getAttribute("aria-pressed"),"false");
});
