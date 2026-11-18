import type { Sql } from "@/lib/db";
import { withSqlTransaction, requireRowCount } from "../sqlTransaction";
import { resolveActingAccount, authorize } from "./team";

export interface DocumentDecisionInput {
  actorId: string;
  actorEmail: string | null;
  documentId: string;
  action: "accept" | "request_changes" | "keep_draft";
  role: "internal" | "customer";
  note: string;
  version?: number;
  draft?: string | null;
}
type Refusal = { ok: false; status: number; error: string; code: string;
  currentVersion?: number; role?: string; via?: string };
type Result = Refusal | { ok: true; documentId: string; jobId: string | null; version: number };
const missing = (): Refusal => ({ ok: false, status: 404, error: "Document not found", code: "not_found" });

/** One decision and its required lifecycle/audit effects, never optional metrics. */
export async function commitDocumentDecision(sql: Sql, input: DocumentDecisionInput): Promise<Result> {
  return withSqlTransaction(sql, async tx => {
    const acting = await resolveActingAccount(tx, input.actorId, input.actorEmail);
    // Freeze the selected active membership before waiting for document writers.
    // Owner-scoped storage never changes to the acting human's account.
    if (acting.membershipId) {
      const members = await tx<{ owner_user_id: string; role: typeof acting.role }>`
        SELECT owner_user_id, role FROM buzzy_team_members
        WHERE id = ${acting.membershipId} AND member_user_id = ${input.actorId}
          AND status = 'active' FOR SHARE
      `;
      if (members.length !== 1 || members[0].owner_user_id !== acting.accountId) return missing();
      acting.role = members[0].role;
    }
    const found = await tx<{ job_id: string | null }>`
      SELECT job_id FROM buzzy_documents
      WHERE id = ${input.documentId} AND user_id = ${acting.accountId}
    `;
    if (found.length !== 1) return missing();
    const jobId = found[0].job_id;
    const jobs = jobId ? await tx<{ company_id: string | null }>`
      SELECT company_id FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${acting.accountId} FOR UPDATE
    ` : [];
    if (jobId && jobs.length !== 1) return missing();
    const docs = await tx<{ job_id: string | null; current_version: number; accepted_version: number | null }>`
      SELECT job_id, current_version, accepted_version FROM buzzy_documents
      WHERE id = ${input.documentId} AND user_id = ${acting.accountId} FOR UPDATE
    `;
    if (docs.length !== 1) return missing();
    const doc = docs[0];
    // Never acquire a newly discovered job lock after taking a document lock.
    if (doc.job_id !== jobId) return { ok: false, status: 409, code: "document_changed",
      error: "This document moved. Reopen it before recording a decision." };
    const needAction = input.action === "accept" ? "accept_document"
      : input.action === "request_changes" ? "request_changes" : "read";
    let selectedDelegation: string | null = null;
    if (needAction !== "read") {
      // Authorization chooses a grant; bind/revalidate that exact row below
      // after all document/version locks, including grants inserted meanwhile.
      const decision = await authorize(tx, acting, needAction, { companyId: jobs[0]?.company_id ?? null });
      if (!decision.allowed) return { ok: false, status: 403, error: decision.reason ?? "This action is not allowed.",
        code: "role_denied", role: acting.role, via: decision.via };
      if (decision.via === "delegation") selectedDelegation = decision.delegationId ?? null;
      if (decision.via === "delegation" && !selectedDelegation) return { ok: false, status: 403,
        code: "role_denied", error: "This delegation is no longer active.", role: acting.role, via: "none" };

    }
    const version = input.version ?? doc.accepted_version ?? doc.current_version;
    const versions = await tx<{ version: number; content: string }>`
      SELECT version, content FROM buzzy_document_versions WHERE doc_id = ${input.documentId} FOR UPDATE
    `;
    const selected = versions.find(v => v.version === version);
    if (!selected) return { ok: false, status: 404, code: "not_found", error: "That version does not exist." };
    if (input.action === "accept" && (version !== doc.current_version ||
        (typeof input.draft === "string" && input.draft !== selected.content))) {
      return { ok: false, status: 409, code: "stale_version", currentVersion: doc.current_version,
        error: "That version is not the latest — review the current one before accepting." };
    }
    if (selectedDelegation) {
      // The selected row may not have existed at an earlier grant-list read.
      // Lock it explicitly, then check live authority after every blocking lock.
      const locked = await tx`
        SELECT id FROM buzzy_delegations WHERE id = ${selectedDelegation} FOR SHARE
      `;
      if (locked.length !== 1) return { ok: false, status: 403, code: "role_denied",
        error: "This delegation is no longer active.", role: acting.role, via: "none" };
      const valid = await tx`
        SELECT id FROM buzzy_delegations WHERE id = ${selectedDelegation}
          AND member_id = ${acting.membershipId} AND owner_user_id = ${acting.accountId}
          AND action = ${needAction} AND revoked_at IS NULL
          AND (scope_company_id IS NULL OR scope_company_id = ${jobs[0]?.company_id ?? null})
          AND max_amount_cents IS NULL
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
      `;
      // Unknown amount must not be converted to zero to fit a capped grant.
      if (valid.length !== 1) return { ok: false, status: 403, code: "role_denied",
        error: "This delegation is no longer active for this action.", role: acting.role, via: "none" };
    }
    if (input.action === "accept" && input.role === "internal") {
      requireRowCount(await tx`
        UPDATE buzzy_documents SET status = 'accepted', accepted_version = ${version}, updated_at = now()
        WHERE id = ${input.documentId} AND user_id = ${acting.accountId} RETURNING id
      `, 1, "Document decision acceptance");
      requireRowCount(await tx`
        UPDATE buzzy_document_versions SET accepted_at = now(), accepted_by = ${input.actorId}
        WHERE doc_id = ${input.documentId} AND version = ${version} RETURNING version
      `, 1, "Document decision version acceptance");
    }
    requireRowCount(await tx`
      INSERT INTO buzzy_document_decisions (doc_id, user_id, version, action, role, note)
      VALUES (${input.documentId}, ${acting.accountId}, ${version}, ${input.action}, ${input.role}, ${input.note})
      RETURNING id
    `, 1, "Document decision");
    if (input.action === "request_changes") requireRowCount(await tx`
      INSERT INTO buzzy_job_events (job_id, user_id, actor, action, detail)
      VALUES (${jobId ?? input.documentId}, ${input.actorId}, ${input.actorId}, 'correction_requested',
        ${JSON.stringify({ version, bound: "one revision", note: input.note.slice(0, 200) })}) RETURNING id
    `, 1, "Document correction event");
    return { ok: true, documentId: input.documentId, jobId, version };
  });
}
