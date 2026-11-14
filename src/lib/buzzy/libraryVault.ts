/** Local desktop Library history. Never reads paths or trusts renderer ownership. */
import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "../db";

export const VAULT_RECORD_BYTES = 8 * 1024 * 1024;
export const VAULT_REQUEST_BYTES = 9 * 1024 * 1024;
export const VAULT_BATCH_RECORDS = 50;
export const VAULT_PAGE_BYTES = 8 * 1024 * 1024;

export class LibraryVaultError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
export interface VaultDocument { name: string; md: string; createdAt?: number; updatedAt?: number }
export interface VaultInput { jobId: string; document: VaultDocument }
export interface VaultRecord extends VaultInput { id: string; hash: string }
interface StoredRow { id: string; record_hash: string; job_id: string; document: VaultDocument; result_code?: string }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
// JSONB cannot preserve NUL or invalid UTF-16. Refuse rather than replacing
// bytes or discarding a legacy record; the original origin copy stays intact.
function validText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
export function validateVaultBatch(body: unknown): Array<VaultInput & { hash: string; bytes: number }> {
  if (!object(body) || !exactKeys(body, ["records", "expectedStoreId", "expectedGeneration"]) || !Array.isArray(body.records) ||
      !body.records.length || body.records.length > VAULT_BATCH_RECORDS) {
    throw new LibraryVaultError("bad_vault_batch", "Send between 1 and 50 Library records; nothing was changed.");
  }
  if (typeof body.expectedStoreId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.expectedStoreId) ||
      typeof body.expectedGeneration !== "string" || !/^(?:0|[1-9]\d{0,18})$/.test(body.expectedGeneration) ||
      BigInt(body.expectedGeneration) > 9223372036854775807n) {
    throw new LibraryVaultError("bad_vault_store", "The Library store identity is invalid; originals were not removed.");
  }
  let total = 0;
  return body.records.map((value, index) => {
    if (!object(value) || !exactKeys(value, ["jobId", "document"]) ||
        !validText(value.jobId) || !value.jobId.length || value.jobId.length > 120 ||
        !object(value.document) || !exactKeys(value.document, ["name", "md", "createdAt", "updatedAt"]) ||
        !validText(value.document.name) || !value.document.name.length || value.document.name.length > 1024 ||
        !validText(value.document.md)) {
      throw new LibraryVaultError("bad_vault_record", `Library record ${index + 1} has unsupported fields or text. Its original copy was not removed.`);
    }
    const document: VaultDocument = { name: value.document.name, md: value.document.md };
    for (const key of ["createdAt", "updatedAt"] as const) {
      if (Object.prototype.hasOwnProperty.call(value.document, key)) {
        const timestamp = value.document[key];
        if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8.64e15) {
          throw new LibraryVaultError("bad_vault_record", `Library record ${index + 1} has an invalid timestamp. Its original copy was not removed.`);
        }
        document[key] = timestamp;
      }
    }
    const record: VaultInput = { jobId: value.jobId, document };
    const serialized = JSON.stringify(record);
    const bytes = Buffer.byteLength(serialized, "utf8");
    total += bytes;
    if (bytes > VAULT_RECORD_BYTES || total > VAULT_RECORD_BYTES) {
      throw new LibraryVaultError("vault_too_large", "This Library batch exceeds 8 MiB. Send smaller batches; originals were not removed.", 413);
    }
    return { ...record, hash: createHash("sha256").update(serialized).digest("hex"), bytes };
  });
}

/** Bound bytes while reading, not after allocating/parsing an unbounded body. */
export async function readVaultBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > VAULT_REQUEST_BYTES)) {
    throw new LibraryVaultError("vault_too_large", "The Library request is too large; originals were not removed.", 413);
  }
  if (!request.body) throw new LibraryVaultError("bad_vault_batch", "The Library request is empty.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > VAULT_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new LibraryVaultError("vault_too_large", "The Library request is too large; originals were not removed.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new LibraryVaultError("bad_vault_json", "The Library request is not valid UTF-8 JSON; originals were not removed."); }
}

function record(row: StoredRow): VaultRecord {
  return { id: String(row.id), hash: row.record_hash, jobId: row.job_id, document: row.document };
}

/** Stable, non-content identity retained across account-data deletion. */
export async function getVaultStoreId(sql: Sql): Promise<string> {
  const rows = await sql.query<{ store_id: string }>(`
    INSERT INTO buzzy_library_vault_store (singleton, store_id) VALUES (true, $1::uuid)
    ON CONFLICT (singleton) DO UPDATE SET singleton = true
    RETURNING store_id::text
  `, [randomUUID()]);
  if (!rows[0]?.store_id) throw new Error("Library store identity unavailable");
  return rows[0].store_id;
}

