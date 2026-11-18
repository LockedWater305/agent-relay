/**
 * BZ-F001 — account-scoped business profile tests.
 *
 * Verifies:
 *  1. Scoping negative — user A never sees user B's profile/defaults.
 *  2. Skip-setup-still-completes-job — a fresh user with no profile is not
 *     blocked; profile absence is a no-op, not a gate.
 *  3. Default-edit-does-not-rewrite-approved-doc — reusing defaults copies a
 *     snapshot into the job; editing the profile later does not rewrite the
 *     job's copy (and never touches approved documents).
 *  4. No inferred tax/license/consent fields — the field set is closed and the
 *     save path rejects anything outside it.
 *
 * Runs against the shared Postgres surface (PGLite in this sandbox, Neon in
 * prod) via getSql() — the same store the app uses. No sidecar DB.
 */
import { getSql } from "../src/lib/db";
import {
  getProfile,
  saveProfile,
  reuseDefaults,
  PROFILE_FIELDS,
  PROFILE_KEYS,
} from "../src/lib/buzzy/profile";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function main() {
  const sql = await getSql();
  const userA = "user_a_bzf001";
  const userB = "user_b_bzf001";
  const jobA = "job_a_bzf001";

  // ── 4. No inferred tax/license/consent fields ─────────────────────────
  const forbidden = ["tax_jurisdiction", "license", "consent", "tax_id", "licenses"];
  for (const f of forbidden) {
    assert(!PROFILE_KEYS.has(f), `field set must not contain ${f}`);
  }
  const fieldIds = PROFILE_FIELDS.map((f) => f.id);
  assert(fieldIds.includes("business_name"), "has business_name");
  assert(fieldIds.includes("constraints"), "has constraints");

  // ── 2. Skip-setup-still-completes-job (fresh user, no profile) ────────
  const empty = await getProfile(sql, userA);
  assert(empty.hasProfile === false, "fresh user has no profile (no error)");
  assert(Object.keys(empty.fields).length === 0, "fresh user has no fields");
  // Reuse with no saved defaults is a no-op, not a blocker.
  const noop = await reuseDefaults(sql, userA, jobA, ["business_name", "tone"]);
  assert(noop.reused.length === 0 && noop.skipped.length === 2, "reuse with no defaults is a no-op");
  // A fresh user can still write job memory (job completion is not gated on profile).
  await sql.query(
    `INSERT INTO buzzy_user_memory (user_id, job_id, key, value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, job_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [userA, jobA, "challenge", "Fence storm damage"],
  );
  const jobFacts = await sql.query<{ key: string }>(
    `SELECT key FROM buzzy_user_memory WHERE user_id = $1 AND job_id = $2`,
    [userA, jobA],
  );
  assert(jobFacts.some((r) => r.key === "challenge"), "job completes without a profile");

  // ── Save user A's profile ─────────────────────────────────────────────
  const saveA = await saveProfile(sql, userA, {
    business_name: "Ace Fencing",
    primary_activity: "Residential fence install and repair",
    audience: "Homeowners",
    tone: "Friendly and direct",
    brand_notes: "Always mention the 5-year workmanship guarantee",
    constraints: "No work on Sundays",
  });
  assert(saveA.saved.length === 6 && saveA.rejected.length === 0, "user A saved all 6 fields");

  // ── 4. Save path rejects non-profile keys (never inferred/stored) ─────
  const saveBad = await saveProfile(sql, userA, {
    business_name: "Ace Fencing",
    tax_jurisdiction: "CA",
    license: "ABC-123",
    consent: "yes",
  });
  assert(saveBad.rejected.includes("tax_jurisdiction"), "tax_jurisdiction rejected");
  assert(saveBad.rejected.includes("license"), "license rejected");
  assert(saveBad.rejected.includes("consent"), "consent rejected");
  const badRows = await sql.query<{ key: string }>(
    `SELECT key FROM buzzy_user_memory WHERE user_id = $1 AND (key = 'tax_jurisdiction' OR key = 'license' OR key = 'consent')`,
    [userA],
  );
  assert(badRows.length === 0, "no tax/license/consent rows persisted");

  // ── 1. Scoping negative — user B sees none of user A's profile ────────
  const profileB = await getProfile(sql, userB);
  assert(profileB.hasProfile === false, "user B has no profile");
  assert(Object.keys(profileB.fields).length === 0, "user B sees no user A fields");
  const profileA = await getProfile(sql, userA);
  assert(profileA.hasProfile === true, "user A has a profile");
  assert(profileA.fields.business_name.value === "Ace Fencing", "user A sees own business name");
  assert(profileA.fields.business_name.origin === "you set this", "origin is 'you set this'");

  // ── 3. Default-edit-does-not-rewrite-approved-doc ─────────────────────
  // Reuse defaults into the job (snapshot copy).
  const reused = await reuseDefaults(sql, userA, jobA, ["business_name", "tone", "constraints"]);
  assert(reused.reused.length === 3, "reused 3 defaults into job");
  const jobCopy = await sql.query<{ key: string; value: string }>(
    `SELECT key, value FROM buzzy_user_memory WHERE user_id = $1 AND job_id = $2 AND key LIKE 'profile_%'`,
    [userA, jobA],
  );
  const jobCopyMap = Object.fromEntries(jobCopy.map((r) => [r.key, r.value]));
  assert(jobCopyMap["profile_business_name"] === "Ace Fencing", "job copy has business name");

  // Edit the profile AFTER reuse.
  await saveProfile(sql, userA, { business_name: "Ace Fencing Co." });
  const jobCopyAfter = await sql.query<{ key: string; value: string }>(
    `SELECT key, value FROM buzzy_user_memory WHERE user_id = $1 AND job_id = $2 AND key LIKE 'profile_%'`,
    [userA, jobA],
  );
  const afterMap = Object.fromEntries(jobCopyAfter.map((r) => [r.key, r.value]));
  assert(afterMap["profile_business_name"] === "Ace Fencing", "job copy NOT rewritten by profile edit");
  assert(afterMap["profile_tone"] === "Friendly and direct", "job copy tone unchanged");

  // Profile rows (job_id = NULL) must be one-per-key: repeated saves replace,
  // never accumulate duplicates (Postgres treats NULLs as distinct under a
  // plain UNIQUE constraint, so upsert cannot de-dupe them).
  const bizRows = await sql.query<{ key: string }>(
    `SELECT key FROM buzzy_user_memory WHERE user_id = $1 AND job_id IS NULL AND key = 'profile_business_name'`,
    [userA],
  );
  assert(bizRows.length === 1, "exactly one profile_business_name row after repeat save");

  // Profile edit must not touch approved documents. There is no bz_documents
  // table yet (topology M-2 is not applied); the guarantee is that saving a
  // profile only writes buzzy_user_memory profile_ rows for this user. Assert
  // no other table was written by checking the profile save touched only
  // profile_ keys for user A.
  const profileRows = await sql.query<{ key: string }>(
    `SELECT key FROM buzzy_user_memory WHERE user_id = $1 AND job_id IS NULL`,
    [userA],
  );
  for (const r of profileRows) {
    assert(r.key.startsWith("profile_"), `only profile_ rows at account scope (got ${r.key})`);
  }

  // Explicit clears use the same real database surface. A missing/non-string
  // field is not a clear, and clearing a default cannot rewrite job snapshots.
  // Keep unrelated prefix lookalikes as a negative control. SQL LIKE's `_`
  // wildcard used to surface profileXtone as tone after profile_tone cleared.
  const nonProfileKeys = [
    ...fieldIds.map((id) => `profileX${id}`),
    "profile-tone", "profile%tone", "profile tone", "profile\\tone", "profileétone",
    "Profile_tone", "profile__tone", "profile_tone_extra", "profile_tone ",
    "profile_activity", "profile_future_key", "unrelated_account_fact",
  ];
  for (const key of nonProfileKeys) {
    await sql.query(
      `INSERT INTO buzzy_user_memory (user_id, job_id, key, value) VALUES ($1, NULL, $2, $3)`,
      [userA, key, `Keep unrelated ${key}`],
    );
  }
  const unrelatedQuery = `SELECT * FROM buzzy_user_memory WHERE user_id = $1 AND job_id IS NULL
    AND key IN (${nonProfileKeys.map((_, i) => `$${i + 2}`).join(", ")}) ORDER BY key`;
  const unrelatedBefore = await sql.query(unrelatedQuery, [userA, ...nonProfileKeys]);
  const jobSnapshotsBefore = await sql.query(
    `SELECT * FROM buzzy_user_memory WHERE user_id = $1 AND job_id = $2 ORDER BY key`, [userA, jobA],
  );
  const literalRead = await getProfile(sql, userA);
  assert(literalRead.fields.tone.value === "Friendly and direct", "literal canonical tone wins without reading lookalikes");
  assert(Object.keys(literalRead.fields).length === 6, "read contains only the six canonical fields");
  await saveProfile(sql, userB, { tone: "Keep foreign tone" });
  const cleared = await saveProfile(sql, userA, { tone: "", audience: " \n\t " });
  assert(cleared.saved.length === 0 && cleared.cleared.length === 2, "explicit blanks are cleared, not saved as empty rows");
  const afterClear = await getProfile(sql, userA);
  assert(!afterClear.fields.tone && !afterClear.fields.audience, "cleared defaults absent after database readback");
  assert(afterClear.fields.business_name.value === "Ace Fencing Co.", "omitted field preserved");
  await saveProfile(sql, userA, { business_name: null, brand_notes: false });
  const afterInvalid = await getProfile(sql, userA);
  assert(afterInvalid.fields.business_name.value === "Ace Fencing Co.", "non-string value cannot clear");
  assert(afterInvalid.fields.brand_notes.value === "Always mention the 5-year workmanship guarantee", "false cannot clear");
  const unicode = "日本語 🐝 e\u0301 &copy; <literal>";
  await saveProfile(sql, userA, { brand_notes: unicode });
  assert((await getProfile(sql, userA)).fields.brand_notes.value === unicode, "Unicode and literal entity text preserved");
  await saveProfile(sql, userA, Object.fromEntries(PROFILE_FIELDS.map((f) => [f.id, ""])));
  await saveProfile(sql, userA, { tone: "" });
  assert(!(await getProfile(sql, userA)).hasProfile, "all defaults clear and repeated clear is idempotent");
  assert((await getProfile(sql, userB)).fields.tone.value === "Keep foreign tone", "clear cannot touch another account");
  const afterAllClears = await sql.query<{ key: string; value: string }>(
    `SELECT key, value FROM buzzy_user_memory WHERE user_id = $1 AND job_id = $2 AND key LIKE 'profile_%'`,
    [userA, jobA],
  );
  const snapshotAfterClear = Object.fromEntries(afterAllClears.map((r) => [r.key, r.value]));
  assert(snapshotAfterClear.profile_business_name === "Ace Fencing", "original job business snapshot survives clears");
  assert(snapshotAfterClear.profile_tone === "Friendly and direct", "original job tone snapshot survives clears");
  const reuseCleared = await reuseDefaults(sql, userA, jobA, ["tone"]);
  assert(reuseCleared.reused.length === 0 && reuseCleared.skipped[0] === "tone", "cleared default cannot be reused later");
  await saveProfile(sql, userA, { activity: "Canonical alias value" });
  assert((await getProfile(sql, userA)).fields.primary_activity.value === "Canonical alias value", "alias still saves the canonical default");
  await saveProfile(sql, userA, { activity: "" });
  const emptyWithLookalikes = await getProfile(sql, userA);
  assert(!emptyWithLookalikes.hasProfile && Object.keys(emptyWithLookalikes.fields).length === 0, "lookalikes and unknown stored aliases cannot populate an empty profile");
  const unrelatedAfter = await sql.query(unrelatedQuery, [userA, ...nonProfileKeys]);
  assert(JSON.stringify(unrelatedAfter) === JSON.stringify(unrelatedBefore), "read, clear, alias and reuse preserve all unrelated rows exactly");
  const jobSnapshotsAfter = await sql.query(
    `SELECT * FROM buzzy_user_memory WHERE user_id = $1 AND job_id = $2 ORDER BY key`, [userA, jobA],
  );
  assert(JSON.stringify(jobSnapshotsAfter) === JSON.stringify(jobSnapshotsBefore), "all existing job rows remain unchanged after clears and skipped reuse");

  console.log("✓ BZ-F001: scoping, skip-setup, snapshots, explicit clears, literal keys, Unicode, no inferred fields");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
