import type { Sql } from "@/lib/db";
import { withSqlTransaction, requireRowCount } from "../sqlTransaction";
import { setDocumentAcceptance } from "./documents";

/** Job flag, exact canonical acceptance, and attribution have one commit. */
export async function commitJobApproval(sql: Sql, input: {
  userId: string; jobId: string; approved: boolean; draft: string | null;
  title: string | null; status: string | null; dataPatch: Record<string, unknown>;
}) {
  const { userId, jobId, approved, draft, title, status, dataPatch } = input;
  return withSqlTransaction(sql, async tx => {
    const owned = await tx<{ id: string; title: string; status: string; company_id: string | null }>`
      SELECT id, title, status, company_id FROM buzzy_jobs
      WHERE id = ${jobId} AND user_id = ${userId} FOR UPDATE
    `;
    if (!owned.length) return null;
    // Joins THIS transaction. A stale decision performs no write; suppressed
    // required writes and database exceptions throw and roll back everything.
    const acceptance = await setDocumentAcceptance(tx, userId, jobId, approved, draft);
    if (!acceptance.ok) return { ...owned[0], outcome: acceptance.code, current_version: acceptance.currentVersion };
    const changed = await tx<{ id: string; title: string; status: string; company_id: string | null }>`
      UPDATE buzzy_jobs SET title = COALESCE(${title}, title), status = COALESCE(${status}, status),
        data = COALESCE(data, '{}'::jsonb) || ${JSON.stringify(dataPatch)}::jsonb, updated_at = now()
      WHERE id = ${jobId} AND user_id = ${userId} RETURNING id, title, status, company_id
    `;
    requireRowCount(changed, 1, "Job approval");
    requireRowCount(await tx`
      INSERT INTO buzzy_job_events(job_id,user_id,actor,action,detail)
      VALUES(${jobId},${userId},${userId},'approve',${approved ? "approved" : "approval revoked"}) RETURNING job_id
    `, 1, "Approval attribution");
    if (status !== null) requireRowCount(await tx`
      INSERT INTO buzzy_job_events(job_id,user_id,actor,action,detail)
      VALUES(${jobId},${userId},${userId},'status',${status}) RETURNING job_id
    `, 1, "Status attribution");
    requireRowCount(await tx`
      INSERT INTO buzzy_telemetry(user_id,job_id,doc_id,event,props)
      VALUES(${userId},${jobId},NULL,${approved ? "approval_recorded" : "reopened"},
        ${JSON.stringify({action:approved ? "approve" : "revoke"})}::jsonb) RETURNING job_id
    `, 1, "Approval metric");
    return { ...changed[0], outcome: "ok", current_version: null };
  });
}
