/**
 * Preconditions for cases whose code under test reads every tenant's rows (a
 * sweep, a worker pass) and whose assertion is about that whole read: a count
 * it returns, or a cap it honours. Such a case cannot be scoped to its own
 * rows, so it states the rows it depends on being absent and refuses to run
 * when they are present, naming them, instead of failing on an assertion that
 * says nothing about why.
 */
import { setBypassRlsGucs, type PrismaWithPool } from "./helpers";

const NAMED = 20;

/**
 * Fail unless `sql` returns no row. `sql` selects one `ref` column naming each
 * offending row (an id, a tenant), and has no LIMIT of its own; `reads` says
 * what the code under test reads, as the start of the refusal.
 */
export async function assertNoForeignRows(
  su: PrismaWithPool,
  reads: string,
  sql: string,
  ...params: unknown[]
): Promise<void> {
  const rows = await su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ ref: string }[]>(`${sql} LIMIT ${NAMED + 1}`, ...params);
  });
  if (rows.length === 0) return;
  const shown = rows.slice(0, NAMED).map((r) => r.ref);
  throw new Error(
    `${reads}, and this database holds ${rows.length > NAMED ? `more than ${NAMED}` : rows.length} such row(s) ` +
      `this case did not create: ${shown.join(", ")}. A file whose cleanup did not run left them; ` +
      "remove them (or their tenant) before running this case.",
  );
}
