/**
 * BZ-F015 — durable project documents.
 *
 * Materialize the ACTUAL output a workflow produced (never reconstruct a
 * "document" from a problem echo), keep every prior version immutable, and
 * expose the lifecycle (draft → ready → accepted) as real state.
 */

import type { Sql } from "@/lib/db";
import { withSqlTransaction, requireRowCount } from "../sqlTransaction";

export interface MaterializedDoc {
  id: string;
  version: number;
  changed: boolean;
}

/** One canonical deliverable document per job (id derived from the job id). */
export function documentIdForJob(jobId: string): string {
  return "doc_" + jobId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
}

/** Provenance recorded with every substantive version (BZ-F017). */
export interface VersionProvenance {
  /** The brief (slots) snapshot this version was generated from. */
  slots?: Record<string, string>;
  expert?: string | null;
  /** Verification results computed at generation time (reviewDraft checks). */
  review?: unknown;
  creator?: string | null;
}

/**
 * Persist `content` as the job's document. A changed body appends a new
 * immutable version and bumps current_version; an identical body is a no-op
 * (re-saving never rewrites history, QA-12).
 */
export async function materializeDraft(
  sql: Sql,
  userId: string,
  jobId: string | null,
  title: string,
  content: string,
  provenance: VersionProvenance = {},
  existingDocumentId?: string,
): Promise<MaterializedDoc> {
  return withSqlTransaction(sql, async tx => {
    // The same job lock used by approval covers even a missing canonical row.
    // Standalone legacy edits name their existing document explicitly.
    const jobs = jobId ? await tx<{ id: string; user_id: string }>`
      SELECT id, user_id FROM buzzy_jobs WHERE id = ${jobId} FOR UPDATE
    ` : [];
    if (jobs.length && jobs[0].user_id !== userId) throw new Error("Job not found");
    const id = existingDocumentId ?? (jobId ? documentIdForJob(jobId) : null);
    if (!id) throw new Error("An existing document or owned job is required");
    const existing = await tx<{ current_version: number; status: string; job_id: string | null }>`
      SELECT current_version, status, job_id FROM buzzy_documents
      WHERE id = ${id} AND user_id = ${userId} FOR UPDATE
    `;
    if (existingDocumentId && (!existing.length || existing[0].job_id !== jobId)) {
      throw new Error("Document ownership changed");
    }
    if (!existing.length && !jobs.length) throw new Error("Job not found");
    const briefJson = provenance.slots ? JSON.stringify(provenance.slots) : null;
    const reviewJson = provenance.review ? JSON.stringify(provenance.review) : null;
    const current = existing[0];
    if (current) {
      const latest = await tx<{ content: string }>`
        SELECT content FROM buzzy_document_versions
        WHERE doc_id = ${id} AND version = ${current.current_version} FOR UPDATE
      `;
      requireRowCount(latest, 1, "Current document version");
      if (latest[0].content === content) return { id, version: current.current_version, changed: false };
    }
    const nextVersion = current ? current.current_version + 1 : 1;
    if (!current) {
      requireRowCount(await tx`
        INSERT INTO buzzy_documents (id, user_id, job_id, title, type, status, current_version, expert)
        VALUES (${id}, ${userId}, ${jobId}, ${title.slice(0, 200)}, 'document', 'ready', 1, ${provenance.expert ?? null})
        RETURNING id
      `, 1, "Document creation");
    }
    requireRowCount(await tx`
      INSERT INTO buzzy_document_versions
        (doc_id, version, content, parent_version, creator, brief_revision, expert, review)
      VALUES (${id}, ${nextVersion}, ${content}, ${current?.current_version ?? null},
        ${provenance.creator ?? null}, ${briefJson}::jsonb, ${provenance.expert ?? null}, ${reviewJson}::jsonb)
      RETURNING doc_id
    `, 1, "Version creation");
    if (current) {
      requireRowCount(await tx`
        UPDATE buzzy_documents SET current_version = ${nextVersion}, title = ${title.slice(0, 200)},
          status = CASE WHEN status = 'accepted' THEN 'ready' ELSE status END,
          accepted_version = NULL, updated_at = now()
        WHERE id = ${id} AND user_id = ${userId} RETURNING id
      `, 1, "Document revision");
    }
    if (jobs.length) {
      requireRowCount(await tx`
        UPDATE buzzy_jobs SET
          data = COALESCE(data, '{}'::jsonb) || ${JSON.stringify({ approved: false, draft: content })}::jsonb,
          status = CASE WHEN status IN ('Approved', 'Done') THEN 'Draft ready' ELSE status END,
          updated_at = now()
        WHERE id = ${jobId} AND user_id = ${userId} RETURNING id
      `, 1, "Revision approval invalidation");
    }
    return { id, version: nextVersion, changed: true };
  });
}

