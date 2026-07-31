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
import {
  loadDeniedPolicy,
  subjectOf,
  isSequenceEntry,
} from "../../../scripts/lib/denied-privileges.mjs";
// The SAME roster audit-db-grants.mjs audits, not a second hand-picked list
// (C2's "named lists, not literals inline in the assertion").
import { AUDITED_ROLES } from "../../../scripts/audit-db-grants.mjs";

const SKIP = !process.env.DATABASE_URL;

type DeniedEntry = {
  role: string;
  table?: string;
  sequence?: string;
  privileges: string[];
  columnGrants?: Record<string, string[]>;
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
  d.privileges.map((priv) => [d.role, subjectOf(d) as string, priv, d.reason] as const),
);

/**
 * The table cases, carrying the columns the entry SANCTIONS for that privilege.
 *
 * A `columnGrants` entry means the privilege is denied at TABLE level and held
 * on exactly these columns — so the column sweep below asserts an equality, not
 * an emptiness. Both directions matter and only one of them is obvious:
 * a column that should not be granted is over-privilege, and a sanctioned
 * column that has GONE is the sign-in writer losing its INSERT, which is
 * denied first-ever sign-ins rather than a quiet degradation.
 */
const TABLE_CASES = DECLARATION.denied
  .filter((d) => !isSequenceEntry(d))
  .flatMap((d) =>
    d.privileges.map(
      (priv) =>
        [d.role, d.table as string, priv, [...(d.columnGrants?.[priv] ?? [])].sort()] as const,
    ),
  );

/** The sequence cases. Sequences carry their own ACL and their own privilege set. */
const SEQUENCE_CASES = DECLARATION.denied
  .filter(isSequenceEntry)
  .flatMap((d) => d.privileges.map((priv) => [d.role, d.sequence as string, priv] as const));

// C2's fixed shape for this table: all three audited roles, and every privilege
// the grant audit reads — the set was widened from five by a derivation rather
// than case by case (deny everything the role does not need on the two routing
// tables), which is what put TRIGGER on it: a BEFORE INSERT trigger returning
// NULL discards every append while the statement still reports success. Named
// here — not spelled inline inside the assertion below — so the containment
// check in "C2 — tenant_claim_events containment" reads from ONE place, same as
// CASES itself.
const TENANT_CLAIM_EVENTS_TABLE = "public.tenant_claim_events";
const TENANT_CLAIM_EVENTS_DENIED_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];
/**
 * The identity sequence behind `tenant_claim_events.seq`, denied to all three
 * roles (20260731190000). Named for the same reason the table above is.
 */
