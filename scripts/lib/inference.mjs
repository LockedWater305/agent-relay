/**
 * Inference credentials for a local install.
 *
 * Two providers, one shape:
 *   - "beezilla" — our inference, via a device-scoped token minted against the
 *     owner's account (mint endpoint lands in s6b; the store is ready for it).
 *   - "byok" — the owner's own provider key, base URL and model.
 *
 * The key is written through an injected `encrypt`/`decrypt` pair. Electron
 * passes `safeStorage` (DPAPI on Windows); the CLI, which has no OS keychain
 * binding, stores 0600 and reports `encrypted: false` so `doctor` can say so out
 * loud instead of implying protection it does not have.
 *
 * Managed tokens are SHORT-LIVED by design (a mint-proxy issues scoped tokens,
 * never a shared key), so the store records `expiresAt`. An expired managed
 * token is a session problem, not a bad credential: it must say "reconnect",
 * not "invalid API key", and it must fail before spending a request.
 *
 * Precedence: explicit environment always wins. A desktop user who exported
 * BZ_CHAT_KEY for a test must not be silently overridden by a stale store file.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export const STORE_FILE = "inference.json";

const PROVIDERS = new Set(["beezilla", "byok"]);

/** Defaults for OUR inference, so a managed install never asks for a base URL. */
export const MANAGED_DEFAULTS = {
  baseUrl: "https://inference-api.nousresearch.com/v1",
};

export function storePath(dataDir) {
  return join(dataDir, STORE_FILE);
}

const validConnection = (id) => typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);

// undefined means absent; null means we cannot safely read the record.
function readCredentialRecord(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(storePath(dataDir), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch (error) {
    return error?.code === "ENOENT" ? undefined : null;
  }
}

function connectionId(raw) {
  if (raw === null) return null;
  if (!raw || !Object.hasOwn(raw, "managedConnectionId")) return undefined;
  return validConnection(raw.managedConnectionId) ? raw.managedConnectionId : null;
}

// The pairing marker is non-secret; reading it does not decrypt either key.
export function managedSearchConnection(dataDir) {
  return connectionId(readCredentialRecord(dataDir));
}

export function hasRemovableInference(dataDir) {
  const raw = readCredentialRecord(dataDir);
  return raw !== undefined && !(raw && validConnection(raw.managedConnectionId)
    && Object.keys(raw).every((key) => key === "managedConnectionId" || key === "connectedOwner"));
}

function ownerDisplay(profile) {
  const email = typeof profile?.email === "string" ? profile.email.trim() : "";
  if (!email) return null;
  return { name: typeof profile.name === "string" ? profile.name.trim() : "", email };
}

function protectConnectedOwner(profile, cipher, managedConnectionId) {
  const display = ownerDisplay(profile);
  if (!display || !cipher.encryptOwner) return null;
  try {
    const encrypted = Buffer.from(cipher.encryptOwner(JSON.stringify({ ...display, managedConnectionId })));
    return encrypted.length ? encrypted.toString("base64") : null;
  } catch {
    // Optional profile must not prevent a valid credential commit. Never write
    // plaintext or leave an old connected profile in place instead.
    return null;
  }
}

// Internal desktop presentation only, not used by Settings status or CLI.
// undefined permits an existing, unmodified legacy sidecar. null is deliberate
// fallback: unavailable, untrusted, or a new connection with no usable profile.
export function loadConnectedOwner(dataDir, cipher = {}) {
  const raw = readCredentialRecord(dataDir);
  const id = connectionId(raw);
  if (id === null) return null;
  if (!raw || !Object.hasOwn(raw, "connectedOwner")) return undefined;
  if (!id || typeof raw.connectedOwner !== "string" || !raw.connectedOwner || !cipher.decrypt) return null;
  try {
    const display = JSON.parse(cipher.decrypt(Buffer.from(raw.connectedOwner, "base64")));
    return display?.managedConnectionId === id ? ownerDisplay(display) : null;
  } catch {
    return null;
  }
}

function preserveConnectedOwner(raw, id) {
  if (id === null) return { connectedOwner: null };
  return raw && Object.hasOwn(raw, "connectedOwner")
    ? { connectedOwner: id && typeof raw.connectedOwner === "string" ? raw.connectedOwner : null }
    : {};
}

export function writeCredentialRecord(file, value) {
  // A failed encryption/write/rename must not half-adopt a connection.
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* private staging file */ }
  }
}

/**
 * @param {string} dataDir
 * @param {{ encrypt?: (s: string) => Buffer|string, decrypt?: (v: Buffer|string) => string }} cipher
 * @returns {{ provider: string, baseUrl: string, model: string, key: string, encrypted: boolean } | null}
 */
