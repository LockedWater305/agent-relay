import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

// Run the shipped reply guard, not a copy of its classifier. No model,
// renderer, process control, or user files are involved.
const source = readFileSync(
  process.env.BZ_DEVICE_COPY_SERVER || new URL("../src/lib/buzzy/server.ts", import.meta.url),
  "utf8",
);
const slotStart = source.indexOf("function stripSlotMarkers(");
const slotEnd = source.indexOf("\n}\n", slotStart) + 2;
const guardStart = source.indexOf("  const CAPABILITY_LIE =");
const guardEnd = source.indexOf("  if (capabilityLieStripped) {\n    // Observable", guardStart);
const deliveryStart = source.indexOf("  // ── A claim of delivery must match a delivery", guardEnd);
const deliveryEnd = source.indexOf("  // ── Same voice", deliveryStart);
assert.ok(slotStart >= 0 && slotEnd > slotStart && guardStart >= 0 && guardEnd > guardStart);
assert.ok(deliveryStart > guardEnd && deliveryEnd > deliveryStart);
const slotCode = stripTypeScriptTypes(source.slice(slotStart, slotEnd));
const guardCode = stripTypeScriptTypes(source.slice(guardStart, guardEnd));
const deliveryCode = stripTypeScriptTypes(source.slice(deliveryStart, deliveryEnd));
const run = runInNewContext(`
  ${slotCode}
  (sanitizedReply, deliversThisTurn = false) => {
    const renderedImage = null, renderedAudio = null, artRefusal = null, musicRefusal = null;
    const musicConfigured = () => false, isMusicRequest = () => false;
    const message = "Make a report.", history = [];
    ${guardCode}
    ${deliveryCode}
    return { guardedReply, capabilityLieStripped, cleanReply };
  }
`, { console: { warn() {} } });

const fallback = "I have nothing to hand you from that turn.";
for (const [label, input, output = input, stripped = false] of [
  ["device limitation", "I can't write files on your device."],
  ["laptop plus available Library", "I can't write files on your laptop, but I can save a copy in the Library."],
  ["arbitrary paths", "I can't create files at arbitrary paths."],
  ["explicit home-relative path", "I can't write files to ~/Downloads."],
  ["explicit drive path", "I can't write files to C:\\Example\\Downloads."],
  ["filesystem scope", "I don't have filesystem access on this computer."],
  ["system process limitation", "I can't run OS commands."],
  ["two supported statements", "I can't write files on your device. I can save a Library copy."],
  ["bare false storage limitation", "I can't save files.", fallback, true],
  ["bare false missing tool", "I have no file-storage tool.", fallback, true],
  ["explicit Library limitation", "I can't save files in the Library.", fallback, true],
  ["direct BeeZilla Library limitation", "I can’t save to BeeZilla Library.", fallback, true],
  ["direct Library limitation still removed after an ordinary sentence",
    "Here is the draft. I can't save to the BeeZilla Library.", "Here is the draft.", true],
  ["Library limitation after a truthful device clause",
    "I can't write files on your device, but I can't save files in the Library.",
    "I can't write files on your device.", true],
  ["Library limitation before a truthful device clause",
    "I can't save to BeeZilla Library, but I can't write files on your device.",
    "I can't write files on your device.", true],
  ["Library limitation beside OS command scope",
    "I can't run OS commands and cannot save a copy in your BeeZilla Library.",
    "I can't run OS commands.", true],
  ["Library limitation separated by a semicolon",
    "I can’t save to BeeZilla Library; I can’t change files at arbitrary file paths.",
    "I can’t change files at arbitrary file paths.", true],
  ["one predicate with distinct device and Library destinations",
    "I can't save files on your device or in the Library.", "I can't save files on your device.", true],
  ["positive copy offer remains just an offer", "I can prepare a Library copy for you to download."],
  ["a device mention doesn't qualify a generic false file limitation",
    "I can't save files because your laptop is offline.", fallback, true],
  ["the new direct filter leaves an explicit temporary failure alone",
    "I can't save to BeeZilla Library right now because the service is offline."],
  ["an explicitly temporary files failure in your Library is not a capability denial",
    "I can't save files in your Library right now because the service is offline."],
  ["a quoted app error with curly punctuation isn't an assistant claim",
    "The old dialog said “I can’t save files”. Try reopening Settings."],
  ["vendor-editor limitations aren't BeeZilla capability claims",
    "There is no way to save state in the vendor's editor. Try exporting first."],
  ["plain reply unchanged", "Here are the two options. Pick whichever fits."],
  ["ordinary markers removed without swallowing the truthful sentence",
    "I can't write files on your device. [challenge: save a report]",
    "I can't write files on your device."],
]) {
  test(label, () => {
    const result = run(input);
    assert.equal(result.guardedReply, output);
    assert.equal(result.capabilityLieStripped, stripped);
    assert.equal(result.cleanReply, output);
  });
}

test("ordinary truthful limits plus a Library copy offer survive the final delivery guard", () => {
  for (const reply of [
    "I can save a copy in your Library.",
    "I can't write files on your device, but I can save a copy in your Library.",
    "I can save a copy in your Library. I can't run OS commands.",
    "I can save a copy in your Library if you want.",
    "If you want, I can put the draft in your Library next.",
  ]) {
    assert.equal(run(reply).cleanReply, reply);
  }
});

test("an unproduced Library success is corrected without losing the actual device limit", () => {
  const cases = [
    ["I can't run OS commands. I saved the file in your Library.", "I can't run OS commands."],
    ["I can't write files on your device, but I saved a copy in your Library.", "I can't write files on your device."],
  ];
  for (const [reply, limit] of cases) {
    assert.equal(run(reply).cleanReply, limit + " Nothing was saved to your BeeZilla Library on this turn.");
  }
});

test("a real Library result may still be announced; a fabricated result may not", () => {
  for (const reply of [
    "The document is in your Library.",
    "I've saved the document in your Library.",
    "It's in your Library.",
    "I saved it for you.",
    "Your file is saved and ready to download.",
    "I've saved “report.docx” in your Library.",
    "I've saved “report.docx” in your Library, and you can download it now.",
  ]) {
    assert.equal(run(reply, true).cleanReply, reply);
    assert.match(run(reply).cleanReply, /^I did not actually produce anything that turn/);
  }
  assert.match(run("I've saved the document in your Library; if you want, I can change the title.").cleanReply, /nothing was saved/);
});

test("a directly quoted filename is an object, not a report of someone else's claim", () => {
  const direct = "I can't run OS commands, but I've saved “report.docx” in your Library.";
  assert.equal(run(direct).cleanReply, "I can't run OS commands. Nothing was saved to your BeeZilla Library on this turn.");
  for (const reply of [
    "The old dialog said “I've saved 'report.docx' in your Library.”",
    "I can save “report.docx” in your Library if you want.",
    "I've saved “report.docx” in your Library previously.",
    "I've saved “report.docx” in your Library, according to the old dialog.",
  ]) assert.equal(run(reply).cleanReply, reply);
});