const TENANT_CLAIM_EVENTS_SEQUENCE = "public.tenant_claim_events_seq_seq";
const TENANT_CLAIM_EVENTS_SEQUENCE_DENIED_PRIVILEGES = ["USAGE", "SELECT", "UPDATE"];

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

  // C2's acceptance criterion, never implemented (QA-2): "assert containment,
  // not a count: for each of the three role names and each of the four
  // privilege names ... the triple (role, "public.tenant_claim_events", priv)
  // is a member of the derived case set." `CASES.length > 0` above is an
  // anti-vacuity floor, not this — it is satisfied by ANY non-empty policy,
  // including one missing every tenant_claim_events entry. A count of
  // CASES.length would also be the wrong shape even if it targeted this
  // table: it reds on a policy TIGHTENING (adding a fifth privilege) and
  // greens on a net-zero WEAKENING (swapping SELECT for REFERENCES) —
  // containment does neither.
  it("CASES contains (role, public.tenant_claim_events, privilege) for every audited role × every denied privilege (C2 containment)", () => {
    // Anti-vacuity floor. The universe is derived from the artifact under audit,
    // so a shrunken roster would execute zero assertions and pass green — and
    // dropping a role from AUDITED_ROLES both stops the auditor checking it and
    // stops this case requiring its policy entry. Membership, not a length:
    // a swap must red too.
    expect(AUDITED_ROLES).toContain("passwd_app");
    expect(AUDITED_ROLES).toContain("passwd_outbox_worker");
    expect(AUDITED_ROLES).toContain("passwd_retention_gc_worker");
    for (const role of AUDITED_ROLES) {
      for (const privilege of TENANT_CLAIM_EVENTS_DENIED_PRIVILEGES) {
        const isMember = CASES.some(
          ([r, table, priv]) => r === role && table === TENANT_CLAIM_EVENTS_TABLE && priv === privilege,
        );
        expect(
          isMember,
          `(${role}, ${TENANT_CLAIM_EVENTS_TABLE}, ${privilege}) must be a member of the derived case set`,
        ).toBe(true);
      }
      // The identity sequence, same containment shape. Declaring it became
      // possible only when the policy gained a sequence subject
      // (20260731190000); before that the migration's REVOKE was undone by
      // every bootstrap run and nothing here could say so.
      for (const privilege of TENANT_CLAIM_EVENTS_SEQUENCE_DENIED_PRIVILEGES) {
        const isMember = SEQUENCE_CASES.some(
          ([r, seq, priv]) =>
            r === role && seq === TENANT_CLAIM_EVENTS_SEQUENCE && priv === privilege,
        );
        expect(
          isMember,
          `(${role}, ${TENANT_CLAIM_EVENTS_SEQUENCE}, ${privilege}) must be a member of the derived sequence case set`,
        ).toBe(true);
      }
    }
  });

  it("the sanctioned INSERT columns on tenant_claim_events are declared (anti-vacuity)", () => {
    // The equality assertion in the table sweep is only meaningful because a
    // non-empty sanctioned set exists to compare against. Deleting
    // `columnGrants` would turn it into "no column holds INSERT" — which is
    // TRUE of a database where the sign-in writer cannot write at all, so the
    // suite would go green on exactly the outage this declaration prevents.
    const insertColumns = TABLE_CASES.find(
      ([role, table, priv]) =>
        role === "passwd_app" && table === TENANT_CLAIM_EVENTS_TABLE && priv === "INSERT",
    )?.[3];
    expect(insertColumns, "passwd_app INSERT on tenant_claim_events must be a declared case").toBeDefined();
    expect(insertColumns).toEqual(
      [
        "actor_label",
        "claim",
        "id",
        "new_revoked_at",
        "new_tenant_id",
        "old_revoked_at",
        "old_tenant_id",
        "operation",
      ],
    );
  });

  it.skipIf(SKIP).each(TABLE_CASES)(
    "%s must NOT hold %s on %s at table level, and holds it on exactly the sanctioned columns",
    async (role, table, privilege, sanctionedColumns) => {
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
      // Equality against the DECLARED set, not emptiness. `columnGrants` makes
      // "denied at table level" and "granted on these columns" one statement,
      // so an extra column is over-privilege and a missing one is the writer
      // broken — and a `REVOKE <priv> ON TABLE` erases column grants of that
      // privilege (measured), so "missing" is the state a convergence run
      // reaches by default rather than an exotic one.
      expect(
        held.map((c) => c.column_name).sort(),
        `${role}'s ${privilege} columns on ${table} must equal the sanctioned set`,
      ).toEqual(sanctionedColumns);
    },
  );

  it.skipIf(SKIP).each(SEQUENCE_CASES)(
    "%s must NOT hold %s on sequence %s",
    async (role, sequence, privilege) => {
      // has_sequence_privilege, not has_table_privilege: a sequence is a
      // distinct object with a distinct ACL, which is exactly why
      // bootstrap-rds-roles.mjs's `GRANT USAGE, SELECT ON ALL SEQUENCES` could
      // undo a migration's REVOKE without any table-level check noticing.
      const [row] = await ctx.su.prisma.$queryRawUnsafe<{ granted: boolean }[]>(
        `SELECT has_sequence_privilege($1, $2, $3) AS granted`,
        role,
        sequence,
        privilege,
      );
      expect(row.granted, `${role} holds ${privilege} on ${sequence}`).toBe(false);
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
