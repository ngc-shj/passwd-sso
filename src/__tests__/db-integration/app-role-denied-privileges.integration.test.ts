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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestContext, type TestContext } from "./helpers";

const SKIP = !process.env.DATABASE_URL;

type DeniedEntry = {
  role: string;
  table: string;
  privileges: string[];
  reason: string;
};

const DECLARATION = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../scripts/checks/app-role-denied-privileges.json"),
    "utf8",
  ),
) as { denied: DeniedEntry[] };

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
    "%s must NOT hold %s on %s",
    async (role, table, privilege) => {
      const [row] = await ctx.su.prisma.$queryRawUnsafe<{ granted: boolean }[]>(
        `SELECT has_table_privilege($1, $2, $3) AS granted`,
        role,
        table,
        privilege,
      );
      expect(row.granted, `${role} holds ${privilege} on ${table}`).toBe(false);
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
