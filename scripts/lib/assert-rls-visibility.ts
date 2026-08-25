/**
 * Preflight for one-shot migration scripts that rewrite rows in RLS-protected
 * tables.
 *
 * These scripts accept `MIGRATION_DATABASE_URL ?? DATABASE_URL`. The fallback
 * is convenient and, on its own, silently wrong: `DATABASE_URL` is the app
 * credential (`passwd_app`), which is NOBYPASSRLS. Every table they rewrite is
 * FORCE ROW LEVEL SECURITY with
 *
 *   bypass_rls='on' OR tenant_id = current_setting('app.tenant_id',true)::uuid
 *
 * and these scripts set no GUC, so the predicate is NULL and their scan
 * SELECT returns ZERO ROWS WITH NO ERROR. The script then reports
 * "Migration complete … failed: 0" and exits 0 — a clean success that migrated
 * nothing, leaving plaintext OAuth tokens or v1 webhook secrets at rest while
 * the operator believes the job is done.
 *
 * "Examined nothing" must not be spelled the same as "found nothing to do", so
 * this refuses rather than scanning: an empty result is only trustworthy from a
 * connection that could have seen rows. Checking the ROLE rather than counting
 * rows is deliberate — a zero count is exactly what both the broken and the
 * already-migrated case produce, so it cannot discriminate them.
 */

/** Minimal shape shared by PrismaClient and a pg-backed query helper. */
type RoleProbe = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
};

export interface RlsVisibility {
  role: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
}

export async function checkRlsVisibility(
  client: RoleProbe,
): Promise<RlsVisibility> {
  const rows = await client.$queryRawUnsafe<
    Array<{ role: string; is_superuser: boolean; bypasses_rls: boolean }>
  >(
    `SELECT current_user AS role,
            rolsuper     AS is_superuser,
            rolbypassrls AS bypasses_rls
     FROM pg_roles
     WHERE rolname = current_user`,
  );
  const row = rows[0];
  if (!row) {
    // current_user with no pg_roles row should be impossible; treat the
    // unresolvable case as a refusal rather than assuming the good outcome.
    throw new Error(
      "RLS_PREFLIGHT_INDETERMINATE: could not resolve the current role from pg_roles",
    );
  }
  return {
    role: row.role,
    isSuperuser: row.is_superuser,
    bypassesRls: row.bypasses_rls,
  };
}

/**
 * Throws unless the connected role can see rows in RLS-protected tables
 * without a per-tenant GUC. Call before the scan query, never after.
 */
export async function assertRlsVisibility(
  client: RoleProbe,
  scriptName: string,
): Promise<RlsVisibility> {
  const v = await checkRlsVisibility(client);
  if (!v.isSuperuser && !v.bypassesRls) {
    throw new Error(
      `RLS_PREFLIGHT_FAILED: ${scriptName} is connected as "${v.role}", which is ` +
        "NOSUPERUSER and NOBYPASSRLS. Row-level security would hide every row " +
        "from this script and it would report success having migrated nothing. " +
        "Set MIGRATION_DATABASE_URL to a privileged connection string (the " +
        "migration role, e.g. passwd_user) and re-run.",
    );
  }
  return v;
}
