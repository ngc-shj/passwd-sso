/**
 * Readback assertion for one-shot migrations that rewrite rows in
 * RLS-protected tables.
 *
 * These scripts must run inside a `withBypassRls` transaction. Skipping that
 * does not error — it silently returns zero rows, so the script prints
 * "Migration complete … failed: 0" and exits 0, leaving plaintext OAuth tokens
 * or v1 webhook secrets at rest while the operator believes the job is done.
 * `scripts/tenant-domain.ts` documents the same hazard for `tenant_claims`.
 *
 * Why a GUC readback and NOT a role-attribute check: the tenant_isolation
 * policies are
 *
 *   COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
 *     OR tenant_id = current_setting('app.tenant_id', true)::uuid
 *
 * so what actually decides visibility is the GUC, which any role may set —
 * not `rolsuper`/`rolbypassrls`. Testing the role attributes instead would
 * refuse on a normal AWS RDS deployment, where the master user is a member of
 * `rds_superuser` but carries neither attribute (`rds_superuser` is a role
 * MEMBERSHIP; `SUPERUSER`/`BYPASSRLS` are role ATTRIBUTES, and RDS creates the
 * master as NOSUPERUSER with BYPASSRLS unspecified, i.e. NOBYPASSRLS). Both
 * migrations would then be unrunnable there.
 *
 * Assert on the same transaction that will do the reading, before the first
 * read: a GUC set with `SET LOCAL` is transaction-scoped, so a probe on any
 * other transaction — or after the read — says nothing about the read.
 */

/** Minimal shape shared by Prisma's TransactionClient and a query helper. */
type TxProbe = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};

/**
 * Throws unless `app.bypass_rls` is active on THIS transaction. Call as the
 * first statement inside the `withBypassRls` callback, before any RLS-table
 * read.
 */
export async function assertBypassRlsActive(
  tx: TxProbe,
  scriptName: string,
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{ bypass: string | null }>>(
    `SELECT current_setting('app.bypass_rls', true) AS bypass`,
  );
  const bypass = rows[0]?.bypass ?? null;
  if (bypass !== "on") {
    throw new Error(
      `RLS_BYPASS_NOT_ACTIVE: ${scriptName} expected app.bypass_rls='on' on this ` +
        `transaction but read ${JSON.stringify(bypass)}. Every RLS-protected read ` +
        "would return zero rows with no error, and the migration would report " +
        "success having rewritten nothing. Run the work inside withBypassRls.",
    );
  }
}
