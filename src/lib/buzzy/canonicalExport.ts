import type { Sql } from "@/lib/db";
import { withSqlTransaction } from "../sqlTransaction";
import { resolveActingAccount, canPerform, type MemberRole } from "./team";

interface ExportDocument {
  id: string; job_id: string | null; title: string; status: string; current_version: number;
}
interface ExportVersion { version: number; content: string; created_at: unknown }

/** Snapshot only canonical text for an explicit supported export, never originals.
 * Callers render after this transaction releases its membership/document locks. */
export async function getCanonicalExportSnapshot(sql: Sql, actorId: string,
  actorEmail: string | null, documentId: string, versionRaw: string | null) {
  return withSqlTransaction(sql, async tx => {
    let accountId = actorId;
    const readDocument = () => tx<ExportDocument>`
      SELECT id, job_id, title, status, current_version
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
    // Preserve the existing route's Number/truthiness semantics, including
    // omitted/empty version selecting current (not accepted) and nonfinite -1.
    const version = versionRaw ? Number(versionRaw) : doc.current_version;
    const versions = await tx<ExportVersion>`
      SELECT version, content, created_at FROM buzzy_document_versions
      WHERE doc_id = ${doc.id} AND version = ${Number.isFinite(version) ? version : -1} LIMIT 1
    `;
    return { document: doc, version: versions[0] ?? null };
  });
}
