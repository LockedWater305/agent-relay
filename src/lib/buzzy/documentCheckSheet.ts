import type { Sql } from "@/lib/db";
import { withSqlTransaction } from "../sqlTransaction";
import { resolveActingAccount, canPerform, type MemberRole } from "./team";

interface SheetDocument {
  id: string; job_id: string | null; title: string; status: string;
  current_version: number; accepted_version: number | null; expert: string | null;
}

/** Read only: existing own documents first, then the selected active team account. */
export async function getDocumentCheckSheet(sql: Sql, actorId: string,
  actorEmail: string | null, documentId: string) {
  return withSqlTransaction(sql, async tx => {
    let accountId = actorId;
    const readDocument = () => tx<SheetDocument>`
      SELECT id, job_id, title, status, current_version, accepted_version, expert
      FROM buzzy_documents WHERE id = ${documentId} AND user_id = ${accountId} LIMIT 1 FOR SHARE
    `;
    let docs = await readDocument();
    if (!docs.length) {
      const acting = await resolveActingAccount(tx, actorId, actorEmail);
      if (!acting.membershipId || acting.accountId === actorId) return null;
      // The own-document miss held no row. Lock membership before the fallback
      // document, and never switch accounts if its identity/authority changed.
      const members = await tx<{ owner_user_id: string; role: MemberRole }>`
        SELECT owner_user_id, role FROM buzzy_team_members
        WHERE id = ${acting.membershipId} AND member_user_id = ${actorId}
          AND status = 'active' FOR SHARE
      `;
      const member = members[0];
      if (members.length !== 1 || member.owner_user_id !== acting.accountId ||
          member.role !== acting.role || !["admin", "member", "reviewer"].includes(member.role) ||
          !canPerform(member.role, "read")) return null;
      accountId = acting.accountId;
      docs = await readDocument();
    }
    if (!docs.length) return null;
    const doc = docs[0];
    const version = doc.accepted_version ?? doc.current_version;
    const vrows = await tx`
      SELECT version, content, brief_revision, review, accepted_at FROM buzzy_document_versions
      WHERE doc_id = ${doc.id} AND version = ${version} LIMIT 1
    `;
    const decisions = await tx`
      SELECT version, action, role, note, created_at FROM buzzy_document_decisions
      WHERE doc_id = ${doc.id} AND user_id = ${accountId}
      ORDER BY created_at DESC LIMIT 10
    `;
    const review = (() => {
      const raw = vrows[0]?.review;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return []; } }
      return [];
    })() as Array<{ label?: string; verdict?: string; detail?: string }>;
    return {
      sheet: {
        produced: { title: doc.title, version, status: doc.status, expert: doc.expert ?? null },
        checked: review.map((c) => ({ label: c.label ?? "", verdict: c.verdict ?? "" })),
        uncertain: review.filter((c) => c.verdict === "warning").map((c) => ({ label: c.label ?? "", detail: c.detail ?? "" })),
        files: {
          markdown: `/api/buzzy/documents/${doc.id}?version=${version}&format=md`,
          pdf: `/api/buzzy/documents/${doc.id}?version=${version}&format=pdf`,
          docx: `/api/buzzy/documents/${doc.id}?version=${version}&format=docx`,
          csv: `/api/buzzy/documents/${doc.id}?version=${version}&format=csv`,
        },
        decisions,
      },
    };
  });
}
