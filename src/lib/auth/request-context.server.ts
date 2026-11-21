import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { VerifiedUser } from "./verify.server";

// A context stamp can only assert continuity alongside freshly verified auth.
// It never authenticates a request, carries no owner/credential, and is not a
// single-use token. Callers must still enforce their current policy in full.
type Subject = Pick<VerifiedUser, "id" | "requestBinding">;
type ContextPurpose = "audio-input-v1" | "talk-attachment-v1";
export type RequestContextSpec = Readonly<{
  purpose: ContextPurpose;
  scope: string;
  ttlMs: number;
  clockSkewMs?: number;
}>;

function signature(subject: Subject, spec: RequestContextSpec, prefix: string): string | null {
  const key = subject.requestBinding;
  if (!subject.id || typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) return null;
  return createHmac("sha256", key)
    .update(JSON.stringify([spec.purpose, subject.id, spec.scope, prefix]))
    .digest("base64url");
}

export function issueRequestContext(
  subject: Subject,
  spec: RequestContextSpec,
  startedAt = Date.now(),
): string | null {
  const expires = startedAt + spec.ttlMs;
  const now = Date.now();
  if (!Number.isSafeInteger(expires) || !/^[0-9]{13}$/.test(String(expires)) || startedAt > now || expires <= now) return null;
  const prefix = expires + "." + randomBytes(12).toString("base64url");
  const signed = signature(subject, spec, prefix);
  return signed ? prefix + "." + signed : null;
}

export function acceptsRequestContext(
  subject: Subject,
  spec: RequestContextSpec,
  value: unknown,
): boolean {
  const match = typeof value === "string" && value.length === 74 && /^([0-9]{13}\.[A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const remaining = Number(match[1].slice(0, 13)) - Date.now();
  if (remaining <= 0 || remaining > spec.ttlMs + (spec.clockSkewMs ?? 0)) return false;
  const expected = signature(subject, spec, match[1]);
  return !!expected && timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]));
}