export function loadInference(dataDir, cipher = {}) {
  const file = storePath(dataDir);
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!raw?.keyCipher) return null;

  let key;
  try {
    const stored = raw.encrypted
      ? Buffer.from(raw.keyCipher, "base64")
      : raw.keyCipher;
    key = raw.encrypted
      ? cipher.decrypt
        ? cipher.decrypt(stored)
        : ""
      : stored;
  } catch {
    return null;
  }
  // A store we cannot decrypt is not a key we may guess at.
  if (!key) return null;

  return {
    provider: PROVIDERS.has(raw.provider) ? raw.provider : "byok",
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    model: typeof raw.model === "string" ? raw.model : "",
    key,
    encrypted: Boolean(raw.encrypted),
    updatedAt: raw.updatedAt ?? null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
  };
}

/** True when a managed token carries an expiry that has passed. */
export function isExpired(cred, now = Date.now()) {
  if (!cred?.expiresAt) return false;
  const at = Date.parse(cred.expiresAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * @param {string} dataDir
 * @param {{ provider: string, key: string, baseUrl?: string, model?: string }} cfg
 * @param {{ encrypt?: (s: string) => Buffer|string, encryptOwner?: (s: string) => Buffer|string }} cipher
 * @param {{connectedOwner?: {name?: string, email?: string}|null}} adoption Internal Connect metadata
 */
export function saveInference(dataDir, cfg, cipher = {}, adoption = {}) {
  if (!PROVIDERS.has(cfg.provider)) throw new Error(`unknown provider: ${cfg.provider}`);
  const key = (cfg.key ?? "").trim();
  if (!key) throw new Error("a key is required");

  const encrypted = Boolean(cipher.encrypt);
  const keyCipher = encrypted
    ? Buffer.from(cipher.encrypt(key)).toString("base64")
    : key;

  const baseUrl = (cfg.baseUrl ?? "").trim();
  const prior = readCredentialRecord(dataDir);
  const priorConnection = connectionId(prior);
  const managedConnectionId = cfg.provider === "beezilla" || priorConnection === null
    ? randomUUID()
    : priorConnection;
  const payload = {
    provider: cfg.provider,
    baseUrl: baseUrl || (cfg.provider === "beezilla" ? MANAGED_DEFAULTS.baseUrl : ""),
    expiresAt: (cfg.expiresAt ?? "").trim() || null,
    model: (cfg.model ?? "").trim(),
    encrypted,
    keyCipher,
    updatedAt: new Date().toISOString(),
    ...(managedConnectionId ? { managedConnectionId } : {}),
    ...(cfg.provider === "beezilla"
      ? { connectedOwner: protectConnectedOwner(adoption.connectedOwner, cipher, managedConnectionId) }
      : preserveConnectedOwner(prior, priorConnection)),
  };
  // Connection generation, credential, and display disposition become visible
  // together. No post-commit profile write can leave another account displayed.
  writeCredentialRecord(storePath(dataDir), payload);
  const { connectedOwner: _display, ...credential } = payload;
  return { ...credential, keyCipher: undefined };
}

export function clearInference(dataDir) {
  const raw = readCredentialRecord(dataDir);
  const id = connectionId(raw);
  // Removing inference does not unlink the connected profile or reactivate an
  // unpaired legacy search token. An old unmarked installation stays legacy.
  if (id !== undefined) writeCredentialRecord(storePath(dataDir), {
    managedConnectionId: id ?? randomUUID(), ...preserveConnectedOwner(raw, id),
  });
  else if (raw && Object.hasOwn(raw, "connectedOwner")) {
    writeCredentialRecord(storePath(dataDir), { managedConnectionId: randomUUID(), connectedOwner: null });
  } else rmSync(storePath(dataDir), { force: true });
}

/** Never let a key reach a log line, an error message or a `--show` output. */
export function redactKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}…${key.slice(-4)} (${key.length} chars)`;
}

/**
 * Resolve what the runtime should use. Explicit env wins over the store, and the
 * store supplies only the fields env did not set.
 */
export function resolveInference(dataDir, cipher = {}) {
  const stored = loadInference(dataDir, cipher);
  const envKey = (process.env.BZ_CHAT_KEY ?? "").trim();
  const envBase = (process.env.BZ_CHAT_BASE_URL ?? "").trim();
  const envModel = (process.env.BZ_CHAT_MODEL ?? "").trim();

  if (envKey) {
    return {
      source: "env",
      provider: "env",
      key: envKey,
      baseUrl: envBase || stored?.baseUrl || "",
      model: envModel || stored?.model || "",
      encrypted: null,
    };
  }
  if (stored?.key) {
    return {
      source: "store",
      provider: stored.provider,
      key: stored.key,
      baseUrl: envBase || stored.baseUrl,
      model: envModel || stored.model,
      encrypted: stored.encrypted,
      expiresAt: stored.expiresAt ?? null,
      expired: isExpired(stored),
    };
  }
  return null;
}
