/**
 * The must-never-be-granted declaration, asserted against the live database.
 *
 * `scripts/checks/app-role-denied-privileges.json` states privileges a role may
 * never hold. Nothing asserted that against a real database, and the one control
 * it covers had in fact been off: migration
 * `20260522000200_audit_log_revoke_via_definer` revokes UPDATE/DELETE on
 * `audit_logs` / `audit_chain_anchors` from `passwd_app`, and
 * `scripts/bootstrap-rds-roles.mjs`'s table-blind
 * `GRANT ... ON ALL TABLES ... TO passwd_app` re-granted them on every
 * convergence run. `docs/security/tenant-boundary-matrix.md` asserted the
 * control was in effect; `db-grants-manifest.json` had been regenerated against
 * the broken state, so the grant audit reported OK.
 *
 * The cases are DERIVED from the declaration file, so a new entry is covered
 * without anyone remembering to add a case here — and a deleted entry stops
 * being asserted only by deleting the policy, which is a visible act.
 *
 * `has_table_privilege` (not `information_schema.role_table_grants`) because it
 * answers the question that matters: can this role actually do it, including via
 * PUBLIC or via inheritance.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "./helpers";
// The SAME loader production uses, not a second parse path. A hand-rolled
// `JSON.parse(...) as {denied: …}` here accepted anything shaped like the type,
// so this test asserted a weaker contract than the scripts do against the very
// same file — which is the "one policy, two implementations" shape the shared
// module exists to remove.
import { loadDeniedPolicy } from "../../../scripts/lib/denied-privileges.mjs";

const SKIP = !process.env.DATABASE_URL;

type DeniedEntry = {
  role: string;
  table: string;
  privileges: string[];
  reason: string;
};

const DECLARATION = { denied: loadDeniedPolicy() as DeniedEntry[] };

/**
 * The privileges PostgreSQL can scope to a column. `GRANT DELETE (col)` does not
 * exist, and `has_column_privilege` raises `22023` for those types rather than
 * returning false — so the column sweep below has to skip them rather than treat
 * the error as a finding.
 */
const COLUMN_SCOPABLE = new Set(["SELECT", "INSERT", "UPDATE", "REFERENCES"]);

const CASES = DECLARATION.denied.flatMap((d) =>
  d.privileges.map((priv) => [d.role, d.table, priv, d.reason] as const),
);

describe("app-role denied privileges (live database)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });
  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  it("the declaration is non-empty (anti-vacuity)", () => {
    // Without this, emptying the JSON would silently retire every case below
    // while the suite stayed green — the same shape as the manifest recording
    // the breakage as expected.
    expect(CASES.length).toBeGreaterThan(0);
  });

  it.skipIf(SKIP).each(CASES)(
    "%s must NOT hold %s on %s — at table OR column level",
    async (role, table, privilege) => {
      const [row] = await ctx.su.prisma.$queryRawUnsafe<{ granted: boolean }[]>(
        `SELECT has_table_privilege($1, $2, $3) AS granted`,
        role,
        table,
        privilege,
      );
      expect(row.granted, `${role} holds ${privilege} on ${table}`).toBe(false);

      // DELETE / TRUNCATE / TRIGGER cannot be column-scoped at all —
      // `has_column_privilege(…, 'DELETE')` raises `22023 unrecognized privilege
      // type`. For those the table-level assertion above is already complete.
      if (!COLUMN_SCOPABLE.has(privilege)) return;

      // Column level too. PostgreSQL lets the two disagree, verified against
      // this database:
      //   GRANT UPDATE (metadata) ON audit_logs TO passwd_app;
      //   has_table_privilege (…, 'UPDATE')             -> false
      //   has_column_privilege(…, 'metadata', 'UPDATE') -> true
      // A table-level-only assertion therefore passes a role that can rewrite
      // the one column that matters — `audit_logs.metadata` holds the claim, the
      // reason and the identifier hash.
      const columns = await ctx.su.prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT a.attname AS column_name
           FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
        table,
      );
      expect(columns.length, `${table} has no columns — fixture is vacuous`).toBeGreaterThan(0);

      const held = await ctx.su.prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT a.attname AS column_name
           FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege($2, a.attrelid, a.attname, $3)`,
        table,
        role,
        privilege,
      );
      expect(
        held.map((c) => c.column_name),
        `${role} holds ${privilege} on columns of ${table}`,
      ).toEqual([]);
    },
  );

  it.skipIf(SKIP)(
    "the sanctioned mutation paths still exist, so revoking is not simply breaking them",
    async () => {
      // The negative cases above are only correct because the two SECURITY
      // DEFINER routines carry the legitimate mutations (tenant merge and
      // retention purge). If a refactor removed them, the right response is to
      // restore them — not to re-grant the table privileges.
      const rows = await ctx.su.prisma.$queryRawUnsafe<{ proname: string }[]>(
        `SELECT p.proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN ('audit_log_tenant_migrate', 'audit_log_purge')
            AND p.prosecdef`,
      );
      expect(rows.map((r) => r.proname).sort()).toEqual([
        "audit_log_purge",
        "audit_log_tenant_migrate",
      ]);
    },
  );
});
