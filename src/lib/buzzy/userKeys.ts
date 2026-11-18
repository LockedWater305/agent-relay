/**
 * The person's own AI key, in the cloud version too.
 *
 * Owner, 2026-11-18: "Even on the cloud mode, I need to be able to put in my own API
 * key." A key is saved per account, sealed with AES-256-GCM, and used for that
 * account's chat turns through withLlmOverride() (llm.ts). The page never gets the
 * key back: it sees only the provider address, the model and the last four
 * characters, so a stolen page or log line cannot leak it.
 *
 * Any OpenAI-compatible endpoint works (OpenRouter, OpenAI, Together, Groq, a
 * self-hosted server…). Only https addresses are accepted, plus localhost for a
 * desktop runtime — a key must never travel in clear text.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";
import type { LlmOverride } from "./llm";
import { cleanBaseUrl, resolvesPublic } from "./providerTransport";
export { cleanBaseUrl, isPrivateHost, resolvesPublic } from "./providerTransport";

/** Ready-made addresses for the common providers; "custom" takes any https URL. */
export const KEY_PROVIDERS: Record<string, { label: string; baseUrl: string }> = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  together: { label: "Together", baseUrl: "https://api.together.xyz/v1" },
};

function sealKey(): Buffer {
  const raw =
    process.env.BZ_KEY_SEAL_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    "beezilla-dev-key-seal-not-for-prod";
  return createHash("sha256").update("bz-user-ai-key:" + raw, "utf8").digest();
}

/** Seal a secret. Format: v1.<iv>.<tag>.<ciphertext>, base64url. */
export function sealSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(), iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Open a sealed secret, or null when it is missing, tampered with or sealed elsewhere. */
export function openSecret(sealed: string | null | undefined): string | null {
  if (!sealed || !sealed.startsWith("v1.")) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(parts[1]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** What the page may see about a saved key. Never the key itself. */
export interface KeySummary {
  saved: boolean;
  provider?: string;
  baseUrl?: string;
  model?: string | null;
  hint?: string;
  updatedAt?: string;
}

function providerOf(baseUrl: string): string {
  for (const [id, p] of Object.entries(KEY_PROVIDERS)) if (p.baseUrl === baseUrl) return id;
  return "custom";
}

export async function keySummary(sql: Sql, userId: string): Promise<KeySummary> {
  const rows = await sql`
    SELECT base_url, model, key_hint, updated_at FROM buzzy_user_ai_keys WHERE user_id = ${userId}`;
  const r = rows[0];
  if (!r) return { saved: false };
  const baseUrl = String(r.base_url);
  return {
    saved: true,
    provider: providerOf(baseUrl),
    baseUrl,
    model: r.model ? String(r.model) : null,
    hint: String(r.key_hint),
    updatedAt: r.updated_at ? new Date(String(r.updated_at)).toISOString() : undefined,
  };
}

export type SaveKeyResult = { ok: true; summary: KeySummary } | { ok: false; error: string; code: string };

/** Save (or replace) the person's key. `provider` picks a ready address; "custom" needs baseUrl. */
export async function saveKey(
  sql: Sql,
  userId: string,
  input: { provider?: unknown; baseUrl?: unknown; apiKey?: unknown; model?: unknown },
): Promise<SaveKeyResult> {
  const provider = String(input.provider ?? "openrouter");
  const chosen = KEY_PROVIDERS[provider];
  const baseUrl = chosen ? chosen.baseUrl : cleanBaseUrl(input.baseUrl);
  if (!baseUrl) return { ok: false, code: "bad_url", error: "That address can't be used. It has to start with https:// and be a public address." };
  if (!(await resolvesPublic(baseUrl))) {
    return { ok: false, code: "bad_url", error: "That address can't be reached from BeeZilla, or it points inside a private network." };
  }
  const apiKey = String(input.apiKey ?? "").trim();
  if (apiKey.length < 8 || apiKey.length > 400 || /\s/.test(apiKey)) {
    return { ok: false, code: "bad_key", error: "That doesn't look like an API key. Paste the whole key." };
  }
  const modelRaw = String(input.model ?? "").trim();
  if (modelRaw.length > 120 || /[\s<>"']/.test(modelRaw)) {
    return { ok: false, code: "bad_model", error: "That model name can't be used." };
  }
  const model = modelRaw || null;
  const hint = apiKey.slice(-4);
  await sql`
    INSERT INTO buzzy_user_ai_keys (user_id, base_url, model, key_sealed, key_hint, updated_at)
    VALUES (${userId}, ${baseUrl}, ${model}, ${sealSecret(apiKey)}, ${hint}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      base_url = EXCLUDED.base_url, model = EXCLUDED.model,
      key_sealed = EXCLUDED.key_sealed, key_hint = EXCLUDED.key_hint, updated_at = now()`;
  return { ok: true, summary: await keySummary(sql, userId) };
}

export async function deleteKey(sql: Sql, userId: string): Promise<void> {
  await sql`DELETE FROM buzzy_user_ai_keys WHERE user_id = ${userId}`;
}

/** No saved row is distinct from a configured key that cannot safely be used. */
export class PersonalKeyUnavailableError extends Error {
  constructor() {
    super("Your AI key settings could not be verified. Update or remove your saved key in Your AI key before continuing.");
    this.name = "PersonalKeyUnavailableError";
  }
}

/** Null means a verified absence only. Invalid keys and read failures fail closed. */
export async function overrideFor(sql: Sql, userId: string): Promise<LlmOverride | null> {
  try {
    const rows = await sql`
      SELECT base_url, model, key_sealed FROM buzzy_user_ai_keys WHERE user_id = ${userId}`;
    const r = rows[0];
    if (!r) return null;
    const apiKey = openSecret(String(r.key_sealed));
    const baseUrl = cleanBaseUrl(r.base_url);
    if (!apiKey || apiKey.length < 8 || apiKey.length > 400 || /\s/.test(apiKey) ||
        !baseUrl || !(await resolvesPublic(baseUrl))) throw new PersonalKeyUnavailableError();
    return { baseUrl, apiKey, model: r.model ? String(r.model) : null };
  } catch {
    // An unavailable table/database is not proof that the user has no key.
    // Never silently send their turn with the deployment's credentials.
    throw new PersonalKeyUnavailableError();
  }
}

/** Test-and-save requires the saved key even if it was concurrently removed. */
export async function requiredOverrideFor(sql: Sql, userId: string): Promise<LlmOverride> {
  const key = await overrideFor(sql, userId);
  if (!key) throw new PersonalKeyUnavailableError();
  return key;
}
