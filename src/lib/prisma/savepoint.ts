import type { TxOrPrisma } from "@/lib/prisma";

export type SavepointOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Run `fn` under a SAVEPOINT of the caller's open interactive transaction, so
 * that a failure inside it is undone on its own and the transaction stays
 * usable.
 *
 * Catching an error inside an interactive transaction does not recover the
 * transaction: once PostgreSQL rejects a statement (a P2002 unique violation,
 * an FK violation, ...) every later statement fails with 25P02, and the final
 * COMMIT silently becomes a ROLLBACK — Prisma reports no error. A per-item
 * catch-and-continue loop therefore reports items as created that the commit
 * discarded. Rolling back to a savepoint opened BEFORE the failing statement
 * is the only way to keep going (a savepoint issued after it cannot recover
 * the session).
 *
 * Errors thrown by `fn` are returned, not thrown, after its writes have been
 * rolled back. A failure of the savepoint statements themselves is thrown:
 * the transaction can no longer be trusted, so the caller must not count it
 * as one failed item and continue. When that failure happens while undoing a
 * failed `fn`, the thrown AggregateError carries both errors, `fn`'s first.
 *
 * Row locks taken inside `fn` are released when it is rolled back; locks from
 * a successful `fn` stay held by the transaction until it ends.
 *
 * `db` must be the transaction client (or the ambient-RLS `prisma` proxy
 * inside a tenant context): outside a transaction block PostgreSQL refuses
 * SAVEPOINT, so misuse fails on the first statement. Calls must be sequential
 * — the fixed savepoint name relies on PostgreSQL resolving it to the most
 * recent one, which also makes properly nested calls safe.
 */
export async function attemptInSavepoint<T>(
  db: TxOrPrisma,
  fn: () => Promise<T>,
): Promise<SavepointOutcome<T>> {
  await db.$executeRaw`SAVEPOINT attempt_in_savepoint`;
  let value: T;
  try {
    value = await fn();
  } catch (error) {
    try {
      await db.$executeRaw`ROLLBACK TO SAVEPOINT attempt_in_savepoint`;
      await db.$executeRaw`RELEASE SAVEPOINT attempt_in_savepoint`;
    } catch (rollbackError) {
      // Keep fn's error: it is the one that explains why a rollback was needed.
      throw new AggregateError([error, rollbackError], "savepoint rollback failed");
    }
    return { ok: false, error };
  }
  await db.$executeRaw`RELEASE SAVEPOINT attempt_in_savepoint`;
  return { ok: true, value };
}
