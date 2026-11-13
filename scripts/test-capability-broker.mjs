#!/usr/bin/env node
// Tests for desktop/capability-broker.mjs. Fixtures live in fresh folders under os.tmpdir() and
// are removed afterwards. Race cases swap files for links by wrapping fs/promises calls, so the
// swap lands between the broker's check and its next system call.
// Run: node --test scripts/test-capability-broker.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBroker, ERROR_CODES } from "../desktop/capability-broker.mjs";

/** A fresh temp folder, resolved to its real path so expected paths compare exactly. */
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capability-broker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Asserts the promise rejects with exactly `code`, and that the code is a stable one. */
async function denied(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(ERROR_CODES.includes(err.code), `unstable error code "${err.code}": ${err.message}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

async function activeGrant(broker, root) {
  const { id } = await broker.grantFolder(root);
  broker.activate(id);
  return id;
}

/** Captures the rejection of a promise without asserting on it. */
async function rejection(promise) {
  return promise.then(
    () => null,
    (err) => err,
  );
}

test("grant, activate, list and read a text file", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "Docs");
  write(path.join(root, "notes", "hello.txt"), "héllo\n");
  const broker = createBroker();
  const grant = await broker.grantFolder(root, { label: "Docs" });
  assert.deepEqual(Object.keys(grant).sort(), ["createdAt", "id", "label", "root"]);
  assert.equal(grant.root, root);
  assert.equal(grant.label, "Docs");
  broker.activate(grant.id);
  const file = await broker.readFile(grant.id, "notes/hello.txt");
  assert.deepEqual(file, { path: "notes/hello.txt", bytes: 7, text: "héllo\n" });
  const [listed] = broker.list();
  assert.deepEqual(Object.keys(listed).sort(), [
    "active",
    "createdAt",
    "id",
    "label",
    "paused",
    "revoked",
    "root",
  ]);
  assert.equal(listed.active, true);
});

test("a new grant stays inactive until the session activates it", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "Docs");
  write(path.join(root, "a.txt"), "a");
  const broker = createBroker();
  const { id } = await broker.grantFolder(root);
  await denied(broker.readFile(id, "a.txt"), "inactive");
  await denied(broker.listDir(id), "inactive");
  await denied(broker.search(id, "a"), "inactive");
  assert.equal(broker.list()[0].active, false);
});

test("pause denies and resume allows", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "Docs");
  write(path.join(root, "a.txt"), "a");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  broker.pause(id);
  assert.equal(broker.list()[0].paused, true);
  await denied(broker.readFile(id, "a.txt"), "paused");
  await denied(broker.listDir(id), "paused");
  await denied(broker.search(id, "a"), "paused");
  broker.resume(id);
  assert.equal(broker.list()[0].paused, false);
  assert.equal((await broker.readFile(id, "a.txt")).text, "a");
});

test("revoke is final", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "Docs");
  write(path.join(root, "a.txt"), "a");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  broker.revoke(id);
  await denied(broker.readFile(id, "a.txt"), "revoked");
  assert.throws(() => broker.activate(id), { code: "revoked" });
  assert.throws(() => broker.resume(id), { code: "revoked" });
  assert.throws(() => broker.pause(id), { code: "revoked" });
  broker.revoke(id); // repeating a revoke is harmless
  const [listed] = broker.list();
  assert.equal(listed.revoked, true);
  assert.equal(listed.active, false);
  await denied(broker.readFile(id, "a.txt"), "revoked");
});

test("unknown or missing grant ids are not_granted", async () => {
  const broker = createBroker();
  await denied(broker.readFile("missing", "a.txt"), "not_granted");
  await denied(broker.readFile(undefined, "a.txt"), "not_granted");
  assert.throws(() => broker.pause("missing"), { code: "not_granted" });
  assert.throws(() => broker.revoke(42), { code: "not_granted" });
});

test("the filesystem root and the real home folder cannot be granted", async () => {
  const broker = createBroker();
  await denied(broker.grantFolder("/"), "root_refused");
  await denied(broker.grantFolder(os.homedir()), "root_refused");
  // The folder above home contains home, so it is refused as well.
  await denied(broker.grantFolder(path.dirname(os.homedir())), "root_refused");
  assert.deepEqual(broker.list(), []);
});

test("with HOME moved, home and the folders above it are refused and a folder inside is allowed", async (t) => {
  const base = sandbox(t);
  const fakeHome = path.join(base, "people", "ana");
  const documents = path.join(fakeHome, "Documents");
  fs.mkdirSync(documents, { recursive: true });
  const savedHome = process.env.HOME;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
  process.env.HOME = fakeHome;
  const broker = createBroker();
  await denied(broker.grantFolder(fakeHome), "root_refused");
  await denied(broker.grantFolder(path.join(base, "people")), "root_refused");
  await denied(broker.grantFolder(base), "root_refused");
  const grant = await broker.grantFolder(documents);
  assert.equal(grant.root, documents);
});

test("grantFolder rejects relative, missing, file and malformed choices", async (t) => {
  const base = sandbox(t);
  const file = path.join(base, "plain.txt");
  write(file, "x");
  const broker = createBroker();
  await denied(broker.grantFolder("relative/folder"), "bad_path");
  await denied(broker.grantFolder(""), "bad_path");
  await denied(broker.grantFolder(42), "bad_path");
  await denied(broker.grantFolder(path.join(base, "x\0y")), "bad_path");
  await denied(broker.grantFolder(path.join(base, "missing")), "not_found");
  await denied(broker.grantFolder(file), "not_directory");
  await denied(broker.grantFolder(base, { label: 7 }), "bad_argument");
  assert.deepEqual(broker.list(), []);
});

test("traversal, absolute, drive, UNC and NUL paths are refused before anything is joined", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "a.txt"), "a");
  write(path.join(base, "sibling", "x.txt"), "x");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const bad = [
    "../x",
    "a/../../x",
    "a/..",
    "..",
    "..\\x",
    "a\\..\\..\\x",
    "../sibling/x.txt",
    "/etc/passwd",
    "\\etc\\passwd",
    "\\\\server\\share\\x",
    "//server/share/x",
    "C:\\x",
    "c:/x",
    "C:x",
    "\\\\?\\C:\\x",
    "a\0b",
    42,
    null,
  ];
  for (const p of bad) {
    await denied(broker.readFile(id, p), "bad_path");
  }
  for (const p of bad) {
    await denied(broker.listDir(id, p), "bad_path");
  }
  // A harmless "." segment still reaches the file.
  assert.equal((await broker.readFile(id, "./a.txt")).text, "a");
});

test("a symlink inside the grant that points outside is refused and never followed", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  const outside = path.join(base, "outside");
  write(path.join(root, "ok.txt"), "fine");
  write(path.join(outside, "secret.txt"), "TOP-SECRET-VALUE");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
  fs.symlinkSync(outside, path.join(root, "leakdir"));
  const broker = createBroker();
  const id = await activeGrant(broker, root);

  await denied(broker.readFile(id, "leak.txt"), "symlink_escape");
  await denied(broker.readFile(id, "leakdir/secret.txt"), "symlink_escape");
  await denied(broker.listDir(id, "leakdir"), "symlink_escape");

  const listing = await broker.listDir(id);
  assert.deepEqual(listing.entries.map((e) => [e.name, e.type]), [
    ["leak.txt", "symlink"],
    ["leakdir", "symlink"],
    ["ok.txt", "file"],
  ]);
  const hidden = await broker.search(id, "secret");
  assert.deepEqual(hidden.matches, []);
  const links = await broker.search(id, "leak");
  assert.deepEqual(links.matches, [
    { path: "leak.txt", type: "symlink" },
    { path: "leakdir", type: "symlink" },
  ]);
  assert.ok(!JSON.stringify([listing, hidden, links]).includes("TOP-SECRET-VALUE"));
});

test("a symlink that points inside the grant reads through, is listed as a link and is not descended", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "real.txt"), "inside text");
  write(path.join(root, "dir", "inner.txt"), "inner");
  fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "alias.txt"));
  fs.symlinkSync(path.join(root, "dir"), path.join(root, "dirlink"));
  const broker = createBroker();
  const id = await activeGrant(broker, root);

  assert.equal((await broker.readFile(id, "alias.txt")).text, "inside text");
  const listing = await broker.listDir(id);
  assert.deepEqual(listing.entries.map((e) => [e.name, e.type]), [
    ["alias.txt", "symlink"],
    ["dir", "dir"],
    ["dirlink", "symlink"],
    ["real.txt", "file"],
  ]);
  await denied(broker.listDir(id, "dirlink"), "not_directory");
  await denied(broker.readFile(id, "dirlink"), "not_a_file");
  // Reading through an inside link is allowed; listing and search are not.
  assert.equal((await broker.readFile(id, "dirlink/inner.txt")).text, "inner");
  const hits = await broker.search(id, "inner");
  assert.deepEqual(hits.matches, [{ path: "dir/inner.txt", type: "file" }]);
});

test("a symlinked chosen folder grants its real target", async (t) => {
  const base = sandbox(t);
  const target = path.join(base, "real-folder");
  write(path.join(target, "a.txt"), "a");
  const link = path.join(base, "link-to-folder");
  fs.symlinkSync(target, link);
  const broker = createBroker();
  const grant = await broker.grantFolder(link);
  assert.equal(grant.root, target);
  assert.equal(broker.list()[0].root, target);
  broker.activate(grant.id);
  assert.equal((await broker.readFile(grant.id, "a.txt")).text, "a");
});

test("a sibling folder whose name starts with the grant name is outside the grant", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  const sibling = path.join(base, "grant-evil");
  write(path.join(root, "ok.txt"), "ok");
  write(path.join(sibling, "secret.txt"), "EVIL");
  fs.symlinkSync(sibling, path.join(root, "sneaky"));
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  // A string-prefix check would accept this: "/x/grant-evil/..." starts with "/x/grant".
  await denied(broker.readFile(id, "sneaky/secret.txt"), "symlink_escape");
  await denied(broker.readFile(id, "../grant-evil/secret.txt"), "bad_path");
  const listing = await broker.listDir(id);
  assert.ok(listing.entries.some((e) => e.name === "sneaky" && e.type === "symlink"));
});

test("a resolved path outside the grant with no link on the way reports outside_grant", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  const elsewhere = path.join(base, "elsewhere.txt");
  write(path.join(root, "a.txt"), "a");
  write(elsewhere, "E");
  const target = path.join(fs.realpathSync(root), "a.txt");
  const realRealpath = fsp.realpath;
  fsp.realpath = async (p, ...rest) =>
    p === target ? elsewhere : realRealpath.call(fsp, p, ...rest);
  try {
    const broker = createBroker();
    const id = await activeGrant(broker, root);
    await denied(broker.readFile(id, "a.txt"), "outside_grant");
  } finally {
    fsp.realpath = realRealpath;
  }
});

test("a granted folder that is moved, renamed or replaced is refused as stale", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "stale");
  write(path.join(root, "a.txt"), "old");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  fs.renameSync(root, path.join(base, "stale-moved"));
  await denied(broker.readFile(id, "a.txt"), "stale_grant");
  await denied(broker.listDir(id), "stale_grant");
  await denied(broker.search(id, "a"), "stale_grant");
  // A different folder put back at the same path is not the granted folder either.
  write(path.join(root, "a.txt"), "a different folder with the same name");
  await denied(broker.readFile(id, "a.txt"), "stale_grant");
  broker.revoke(id);
});

test("a file swapped for a link between the check and the open never yields the outside content", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  const secret = path.join(base, "outside", "secret.txt");
  write(path.join(root, "f.txt"), "inside");
  write(secret, "OUTSIDE-SECRET");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const target = path.join(fs.realpathSync(root), "f.txt");
  const realOpen = fsp.open;
  const flags = [];
  fsp.open = async (p, openFlags, ...rest) => {
    if (p === target) {
      flags.push(openFlags);
      fs.unlinkSync(p);
      fs.symlinkSync(secret, p);
    }
    return realOpen.call(fsp, p, openFlags, ...rest);
  };
  try {
    const error = await rejection(broker.readFile(id, "f.txt"));
    assert.ok(error, "a swapped file must not be read");
    assert.ok(["changed_during_read", "symlink_escape"].includes(error.code), error.code);
    assert.ok(!error.message.includes("OUTSIDE-SECRET"));
    assert.equal(flags.length, 1);
    if (fs.constants.O_NOFOLLOW !== undefined) {
      assert.notEqual(flags[0] & fs.constants.O_NOFOLLOW, 0, "the open must refuse a final link");
    }
  } finally {
    fsp.open = realOpen;
  }
});

test("a folder on the path swapped for a link during the open never yields the outside content", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  const outside = path.join(base, "outside");
  write(path.join(root, "sub", "f.txt"), "inside");
  write(path.join(outside, "f.txt"), "OUTSIDE-SECRET");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const real = fs.realpathSync(root);
  const target = path.join(real, "sub", "f.txt");
  const realOpen = fsp.open;
  fsp.open = async (p, ...rest) => {
    if (p === target) {
      fs.renameSync(path.join(real, "sub"), path.join(real, "sub-moved"));
      fs.symlinkSync(outside, path.join(real, "sub"));
    }
    return realOpen.call(fsp, p, ...rest);
  };
  try {
    const error = await rejection(broker.readFile(id, "sub/f.txt"));
    assert.ok(error, "a file behind a swapped folder must not be read");
    assert.ok(["changed_during_read", "symlink_escape"].includes(error.code), error.code);
  } finally {
    fsp.open = realOpen;
  }
});

test("a file replaced between open and fstat is refused by the descriptor check", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "f.txt"), "original");
  write(path.join(root, ".incoming"), "REPLACEMENT");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const real = fs.realpathSync(root);
  const target = path.join(real, "f.txt");
  const realOpen = fsp.open;
  fsp.open = async (p, ...rest) => {
    const handle = await realOpen.call(fsp, p, ...rest);
    if (p === target) fs.renameSync(path.join(real, ".incoming"), target);
    return handle;
  };
  try {
    await denied(broker.readFile(id, "f.txt"), "changed_during_read");
  } finally {
    fsp.open = realOpen;
  }
});

function listingTree(t) {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  const outside = path.join(base, "outside");
  write(path.join(root, "a", "x.txt"), "x");
  write(path.join(root, "b", "y.txt"), "y");
  write(path.join(outside, "outside-hit.txt"), "OUTSIDE");
  return { root, outside, real: fs.realpathSync(root) };
}

test("a folder swapped for a link during a listing is refused and nothing outside is returned", async (t) => {
  const { root, outside, real } = listingTree(t);
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const victim = path.join(real, "b");
  const realReaddir = fsp.readdir;
  fsp.readdir = async (p, ...rest) => {
    if (p === victim) {
      fs.renameSync(victim, `${victim}-moved`);
      fs.symlinkSync(outside, victim);
    }
    return realReaddir.call(fsp, p, ...rest);
  };
  try {
    await denied(broker.listDir(id, "b"), "changed_during_read");
  } finally {
    fsp.readdir = realReaddir;
  }
});

test("a folder replaced by a different folder during its own listing is refused", async (t) => {
  const { root, real } = listingTree(t);
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const victim = path.join(real, "b");
  const realReaddir = fsp.readdir;
  fsp.readdir = async (p, ...rest) => {
    if (p === victim) {
      fs.renameSync(victim, `${victim}-old`);
      write(path.join(victim, "replacement.txt"), "new folder");
    }
    return realReaddir.call(fsp, p, ...rest);
  };
  try {
    await denied(broker.listDir(id, "b"), "changed_during_read");
  } finally {
    fsp.readdir = realReaddir;
  }
});

test("an ancestor folder swapped for a link during a listing is refused", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  const outside = path.join(base, "outside");
  write(path.join(root, "a", "x", "inside.txt"), "inside");
  write(path.join(outside, "x", "OUTSIDE-NAME.txt"), "OUTSIDE");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const real = fs.realpathSync(root);
  const listed = path.join(real, "a", "x");
  const realReaddir = fsp.readdir;
  fsp.readdir = async (p, ...rest) => {
    if (p === listed) {
      fs.renameSync(path.join(real, "a"), path.join(real, "a-moved"));
      fs.symlinkSync(outside, path.join(real, "a"));
    }
    return realReaddir.call(fsp, p, ...rest);
  };
  try {
    const error = await rejection(broker.listDir(id, "a/x"));
    assert.ok(error, "a listing behind a swapped ancestor must be refused");
    assert.equal(error.code, "changed_during_read");
  } finally {
    fsp.readdir = realReaddir;
  }
});

test("an ancestor swapped for a link to the same folder under another name is refused during a listing", async (t) => {
  // The inode is unchanged, so only the path check (the listed folder must still resolve to
  // itself) can tell that the listing went through a link.
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "a", "x", "inside.txt"), "inside");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const real = fs.realpathSync(root);
  const listed = path.join(real, "a", "x");
  const realReaddir = fsp.readdir;
  fsp.readdir = async (p, ...rest) => {
    if (p === listed) {
      fs.renameSync(path.join(real, "a"), path.join(real, "a-moved"));
      fs.symlinkSync(path.join(real, "a-moved"), path.join(real, "a"));
    }
    return realReaddir.call(fsp, p, ...rest);
  };
  try {
    await denied(broker.listDir(id, "a/x"), "changed_during_read");
  } finally {
    fsp.readdir = realReaddir;
  }
});

test("a folder swapped for a link during a search is refused and nothing outside is returned", async (t) => {
  const { root, outside, real } = listingTree(t);
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const victim = path.join(real, "b");
  const realReaddir = fsp.readdir;
  fsp.readdir = async (p, ...rest) => {
    if (p === victim) {
      fs.renameSync(victim, `${victim}-moved`);
      fs.symlinkSync(outside, victim);
    }
    return realReaddir.call(fsp, p, ...rest);
  };
  try {
    await denied(broker.search(id, "hit"), "changed_during_read");
  } finally {
    fsp.readdir = realReaddir;
  }
});

test("a revoke or pause during an in-flight operation wins and the result is discarded", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "a", "hit.txt"), "hit");
  write(path.join(root, "a.txt"), "a");
  const broker = createBroker();

  const r1 = await activeGrant(broker, root);
  const p1 = broker.readFile(r1, "a.txt");
  broker.revoke(r1);
  await denied(p1, "superseded");

  const r2 = await activeGrant(broker, root);
  const p2 = broker.listDir(r2, "a");
  broker.pause(r2);
  await denied(p2, "superseded");

  const r3 = await activeGrant(broker, root);
  const p3 = broker.search(r3, "hit");
  broker.pause(r3);
  broker.resume(r3); // any state change counts, even one that ends where it started
  await denied(p3, "superseded");

  const r4 = await activeGrant(broker, root);
  const p4 = broker.readFile(r4, "a.txt");
  broker.pause(r4);
  broker.resume(r4);
  await denied(p4, "superseded");

  assert.equal((await broker.readFile(r4, "a.txt")).text, "a"); // a fresh operation still works
});

test("oversize, binary and non-UTF-8 files are refused with clear codes", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "big.txt"), "x".repeat(4096));
  write(path.join(root, "ok.txt"), "small");
  write(path.join(root, "binary.dat"), Buffer.from([0x41, 0x00, 0x42]));
  write(path.join(root, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  write(path.join(root, "empty.txt"), "");
  const broker = createBroker({ maxReadBytes: 1024 });
  const id = await activeGrant(broker, root);

  await denied(broker.readFile(id, "big.txt"), "too_large");
  // A caller may lower the cap, never raise it above the broker's maxReadBytes.
  await denied(broker.readFile(id, "big.txt", { maxBytes: 10_000_000 }), "too_large");
  await denied(broker.readFile(id, "ok.txt", { maxBytes: 4 }), "too_large");
  assert.equal((await broker.readFile(id, "ok.txt", { maxBytes: 5 })).text, "small");
  await denied(broker.readFile(id, "binary.dat"), "not_text");
  await denied(broker.readFile(id, "latin1.txt"), "not_text");
  assert.equal((await broker.readFile(id, "empty.txt")).text, "");
  await denied(broker.readFile(id, ""), "not_a_file");
  await denied(broker.readFile(id, "."), "not_a_file");
  await denied(broker.listDir(id, "ok.txt"), "not_directory");
  await denied(broker.readFile(id, "ok.txt", { maxBytes: -1 }), "bad_argument");
});

test("a named pipe is listed as other and refused as a file without blocking", { timeout: 10_000 }, async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  fs.mkdirSync(root);
  execFileSync("mkfifo", [path.join(root, "pipe")]);
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  await denied(broker.readFile(id, "pipe"), "not_a_file");
  const listing = await broker.listDir(id);
  assert.deepEqual(listing.entries, [{ name: "pipe", path: "pipe", type: "other" }]);
});

test("search matches names case-insensitively and stops at its limits, saying so", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  for (let i = 1; i <= 10; i += 1) write(path.join(root, `hit-${i}.txt`), "x");
  write(path.join(root, "other.txt"), "x");
  write(path.join(root, "sub", "deep", "HIT-deep.txt"), "x");
  const broker = createBroker();
  const id = await activeGrant(broker, root);

  const all = await broker.search(id, "HIT", { limit: 50 });
  assert.equal(all.matches.length, 11);
  assert.equal(all.truncated, false);
  assert.equal(all.stoppedBy, null);

  const limited = await broker.search(id, "hit", { limit: 3 });
  assert.equal(limited.matches.length, 3);
  assert.equal(limited.truncated, true);
  assert.equal(limited.stoppedBy, "limit");

  // The root holds 12 entries, and "sub" holds two more (deep and HIT-deep.txt): 14 in all.
  const exact = await broker.search(id, "zzz", { maxFiles: 14 });
  assert.equal(exact.scanned, 14);
  assert.equal(exact.truncated, false);
  const capped = await broker.search(id, "zzz", { maxFiles: 13 });
  assert.equal(capped.scanned, 13);
  assert.equal(capped.stoppedBy, "maxFiles");
  assert.equal(capped.truncated, true);

  await denied(broker.search(id, ""), "bad_argument");
  await denied(broker.search(id, "x", { limit: 0 }), "bad_argument");
});

test("search walks depth-first in name order", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "a", "hit.txt"), "x");
  write(path.join(root, "a", "sub", "hit.txt"), "x");
  write(path.join(root, "b", "hit.txt"), "x");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  const result = await broker.search(id, "hit");
  assert.deepEqual(
    result.matches.map((m) => m.path),
    ["a/hit.txt", "a/sub/hit.txt", "b/hit.txt"],
  );
});

const cannotDenyReads = typeof process.getuid !== "function" || process.getuid() === 0;

test("an unreadable folder is skipped and counted instead of failing the search", { skip: cannotDenyReads ? "needs a non-root POSIX user" : false }, async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "locked", "hit.txt"), "x");
  write(path.join(root, "open", "hit.txt"), "y");
  const locked = path.join(root, "locked");
  const broker = createBroker();
  const id = await activeGrant(broker, root);
  fs.chmodSync(locked, 0o000);
  try {
    const result = await broker.search(id, "hit");
    assert.deepEqual(result.matches.map((m) => m.path), ["open/hit.txt"]);
    assert.equal(result.skipped, 1);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test("the activity log records allowed and denied operations, mirrors onActivity and keeps 500", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "a.txt"), "a");
  const seen = [];
  let clock = 1000;
  const broker = createBroker({ now: () => (clock += 1), onActivity: (entry) => seen.push(entry) });
  const { id } = await broker.grantFolder(root);
  await denied(broker.readFile(id, "a.txt"), "inactive");
  broker.activate(id);
  await broker.readFile(id, "a.txt");
  await denied(broker.readFile(id, "../x"), "bad_path");
  await denied(broker.readFile("missing", "a.txt"), "not_granted");
  await broker.search(id, "a");

  const log = broker.activity();
  assert.deepEqual(log.map((e) => [e.op, e.ok, e.reason]), [
    ["grant", true, null],
    ["readFile", false, "inactive"],
    ["activate", true, null],
    ["readFile", true, null],
    ["readFile", false, "bad_path"],
    ["readFile", false, "not_granted"],
    ["search", true, null],
  ]);
  assert.equal(log[1].grantId, id);
  assert.equal(log[1].path, "a.txt");
  assert.equal(log[4].path, "../x");
  assert.equal(log[5].grantId, null);
  assert.equal(log[6].path, null);
  assert.ok(log.every((e, i) => i === 0 || e.at > log[i - 1].at), "timestamps come from now()");
  assert.deepEqual(seen, log);

  for (let i = 0; i < 600; i += 1) await denied(broker.readFile("missing", "x"), "not_granted");
  assert.equal(broker.activity().length, 500);
  assert.equal(seen.length, log.length + 600);
});

test("a listener that throws does not change the outcome of an operation", async (t) => {
  const base = sandbox(t);
  const root = path.join(base, "grant");
  write(path.join(root, "a.txt"), "a");
  const broker = createBroker({
    onActivity: () => {
      throw new Error("panel crashed");
    },
  });
  const id = await activeGrant(broker, root);
  assert.equal((await broker.readFile(id, "a.txt")).text, "a");
});

test("the broker exposes no write operation", () => {
  const broker = createBroker();
  assert.deepEqual(Object.keys(broker).sort(), [
    "activate",
    "activity",
    "grantFolder",
    "list",
    "listDir",
    "pause",
    "readFile",
    "resume",
    "revoke",
    "search",
  ]);
});

test("createBroker rejects bad options", () => {
  assert.throws(() => createBroker({ maxReadBytes: 0 }), { code: "bad_argument" });
  assert.throws(() => createBroker({ maxReadBytes: 1.5 }), { code: "bad_argument" });
  assert.throws(() => createBroker({ now: 5 }), { code: "bad_argument" });
  assert.throws(() => createBroker({ onActivity: "log" }), { code: "bad_argument" });
});