export async function getVaultMetadata(sql: Sql, userId: string) {
  const storeId = await getVaultStoreId(sql);
  const rows = await sql.query<{ generation: string }>(`
    INSERT INTO buzzy_library_vault_owner (user_id) VALUES ($1)
    ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
    RETURNING generation::text
  `, [userId]);
  if (!rows[0]?.generation) throw new Error("Library generation unavailable");
  return { storeId, generation: rows[0].generation };
}

export async function storeVaultBatch(sql: Sql, userId: string, body: unknown) {
  const validated = validateVaultBatch(body); // Entire batch before any SQL.
  const expected = body as { expectedStoreId: string; expectedGeneration: string };
  const unique = [...new Map(validated.map((item) => [item.hash, item])).values()];
  const input = unique.map((item) => ({ record_hash: item.hash, job_id: item.jobId, document: item.document, record_bytes: item.bytes }));
  // This invocation holds the same owner lock as account-data deletion. Its
  // commands obtain fresh snapshots after waiting; no stale import can revive
  // content after the deletion generation advances.
  const rows = await sql.query<StoredRow>(`
    SELECT * FROM buzzy_library_vault_import($1, $2::uuid, $3::bigint, $4::jsonb)
  `, [userId, expected.expectedStoreId, expected.expectedGeneration, JSON.stringify(input)]);
  if (rows[0]?.result_code === "vault_store_changed") {
    throw new LibraryVaultError("vault_store_changed", "The local Library store or deletion generation changed. Original copies were not removed; automatic migration was stopped.", 409);
  }
  if (rows[0]?.result_code === "vault_job_conflict") {
    throw new LibraryVaultError("vault_job_conflict", "A Library folder belongs to another account. Nothing in this batch was imported.", 409);
  }
  if (rows.length !== unique.length || rows.some((row) => row.result_code !== "stored")) {
    throw new Error("Library acknowledgment incomplete");
  }
  return { ok: true as const, storeId: expected.expectedStoreId, generation: expected.expectedGeneration, stored: rows.map(record), count: rows.length };
}

export function vaultPageOptions(url: string): { after: string; limit: number } {
  const query = new URL(url, "http://127.0.0.1").searchParams;
  const after = query.get("after") ?? "0";
  const rawLimit = query.get("limit") ?? "50";
  if (!/^(?:0|[1-9]\d{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n ||
      !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
    throw new LibraryVaultError("bad_vault_cursor", "Use a valid Library cursor and a page size between 1 and 50.");
  }
  return { after, limit: Number(rawLimit) };
}

export async function listVaultPage(sql: Sql, userId: string, options: { after: string; limit: number }) {
  const { storeId, generation } = await getVaultMetadata(sql, userId);
  // Page in SQL by both count and bytes. A maximum-size first record always
  // makes progress. IDs are text, never rounded through a JS Number.
  const rows = await sql.query<StoredRow>(`
    WITH candidates AS (
      SELECT id, record_hash, job_id, document, record_bytes
      FROM buzzy_library_vault WHERE user_id = $1 AND id > $2::bigint AND generation = $5::bigint
      ORDER BY id ASC LIMIT $3
    ), bounded AS (
      SELECT *, row_number() OVER (ORDER BY id) AS n,
        sum(record_bytes + 512) OVER (ORDER BY id) AS page_bytes FROM candidates
    )
    SELECT id::text, record_hash, job_id, document FROM bounded
    WHERE n = 1 OR page_bytes <= $4 ORDER BY bounded.id ASC
  `, [userId, options.after, options.limit, VAULT_PAGE_BYTES, generation]);
  const last = rows.length ? String(rows[rows.length - 1].id) : options.after;
  const more = await sql.query<{ present: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM buzzy_library_vault WHERE user_id = $1 AND id > $2::bigint AND generation = $3::bigint) AS present
  `, [userId, last, generation]);
  const current = await getVaultMetadata(sql, userId);
  if (current.generation !== generation || current.storeId !== storeId) {
    throw new LibraryVaultError("vault_store_changed", "Library history changed while loading. Reload before continuing.", 409);
  }
  const done = !more[0]?.present;
  return { ok: true as const, storeId, generation, records: rows.map(record), nextCursor: done ? null : last, done };
}
