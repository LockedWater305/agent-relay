/**
 * Conversation recency + one-line summaries.
 *
 * The Recent work list was showing conversations in insertion order, not by
 * when they last moved, and every row said "Pick up this conversation" because
 * the `summary` column was never filled automatically (the POST endpoint
 * existed, nothing called it).
 *
 * Two jobs here:
 *   touchSession()            — stamp updated_at on every turn, so "most recent
 *                               conversation" is a fact and not a guess.
 *   maybeSummarizeSession()   — keep a one-line summary fresh. Cheap model, run
 *                               off the critical path, refresh every N messages,
 *                               and fall back to the owner's own opening line so
 *                               a row is never blank.
 */

import { chatCompletion } from "./llm";
import { selectModel } from "./modelPolicy";
import { readModelPrefs } from "./modelPrefs";

const SUMMARY_MODEL = process.env.BZ_SUMMARY_MODEL?.trim() || "google/gemini-3.1-flash-lite";
const MAX_WORDS = 30;
/** Regenerate only after this many new messages — summaries are a list label,
 *  not a per-turn artifact, and each refresh is a model call. */
const REFRESH_EVERY = 6;
/** How much transcript the summariser sees (tail-weighted). */
const TRANSCRIPT_CHARS = 8000;

/** Mark the conversation as active. Cheap single-row write. */
export async function touchSession(sql: any, sessionId: string, userId: string): Promise<void> {
  try {
    await sql`
      UPDATE buzzy_sessions SET updated_at = now()
      WHERE id = ${sessionId} AND user_id = ${userId}
    `;
  } catch (err) {
    console.warn("[buzzy/sessions] touch failed:", err instanceof Error ? err.message : err);
  }
}

function clipWords(text: string, words = MAX_WORDS): string {
  const parts = String(text || "").replace(/\s+/g, " ").trim().split(" ");
  return parts.slice(0, words).join(" ").trim();
}

/**
 * Generate and store a fresh one-line summary. A policy refusal must not read
 * transcript content, call a provider or replace an existing summary.
 */
export async function summarizeSessionNow(
  sql: any,
  sessionId: string,
  userId: string,
): Promise<
  | { ok: true; summary: string | null }
  | { ok: false; status: 409 | 503; code: "summary_local_unavailable" | "summary_policy_unavailable"; error: string }
> {
  // Manual summaries do not enter chatLoop. Read the owner's current setting
  // here, also covering a queued refresh that runs after a preference change.
  let model = SUMMARY_MODEL;
  let localOnly: boolean;
  try {
    const prefs = await readModelPrefs(sql, userId, { requireStoredObject: true });
    localOnly = prefs.localOnly;
    if (localOnly) {
      const decision = selectModel({ jobType: "general", phase: "extraction",
        preference: prefs.preference, provider: prefs.provider, localOnly,
        budgetCapCents: prefs.budgetCapCents, spentCents: prefs.spentCents });
      if (decision.refused || !decision.model) return { ok: false, status: 409,
        code: "summary_local_unavailable",
        error: "No local model is available with these settings. No conversation was sent." };
      model = decision.model;
    }
  } catch {
    return { ok: false, status: 503, code: "summary_policy_unavailable",
      error: "Could not verify your model settings. No conversation was sent." };
  }
  const msgs = (await sql`
    SELECT role, content FROM buzzy_chat_messages
    WHERE session_id = ${sessionId} AND user_id = ${userId}
    ORDER BY created_at DESC LIMIT 40
  `) as Array<{ role: string; content: string }>;
  if (!msgs.length) return { ok: true, summary: null };
  const chronological = [...msgs].reverse();

  // The owner's own opening line is the honest fallback if the model fails.
  const firstUser = chronological.find((m) => m.role === "user")?.content ?? "";
  const fallback = clipWords(firstUser, MAX_WORDS);

  const transcript = chronological
    .map((m) => `${m.role === "user" ? "Person" : "BeeZilla"}: ${String(m.content).slice(0, 900)}`)
    .join("\n")
    .slice(-TRANSCRIPT_CHARS);

  let summary = "";
  try {
    const raw = await chatCompletion(
      [
        {
          role: "system",
          content:
            `Write ONE line describing this conversation: what it is about and what was decided or produced. ` +
            `${MAX_WORDS} words maximum, plain language, no preamble ("The conversation is about…" is banned), ` +
            `no quotes, no exclamation marks. Write it as a label a person would scan in a list.`,
        },
        { role: "user", content: transcript },
      ],
      { model, localOnly, temperature: 0.2, maxTokens: 160 },
    );
    summary = clipWords(raw);
  } catch {
    summary = "";
  }

  const value = summary || fallback;
  if (!value) return { ok: true, summary: null };

  // Give an unnamed conversation a real name. A row called "New session" is
  // unreadable in a list; the owner's opening words are the honest label.
  // Never overwrites a rename (only the literal default is replaced).
  const derivedTitle = (() => {
    const firstClause = String(firstUser || "")
      .split(/[.?!\n]/)[0]
      .replace(/\s+/g, " ")
      .trim();
    return firstClause.split(" ").slice(0, 9).join(" ").replace(/[,;:]$/, "").slice(0, 70);
  })();

  try {
    const count = (await sql`
      SELECT count(*)::int AS n FROM buzzy_chat_messages
      WHERE session_id = ${sessionId} AND user_id = ${userId}
    `) as Array<{ n: number }>;
    // NOTE: writing a summary is NOT activity — updated_at is deliberately left
    // alone here so "Active 2h ago" keeps meaning "the owner last spoke".
    await sql`
      UPDATE buzzy_sessions
      SET summary = ${value}, summary_at = now(), summary_messages = ${Number(count[0]?.n ?? 0)}
      WHERE id = ${sessionId} AND user_id = ${userId}
    `;
    if (derivedTitle.length > 2) {
      await sql`
        UPDATE buzzy_sessions SET title = ${derivedTitle}
        WHERE id = ${sessionId} AND user_id = ${userId}
          AND (title IS NULL OR btrim(title) = '' OR title = 'New session')
      `;
    }
  } catch (err) {
    console.warn("[buzzy/sessions] summary write failed:", err instanceof Error ? err.message : err);
  }
  return { ok: true, summary: value };
}

/**
 * Refresh the summary only when it is missing or stale. Never throws: a summary
 * is a label, and a failed label must not break the turn that produced it.
 */
export async function maybeSummarizeSession(
  sql: any,
  sessionId: string,
  userId: string,
): Promise<void> {
  try {
    const rows = (await sql`
      SELECT s.summary, s.summary_messages,
             (SELECT count(*)::int FROM buzzy_chat_messages m
              WHERE m.session_id = s.id AND m.user_id = s.user_id) AS msg_count
      FROM buzzy_sessions s
      WHERE s.id = ${sessionId} AND s.user_id = ${userId}
      LIMIT 1
    `) as Array<{ summary: string | null; summary_messages: number | null; msg_count: number }>;
    const row = rows[0];
    if (!row) return;
    const count = Number(row.msg_count ?? 0);
    if (count < 2) return;
    const haveSummary = typeof row.summary === "string" && row.summary.trim().length > 0;
    const since = count - Number(row.summary_messages ?? 0);
    if (haveSummary && since < REFRESH_EVERY) return;
    await summarizeSessionNow(sql, sessionId, userId);
  } catch (err) {
    console.warn("[buzzy/sessions] summarize skipped:", err instanceof Error ? err.message : err);
  }
}
