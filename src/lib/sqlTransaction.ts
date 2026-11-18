import type { Sql } from "./db";

/** Critical writes never degrade to independent queries on an unpinned pool. */
export function withSqlTransaction<T>(sql: Sql, work: (tx: Sql) => Promise<T>): Promise<T> {
  if (!sql.transaction) throw new Error("This operation requires transactional SQL");
  return sql.transaction(work);
}

/** A trigger may suppress a write without throwing; that is not a commit. */
export function requireRowCount(rows: unknown[], expected: number, operation: string): void {
  if (rows.length !== expected) throw new Error(`${operation} did not update the required records`);
}