// ── BZ-F016: changed-section summary ─────────────────────────────────────

export interface DiffSummary {
  from: number;
  to: number;
  added: string[];
  removed: string[];
  sectionsChanged: string[];
  /** True when the two versions are byte-identical (no false "changed"). */
  identical: boolean;
}

function sectionOf(headings: Array<{ at: number; name: string }>, lineIdx: number): string {
  let name = "(opening)";
  for (const h of headings) {
    if (h.at <= lineIdx) name = h.name;
  }
  return name;
}

/**
 * Line-level changed-section summary between two canonical texts. Deliberately
 * a summary, not a Myers diff: lines unique to each side plus the section
 * headings those lines fall under.
 */
export function summarizeChanges(fromText: string, toText: string, from: number, to: number): DiffSummary {
  const aLines = fromText.split("\n").map((l) => l.trim()).filter(Boolean);
  const bLines = toText.split("\n").map((l) => l.trim()).filter(Boolean);
  const aHeads = fromText.split("\n").map((l, i) => ({ at: i, name: l.replace(/^#{1,3}\s+/, "").trim() })).filter((h) => /^#{1,3}\s/.test(fromText.split("\n")[h.at] ?? ""));
  const bHeads = toText.split("\n").map((l, i) => ({ at: i, name: l.replace(/^#{1,3}\s+/, "").trim() })).filter((h) => /^#{1,3}\s/.test(toText.split("\n")[h.at] ?? ""));
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  const added = bLines.filter((l) => !aSet.has(l)).slice(0, 20);
  const removed = aLines.filter((l) => !bSet.has(l)).slice(0, 20);
  const sections = new Set<string>();
  toText.split("\n").forEach((l, i) => {
    if (l.trim() && !aSet.has(l.trim())) sections.add(sectionOf(bHeads, i));
  });
  fromText.split("\n").forEach((l, i) => {
    if (l.trim() && !bSet.has(l.trim())) sections.add(sectionOf(aHeads, i));
  });
  return {
    from,
    to,
    added,
    removed,
    sectionsChanged: [...sections].slice(0, 10),
    identical: fromText === toText,
  };
}

export type AcceptanceResult =
  | { ok: true }
  | { ok: false; code: "stale_version"; currentVersion: number };

/**
 * Approval state flows into the document lifecycle (BZ-F017 / QA-08).
 * When `approvedText` is supplied (the client approves the exact text on its
 * screen), it must match the document's CURRENT version — approving a stale
 * revision is rejected, never silently applied to newer content.
 */
export async function setDocumentAcceptance(
  sql: Sql, userId: string, jobId: string, accepted: boolean,
  approvedText?: string | null,
): Promise<AcceptanceResult> {
  return withSqlTransaction(sql, async tx => {
    // Consistent job -> document -> version order across all shared writers.
    await tx`SELECT id FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${userId} FOR UPDATE`;
    const id = documentIdForJob(jobId);
    const docs = await tx<{ current_version: number }>`
      SELECT current_version FROM buzzy_documents WHERE id = ${id} AND user_id = ${userId} FOR UPDATE
    `;
    if (!docs.length) return { ok: true };
    const versions = await tx<{ version: number; content: string }>`
      SELECT version, content FROM buzzy_document_versions WHERE doc_id = ${id} FOR UPDATE
    `;
    const current = versions.find(v => v.version === docs[0].current_version);
    if (accepted && (!current || (typeof approvedText === "string" && current.content !== approvedText))) {
      return { ok: false, code: "stale_version", currentVersion: docs[0].current_version };
    }
    requireRowCount(await tx`
      UPDATE buzzy_documents SET status = ${accepted ? "accepted" : "ready"},
        accepted_version = ${accepted ? docs[0].current_version : null}, updated_at = now()
      WHERE id = ${id} AND user_id = ${userId} RETURNING id
    `, 1, "Document acceptance");
    requireRowCount(await tx`
      UPDATE buzzy_document_versions SET accepted_at = CASE WHEN ${accepted} THEN now() ELSE NULL END,
        accepted_by = ${accepted ? userId : null}
      WHERE doc_id = ${id} AND (NOT ${accepted} OR version = ${docs[0].current_version})
      RETURNING version
    `, accepted ? 1 : versions.length, "Version acceptance");
    return { ok: true };
  });
}
