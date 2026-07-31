/**
 * Real-DB integration tests for C1 — the `tenant_claims` table, its
 * normalisation CHECK, RLS isolation, cascade, and the backfill statement.
 *
 * Every assertion here is adjudicated by Postgres, not by a mock (round-1
 * Testing F8): the unique index, the CHECK constraint, the FK cascade, RLS,
 * and the backfill all run against the real database.
 *
 * F15 — the dev database is shared between working copies and
 * UNIQUE(tenant_claims.claim) is deployment-global, so every claim literal
 * this file inserts is derived from the shared fixtures with a random
 * per-run suffix rather than the bare fixture constant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import {
  createTestContext,
  setBypassRlsGucs,
  createPrismaForRole,
  raceTwoClients,
  type TestContext,
  type PrismaWithPool,
  sqlStateOf,
} from "./helpers";
import {
  findOrCreateTenantForClaim,
  resolveTenantByClaim,
} from "@/lib/tenant/tenant-management";
import { slugifyTenant } from "@/lib/tenant/tenant-claim";
import {
  normalizeTenantClaim,
  storableClaimSchema,
} from "@/lib/tenant/tenant-claim-registry";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  TENANT_CLAIM_EVENT_OPERATION,
  SIGNIN_ACTOR_LABEL,
} from "@/lib/tenant/tenant-claim-event";
import {
  PRIMARY_CLAIM,
  ALIAS_CLAIM,
  NON_DOMAIN_CLAIM,
  runToken,
} from "@/__tests__/helpers/tenant-claim-fixtures";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BACKFILL_SQL_PATH = resolve(REPO_ROOT, "scripts/lib/tenant-claim-backfill.sql");
const MIGRATION_SQL_PATH = resolve(
  REPO_ROOT,
  "prisma/migrations/20260729110000_add_tenant_claims/migration.sql",
);

const SKIP = !process.env.DATABASE_URL;


/**
 * A CHECK violation surfaces through Prisma as P2010 with the underlying
 * Postgres SQLSTATE (23514 = check_violation) somewhere in meta — same
 * detection shape as audit-outbox-concurrent-delivery.integration.test.ts's
 * isLockTimeoutError. The exact nesting depends on the driver adapter: the
 * `@prisma/adapter-pg` path used by this repo wraps it as
 * `meta.driverAdapterError.cause.code`, not the flatter `meta.code` some
 * other Prisma configurations surface, so both are checked defensively.
 */
function isCheckViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2010") {
    return false;
  }
  return sqlStateOf(err) === "23514";
}

describe("tenant_claims (C1)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });

  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  describe("uniqueness (I1)", () => {
    it.skipIf(SKIP)("second insert of an existing claim rejects with P2002 through the model API", async () => {
      const tenantA = await ctx.createTenant();
      const tenantB = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      await ctx.su.prisma.tenantClaim.create({
        data: { tenantId: tenantA, claim },
      });

      let caught: unknown;
      try {
        await ctx.su.prisma.tenantClaim.create({
          data: { tenantId: tenantB, claim },
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");

      await ctx.deleteTestData(tenantA);
      await ctx.deleteTestData(tenantB);
    });
  });

  describe("normalisation CHECK", () => {
    it.skipIf(SKIP)("a mixed-case claim is rejected by the CHECK, not by any Prisma error code", async () => {
      const tenantA = await ctx.createTenant();
      const claim = `${runToken()}-${ALIAS_CLAIM.replace("alias", "Alias").replace("example", "Example")}`;
      // Sanity: the literal we are about to insert really is mixed-case.
      expect(claim).not.toBe(claim.toLowerCase());

      let caught: unknown;
      try {
        await ctx.su.prisma.$executeRawUnsafe(
          `INSERT INTO tenant_claims (id, tenant_id, claim) VALUES ($1::uuid, $2::uuid, $3)`,
          randomUUID(),
          tenantA,
          claim,
        );
      } catch (e) {
        caught = e;
      }

      expect(isCheckViolation(caught)).toBe(true);

      await ctx.deleteTestData(tenantA);
    });

    it.skipIf(SKIP)("a normalised, ASCII, non-empty claim is accepted", async () => {
      const tenantA = await ctx.createTenant();
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

      await expect(
        ctx.su.prisma.$executeRawUnsafe(
          `INSERT INTO tenant_claims (id, tenant_id, claim) VALUES ($1::uuid, $2::uuid, $3)`,
          randomUUID(),
          tenantA,
          claim,
        ),
      ).resolves.not.toThrow();

      await ctx.deleteTestData(tenantA);
    });
  });

  /**
   * Normalisation equivalence (plan C1, RT1 / round-1 M6). Feeds an
   * adversarial table through the REAL `normalizeTenantClaim` in JS and hands
   * the result to Postgres: every value must either pass the CHECK and
   * round-trip byte-identically, or be rejected by `storableClaimSchema`
   * before the insert AND by the CHECK when the insert is attempted anyway.
   *
   * This is the assertion that pins the two engines against each other. The
   * unit test in `tenant-claim-registry.test.ts` runs the SQL character class
   * through `new RegExp` in V8, so it cannot observe a Postgres/JS divergence
   * at all — only a real INSERT can.
   */
  describe("normalisation equivalence (RT1)", () => {
    /**
     * `t` is a per-case ASCII uniquifier (UNIQUE(claim) is deployment-global,
     * F15). Every case keeps the property it is named for after prefixing.
     */
    const ADVERSARIAL_CLAIMS: ReadonlyArray<{ label: string; raw: (t: string) => string }> = [
      { label: "already normalised ASCII", raw: (t) => `${t}-alias.example` },
      { label: "mixed case", raw: (t) => `${t}-Alias.Example` },
      { label: "surrounding whitespace", raw: (t) => `  ${t}-alias.example \t ` },
      { label: "uppercase non-domain claim", raw: (t) => `${t}-ACMECORP` },
      { label: "U+00E9 — café", raw: (t) => `${t}-café.example` },
      { label: "full-width CJK", raw: (t) => `${t}-全角.example` },
      { label: "U+00DF — ß, no ASCII lowercase form", raw: (t) => `${t}-ß.example` },
      // U+0130: JS lowercases it to "i" + U+0307 COMBINING DOT ABOVE while
      // Postgres `lower(x COLLATE "C")` leaves it untouched — the exact D3
      // divergence the printable-ASCII narrowing exists to make unreachable.
      { label: "U+0130 — Turkish dotted capital I", raw: (t) => `${t}-İ.example` },
      { label: "whitespace only", raw: () => "  \t " },
    ];

    it.skipIf(SKIP)(
      "every adversarial value either round-trips byte-identically or is rejected by both storableClaimSchema and the CHECK",
      async () => {
        const tenantId = await ctx.createTenant();
        const token = runToken();
        let acceptedCount = 0;
        let rejectedCount = 0;

        try {
          for (const [i, testCase] of ADVERSARIAL_CLAIMS.entries()) {
            const raw = testCase.raw(`${token}c${i}`);
            const normalised = normalizeTenantClaim(raw);
            const accepted = storableClaimSchema.safeParse(normalised).success;

            let caught: unknown;
            try {
              await ctx.su.prisma.$executeRawUnsafe(
                `INSERT INTO tenant_claims (id, tenant_id, claim) VALUES ($1::uuid, $2::uuid, $3)`,
                randomUUID(),
                tenantId,
                normalised,
              );
            } catch (e) {
              caught = e;
            }

            if (accepted) {
              acceptedCount++;
              expect(caught, `${testCase.label}: insert must succeed`).toBeUndefined();
              const stored = await ctx.su.prisma.tenantClaim.findUnique({
                where: { claim: normalised },
                select: { claim: true },
              });
              // This is the equivalence M6 asked for: what JS accepted, the
              // CHECK stores unchanged.
              expect(stored?.claim, testCase.label).toBe(normalised);
              // The byte comparison guards the ENCODING round-trip (driver
              // and column collation), not folding: `tenant_claims_claim_
              // normalized` is a CHECK predicate, not a BEFORE INSERT
              // trigger, so Postgres never rewrites the stored string, and
              // every value reaching this arm is printable ASCII by
              // construction. It cannot detect a re-fold — the assertion
              // above is what carries that.
              expect(
                Buffer.from(stored?.claim ?? "", "utf8").equals(Buffer.from(normalised, "utf8")),
                `${testCase.label}: byte identity`,
              ).toBe(true);
            } else {
              rejectedCount++;
              expect(isCheckViolation(caught), `${testCase.label}: CHECK must reject`).toBe(true);
            }
          }
        } finally {
          await ctx.deleteTestData(tenantId);
        }

        // Anti-vacuity: the table has to drive both arms, or the loop above
        // proves only one half of the equivalence.
        expect(acceptedCount).toBeGreaterThan(0);
        expect(rejectedCount).toBeGreaterThan(0);
      },
    );
  });

  describe("non-domain claim (NF2)", () => {
    it.skipIf(SKIP)("a non-domain claim like acmecorp inserts successfully", async () => {
      const tenantA = await ctx.createTenant();
      const claim = `${runToken()}-${NON_DOMAIN_CLAIM}`;
      expect(claim).not.toContain(".");

      await expect(
        ctx.su.prisma.tenantClaim.create({ data: { tenantId: tenantA, claim } }),
      ).resolves.toMatchObject({ claim });

      await ctx.deleteTestData(tenantA);
    });
  });

  describe("cascade on tenant delete (I2)", () => {
    it.skipIf(SKIP)("deleting the tenant deletes its dependent tenant_claims rows", async () => {
      const tenantA = await ctx.createTenant();
      const claim = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: tenantA, claim } });

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantA);
      });

      const remaining = await ctx.su.prisma.tenantClaim.findMany({ where: { claim } });
      expect(remaining).toHaveLength(0);
    });
  });

  describe("RLS isolation (I3)", () => {
    it.skipIf(SKIP)("passwd_app with app.tenant_id=A cannot see tenant B's claim rows", async () => {
      const tenantA = await ctx.createTenant();
      const tenantB = await ctx.createTenant();
      const claimB = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: tenantB, claim: claimB } });

      const rows = await ctx.app.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'off', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
        return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
          `SELECT COUNT(*) AS cnt FROM tenant_claims WHERE tenant_id = $1::uuid`,
          tenantB,
        );
      });
      expect(Number(rows[0].cnt)).toBe(0);

      await ctx.deleteTestData(tenantA);
      await ctx.deleteTestData(tenantB);
    });

    it.skipIf(SKIP)("passwd_app with app.tenant_id=B can see its own claim rows", async () => {
      const tenantA = await ctx.createTenant();
      const tenantB = await ctx.createTenant();
      const claimB = `${runToken()}.${PRIMARY_CLAIM}`;
      await ctx.su.prisma.tenantClaim.create({ data: { tenantId: tenantB, claim: claimB } });

      const rows = await ctx.app.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'off', true)`;
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantB}, true)`;
        return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
          `SELECT COUNT(*) AS cnt FROM tenant_claims WHERE tenant_id = $1::uuid`,
          tenantB,
        );
      });
      expect(Number(rows[0].cnt)).toBe(1);

      await ctx.deleteTestData(tenantA);
      await ctx.deleteTestData(tenantB);
    });
  });

  describe("backfill (round-3 CR11)", () => {
    /**
     * Executes scripts/lib/tenant-claim-backfill.sql exactly as written
     * (comment lines stripped) against the real database. Unlike the
     * revision-3 form this test replaces, this runs AFTER migrate — against
     * tenants created fresh by this test, which the migration-time backfill
     * never saw — so deleting the INSERT from the file leaves this
     * assertion red, not green.
     *
     * The statement is unavoidably unscoped here: the D-7 drift guard pins it
     * byte-for-byte against the migration's copy, so it cannot be given a
     * test-only WHERE clause without breaking the guard that keeps the two
     * copies honest. On the shared dev database it therefore also writes rows
     * for tenants other working copies own. `ownTenantIds` bounds the blast
     * radius: every row this execution added outside those tenants is deleted
     * afterwards (round-1 Test F13). Rows that already existed — including the
     * real migration's own `created_by = 'backfill'` rows — are identified by
     * an id snapshot and left alone; a blanket
     * `deleteMany({ createdBy: "backfill" })` would destroy them.
     */
    async function runBackfillFile(ownTenantIds: string[]): Promise<void> {
      const raw = readFileSync(BACKFILL_SQL_PATH, "utf8");
      const sql = raw
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();

      const before = await ctx.su.prisma.tenantClaim.findMany({ select: { id: true } });
      const preexisting = before.map((r) => r.id);
      try {
        await ctx.su.prisma.$executeRawUnsafe(sql);
      } finally {
        await ctx.su.prisma.tenantClaim.deleteMany({
          where: {
            createdBy: "backfill",
            id: { notIn: preexisting },
            tenantId: { notIn: ownTenantIds },
          },
        });
      }
    }

    async function createTenantWithExternalId(externalId: string | null): Promise<string> {
      const id = randomUUID();
      const slug = `tc-bf-${id.replace(/-/g, "").slice(0, 16)}`;
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO tenants (id, name, slug, external_id, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, $4, now(), now())`,
          id,
          `test-tenant-bf-${id.slice(0, 8)}`,
          slug,
          externalId,
        );
      });
      return id;
    }

    it.skipIf(SKIP)(
      "backfills external_id into tenant_claims, excludes BOTH sides of a normalisation collision, and skips a non-ASCII value entirely (SC9)",
      async () => {
        const token = runToken();
        const mixedCase = `${token}-Alias.Example`;
        const paddedLower = ` ${token}-alias.example `; // normalises to the SAME claim as mixedCase
        const normalised = `${token}-alias.example`;
        const nonDomain = `${token}-acmecorp`;
        const nonAscii = `${token}-café.example`; // 'é' — SC9's ASCII narrowing

        const tenantMixedCase = await createTenantWithExternalId(mixedCase);
        const tenantPaddedLower = await createTenantWithExternalId(paddedLower);
        const tenantNonDomain = await createTenantWithExternalId(nonDomain);
        const tenantNull = await createTenantWithExternalId(null);
        const tenantNonAscii = await createTenantWithExternalId(nonAscii);
        const allTenants = [
          tenantMixedCase,
          tenantPaddedLower,
          tenantNonDomain,
          tenantNull,
          tenantNonAscii,
        ];

        // Scoped delete only — never DELETE FROM tenant_claims unscoped
        // (round-4 T35), since that would destroy every other tenant's rows
        // in this shared dev database.
        await ctx.su.prisma.tenantClaim.deleteMany({
          where: { tenantId: { in: allTenants } },
        });

        await runBackfillFile(allTenants);

        // Round-1 M3: NEITHER side of the collision may take the claim. The
        // two tenants are distinct today — the pre-PR resolver matched
        // external_id exactly — so handing the claim to one of them would put
        // the other's NEW members into the winner's tenant, silently.
        const collisionRows = await ctx.su.prisma.tenantClaim.findMany({
          where: { tenantId: { in: [tenantMixedCase, tenantPaddedLower] } },
        });
        expect(collisionRows).toHaveLength(0);
        const rowsForFoldedClaim = await ctx.su.prisma.tenantClaim.findMany({
          where: { claim: normalised },
        });
        expect(rowsForFoldedClaim).toHaveLength(0);

        // The security property the exclusion exists for: with no claim row,
        // release-1's exact-match external_id fallback still resolves each
        // colliding tenant to ITSELF — neither resolves to the other.
        const resolvedMixedCase = await resolveTenantByClaim(mixedCase, ctx.su.prisma);
        const resolvedPaddedLower = await resolveTenantByClaim(paddedLower, ctx.su.prisma);
        expect(resolvedMixedCase).toEqual({ kind: "tenant", id: tenantMixedCase });
        expect(resolvedPaddedLower).toEqual({ kind: "tenant", id: tenantPaddedLower });

        const nonDomainRows = await ctx.su.prisma.tenantClaim.findMany({
          where: { tenantId: tenantNonDomain },
        });
        expect(nonDomainRows).toHaveLength(1);
        expect(nonDomainRows[0].claim).toBe(nonDomain);

        const nullRows = await ctx.su.prisma.tenantClaim.findMany({
          where: { tenantId: tenantNull },
        });
        expect(nullRows).toHaveLength(0);

        // SC9: a non-ASCII external_id produces NO row — the narrowing made visible.
        const nonAsciiRows = await ctx.su.prisma.tenantClaim.findMany({
          where: { tenantId: tenantNonAscii },
        });
        expect(nonAsciiRows).toHaveLength(0);

        for (const tenantId of allTenants) {
          await ctx.deleteTestData(tenantId);
        }
      },
    );

    it("the migration file contains the backfill statement verbatim (drift guard)", () => {
      const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

      const backfillRaw = readFileSync(BACKFILL_SQL_PATH, "utf8");
      const migrationRaw = readFileSync(MIGRATION_SQL_PATH, "utf8");

      const STATEMENT_RE =
        /INSERT INTO tenant_claims[\s\S]*?ON CONFLICT \(claim\) DO NOTHING;/;

      const backfillStatement = backfillRaw.match(STATEMENT_RE)?.[0];
      const migrationStatement = migrationRaw.match(STATEMENT_RE)?.[0];

      expect(backfillStatement).toBeDefined();
      expect(migrationStatement).toBeDefined();
      expect(normalize(migrationStatement ?? "")).toBe(normalize(backfillStatement ?? ""));
    });
  });
});

/**
 * Real-DB integration tests for C4 — `findOrCreateTenantForClaim`'s
 * atomicity and concurrency guarantees. Round-3 T24 established these
 * cannot be proven against a passthrough `$transaction` mock (which models
 * no rollback); Postgres is the adjudicator here, not vitest mocks.
 */
describe("findOrCreateTenantForClaim (C4)", () => {
  let ctx: TestContext;
  let second: PrismaWithPool;
  /** The live role name this connection authenticates as (VE5) — never a literal. */
  let dbUser: string;

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
    second = createPrismaForRole("app");
    const [row] = await ctx.su.prisma.$queryRaw<{ dbUser: string }[]>`SELECT current_user AS "dbUser"`;
    dbUser = row.dbUser;
  });

  afterAll(async () => {
    if (SKIP) return;
    await second.prisma.$disconnect().then(() => second.pool.end());
    await ctx.cleanup();
  });

  it.skipIf(SKIP)(
    "two concurrent calls for the same claim create exactly one tenant and one claim row, and both callers get the same id (advisory lock proof)",
    async () => {
      // 50 iterations, per raceTwoClients' own contract (helpers.ts:353-363)
      // and both in-repo precedents. A single Promise.all on a pooled DB
      // frequently serialises without contention, so one iteration stays
      // green even with advisoryXactLock removed — and this is C4's only
      // real-Postgres proof of I6.
      const ITERATIONS = 50;
      const claims: string[] = [];

      try {
        for (let i = 0; i < ITERATIONS; i++) {
          const claim = `${runToken()}i${i}.${ALIAS_CLAIM}`;
          claims.push(claim);

          const [resultA, resultB] = await raceTwoClients(
            ctx.app.prisma,
            second.prisma,
            (c) =>
              withBypassRls(
                c,
                (tx) => findOrCreateTenantForClaim(claim, tx),
                BYPASS_PURPOSE.AUTH_FLOW,
              ),
            (c) =>
              withBypassRls(
                c,
                (tx) => findOrCreateTenantForClaim(claim, tx),
                BYPASS_PURPOSE.AUTH_FLOW,
              ),
          );

          // Narrow before comparing ids: a non-"tenant" kind is a distinct
          // failure from a mismatched id and must not be reported as one.
          if (resultA.kind !== "tenant") {
            throw new Error(`iteration ${i}: client A returned ${resultA.kind}`);
          }
          if (resultB.kind !== "tenant") {
            throw new Error(`iteration ${i}: client B returned ${resultB.kind}`);
          }
          // Production code created this tenant, so ctx knows nothing about
          // it until told (round-3 M8). Registered before the assertions
          // below, not after, since it is the assertions that throw.
          ctx.trackTenant(resultA.id);
          expect(resultB.id).toBe(resultA.id);

          const claimRows = await ctx.su.prisma.tenantClaim.findMany({ where: { claim } });
          expect(claimRows).toHaveLength(1);
          expect(claimRows[0].tenantId).toBe(resultA.id);

          const tenantRows = await ctx.su.prisma.tenant.findMany({ where: { externalId: claim } });
          expect(tenantRows).toHaveLength(1);

          await ctx.deleteTestData(resultA.id);
        }
      } finally {
        // Sweeps the iteration that threw, if any — the per-iteration delete
        // above never runs for it, and this file's tenants must not outlive
        // the run on a shared database.
        const leftovers = await ctx.su.prisma.tenant.findMany({
          where: { externalId: { in: claims } },
          select: { id: true },
        });
        for (const leftover of leftovers) {
          await ctx.deleteTestData(leftover.id);
        }
      }
    },
    180_000,
  );

  it.skipIf(SKIP)(
    "a forced failure in the nested claim insert leaves neither the tenant nor the claim row (nested-write atomicity)",
    async () => {
      // Exercises the exact nested-create shape findOrCreateTenantForClaim
      // uses (tenant.create with a nested claims.create) directly, with a
      // claim value that violates the C1 CHECK constraint — this forces the
      // CHILD insert to fail while the PARENT insert has already been
      // issued in the same statement sequence. findOrCreateTenantForClaim's
      // own storableClaimSchema guard (step 5) would reject this claim
      // before ever reaching create(), so this proof goes around the public
      // function to reach the state it exists to prevent, and confirms
      // Prisma's nested-write form rolls back both sides together.
      const token = runToken();
      const badClaim = `${token}-Mixed-Case`; // uppercase — fails tenant_claims_claim_normalized
      const externalId = `${token}-atomic-fail`;
      const slug = `tc-atomic-${token}`;

      let caught: unknown;
      try {
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.tenant.create({
            data: {
              externalId,
              name: externalId,
              slug,
              claims: { create: { claim: badClaim, createdBy: "test" } },
            },
          });
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeDefined();

      const tenantRows = await ctx.su.prisma.tenant.findMany({ where: { externalId } });
      expect(tenantRows).toHaveLength(0);

      const claimRows = await ctx.su.prisma.tenantClaim.findMany({ where: { claim: badClaim } });
      expect(claimRows).toHaveLength(0);
    },
  );

  it.skipIf(SKIP)(
    "a slug collision between two different claims produces two tenants with distinct slugs and no error (SAVEPOINT retry proof)",
    async () => {
      const token = runToken();
      // slugifyTenant collapses [^a-z0-9]+, so a dot-separated and a
      // hyphen-separated spelling of the same words slugify identically —
      // the residual P2002 the advisory lock (keyed on the claim, not the
      // slug) does not serialise.
      const claimA = `${token}.${ALIAS_CLAIM}`;
      const claimB = `${token}-${ALIAS_CLAIM.replace(".", "-")}`;
      expect(claimA).not.toBe(claimB);
      expect(slugifyTenant(claimA)).toBe(slugifyTenant(claimB));

      const created: Array<{ id: string }> = [];
      // Runs both calls inside ONE real transaction (not two separate
      // withBypassRls calls) so a missing SAVEPOINT would surface as 25P02
      // on the second call rather than being silently absorbed by a fresh
      // transaction — the real-Postgres proof round-4 required.
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        const resultA = await findOrCreateTenantForClaim(claimA, tx);
        const resultB = await findOrCreateTenantForClaim(claimB, tx);
        if (resultA.kind !== "tenant") throw new Error(`claimA returned ${resultA.kind}`);
        if (resultB.kind !== "tenant") throw new Error(`claimB returned ${resultB.kind}`);
        // Tracked before the assertion that can throw, and tracked at all
        // because production code — not ctx.createTenant() — created these
        // (round-3 M8). Without it, a red here left two tenants and their
        // UNIQUE(claim) rows on the shared dev database, and the claim rows
        // then collide with the next run of this same test.
        created.push({ id: resultA.id });
        created.push({ id: resultB.id });
        ctx.trackTenant(resultA.id);
        ctx.trackTenant(resultB.id);
        expect(resultA.id).not.toBe(resultB.id);
      });

      try {
        const tenants = await ctx.su.prisma.tenant.findMany({
          where: { id: { in: created.map((c) => c.id) } },
        });
        expect(tenants).toHaveLength(2);
        expect(tenants[0].slug).not.toBe(tenants[1].slug);
      } finally {
        // The assertions above are outside the transaction, so a red one
        // leaves committed rows behind. ctx.trackTenant is the backstop; this
        // keeps the common path from depending on it.
        for (const c of created) {
          await ctx.deleteTestData(c.id);
        }
      }
    },
  );

  /**
   * Round-3 M6 + M2. `claim_collision` — the arm that refuses to create a
   * tenant when an existing tenant's `external_id` FOLDS onto the claim —
   * had only mocked coverage, and the fold it depends on is a JS/Postgres
   * pair: `normalizeTenantClaim` in JS decides what to look up,
   * `lower(btrim(x) COLLATE "C")` in Postgres decides what matches. That is
   * exactly the round-1 M6/D3 class, where a unit test running the SQL class
   * through V8 cannot observe a divergence at all.
   *
   * It also pins M2's `ORDER BY`: a collision has two sides by construction,
   * so the arm must name the SAME one every time — the tenant id it reports
   * binds the AUTH_LOGIN_FAILURE row, and an unordered `LIMIT 1` would split
   * one lockout across two `tenant-domain unmapped` groups.
   */
  it.skipIf(SKIP)(
    "refuses to create for a third spelling that folds onto existing tenants, and names the oldest colliding tenant every time",
    async () => {
      const token = runToken();
      // Two tenants whose RAW external_ids differ but FOLD to the same claim.
      // Round-1 M3's backfill excludes both sides, so neither holds a claim
      // row and the UNIQUE(claim) slot is free — the round-2 F-A shape.
      // Round-4 T3. The two ids come from randomUUID(), so assigning
      // created_at by insertion order distinguished `ORDER BY created_at` from
      // `ORDER BY id` only about half the time — and for a NONDETERMINISM bug
      // a fixture that is right half the time is on the wrong side of the
      // line. Assign the OLDER created_at to whichever id sorts LARGER, and
      // `ORDER BY id ASC` is deterministically wrong.
      const [a, b] = [await ctx.createTenant(), await ctx.createTenant()];
      const older = a > b ? a : b;
      const newer = a > b ? b : a;
      expect(older > newer).toBe(true);
      const foldedClaim = `${token}-alias.example`;

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `UPDATE tenants SET external_id = $2, created_at = now() - interval '2 days' WHERE id = $1::uuid`,
          older,
          `${token}-Alias.Example`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE tenants SET external_id = $2, created_at = now() - interval '1 day' WHERE id = $1::uuid`,
          newer,
          ` ${token}-ALIAS.EXAMPLE `,
        );
      });

      // Neither raw spelling equals the folded claim, so the exact-match
      // externalId fallback cannot resolve it — the probe is the only thing
      // standing between a third spelling and a NEW tenant that would
      // register the claim and outrank both existing tenants' fallback.
      expect(normalizeTenantClaim(`${token}-Alias.Example`)).toBe(foldedClaim);
      expect(normalizeTenantClaim(` ${token}-ALIAS.EXAMPLE `)).toBe(foldedClaim);

      try {
        // Repeated because the defect M2 fixes is NONDETERMINISM — but the
        // deterministic fixture above is what actually pins it; the loop only
        // guards against a plan that varies between identical calls.
        for (let i = 0; i < 5; i++) {
          const result = await withBypassRls(
            ctx.su.prisma,
            (tx) => findOrCreateTenantForClaim(`${token}-aLiAs.ExAmPlE`, tx),
            BYPASS_PURPOSE.AUTH_FLOW,
          );
          expect(result).toEqual({ kind: "claim_collision", tenantId: older });
        }

        // The refusal is the point: no tenant created for this claim, and the
        // free UNIQUE(claim) slot is still free for the operator's explicit
        // `tenant-domain add`. Round-4 T9: scoped to this test's own token —
        // an unscoped global `tenant.count()` on the shared dev database is
        // reddened by any concurrent insert from another working copy.
        expect(
          await ctx.su.prisma.tenant.count({ where: { externalId: { contains: token } } }),
        ).toBe(2);
        expect(
          await ctx.su.prisma.tenantClaim.findMany({ where: { claim: foldedClaim } }),
        ).toHaveLength(0);
      } finally {
        // Round-4 T9: the sibling test was restructured for exactly this in
        // the previous round and this one was not.
        await ctx.deleteTestData(older);
        await ctx.deleteTestData(newer);
      }
    },
  );

  /**
   * The `id ASC` tie-break, which the created_at fixture above cannot reach
   * (round-4 T3): two tenants sharing a `created_at` to the microsecond is
   * what the second sort key exists for, and without a case for it the clause
   * could be deleted with everything still green.
   */
  /**
   * Round-6 T4. Round 5 tried to make this deterministic with a no-op
   * `UPDATE tenants SET external_id = external_id` that rewrote the lower id's
   * heap tuple last. **That fix does not work, and the mechanism it named is not
   * the one at play.** Measured plan for `findFoldedExternalIdOwner` against the
   * dev database:
   *
   *     Limit -> Sort (Sort Key: created_at, id)
   *               -> Index Scan using tenants_external_id_key
   *                    Index Cond: (external_id IS NOT NULL)
   *                    Filter: lower(btrim(external_id)) = $1
   *
   * Heap order is never consulted. What decided the pre-fix redness was the
   * order the two rows arrive in from the `external_id` index — Postgres's
   * quicksort leaves equal keys in input order for a 2-element run — and that
   * order is a property of the two `external_id` VALUES, which the fixture
   * assigns but never pins. Swapping which tenant gets the leading-space
   * spelling turns the round-5 version GREEN under the same mutation.
   *
   * So the fixture is parameterised over both assignments instead. Dropping
   * `id ASC` reds at least one arm whichever way the index happens to order the
   * two spellings, and neither arm depends on a property nothing states.
   */
  it.each([
    ["lower id holds the leading-space spelling", true],
    ["higher id holds the leading-space spelling", false],
  ] as const)(
    "breaks a created_at tie on id, deterministically (%s)",
    async (_label, leadingSpaceOnLowerId) => {
      if (SKIP) return;
      const token = runToken();
      const [a, b] = [await ctx.createTenant(), await ctx.createTenant()];
      const lowerId = a < b ? a : b;
      const higherId = a < b ? b : a;
      // The two raw spellings fold together and neither equals the folded
      // claim, so only the probe can resolve it. Which tenant gets which is the
      // parameter.
      const spaced = ` ${token}-TIE.EXAMPLE `;
      const plain = `${token}-Tie.Example`;
      const forLower = leadingSpaceOnLowerId ? spaced : plain;
      const forHigher = leadingSpaceOnLowerId ? plain : spaced;

      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        // Identical created_at, set in one statement so the two cannot drift.
        await tx.$executeRawUnsafe(
          `UPDATE tenants
              SET external_id = CASE id WHEN $1::uuid THEN $3 ELSE $4 END,
                  created_at = timestamptz '2020-01-01 00:00:00+00'
            WHERE id IN ($1::uuid, $2::uuid)`,
          lowerId,
          higherId,
          forLower,
          forHigher,
        );
      });

      try {
        const result = await withBypassRls(
          ctx.su.prisma,
          (tx) => findOrCreateTenantForClaim(`${token}-tIe.ExAmPlE`, tx),
          BYPASS_PURPOSE.AUTH_FLOW,
        );
        expect(result).toEqual({ kind: "claim_collision", tenantId: lowerId });
      } finally {
        await ctx.deleteTestData(a);
        await ctx.deleteTestData(b);
      }
    },
  );

  // C4 acceptance criteria: the two member-set writers that live in this
  // module (register via the sign-in path — first-create and slug-retry
  // create), the atomicity of the in-transaction write, NF1's negative, and
  // the fail-closed direction (RT10).
  describe("tenant_claim_events (C4)", () => {
    it.skipIf(SKIP)(
      "register (first-create, sign-in path): event matches C1's population table",
      async () => {
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        const result = await withBypassRls(
          ctx.su.prisma,
          (tx) => findOrCreateTenantForClaim(claim, tx),
          BYPASS_PURPOSE.AUTH_FLOW,
        );
        if (result.kind !== "tenant") throw new Error(`unexpected ${result.kind}`);
        ctx.trackTenant(result.id);

        try {
          const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
          expect(events).toHaveLength(1);
          const event = events[0];
          expect(event.operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REGISTER);
          expect(event.oldTenantId).toBeNull();
          expect(event.newTenantId).toBe(result.id);
          expect(event.oldRevokedAt).toBeNull();
          expect(event.newRevokedAt).toBeNull();
          expect(event.actorLabel).toBe(SIGNIN_ACTOR_LABEL);
          // VE5: never a literal — passwd_user locally, postgres in CI.
          expect(event.dbUser).toBe(dbUser);
        } finally {
          await ctx.deleteTestData(result.id);
        }
      },
    );

    it.skipIf(SKIP)(
      "register (slug-retry, sign-in path): event matches C1's population table — RT4: the retry is proven to have run (random-hex slug suffix) before exactly one event is asserted",
      async () => {
        const token = runToken();
        // Same slug-collision shape as the SAVEPOINT retry proof above, but
        // as two SEPARATE top-level calls (each its own transaction): claimA
        // commits first with the plain slug, so claimB's own SAVEPOINT retry
        // is forced by a REAL, already-committed tenants_slug_key collision
        // rather than by interleaving within one shared transaction.
        const claimA = `${token}.${ALIAS_CLAIM}`;
        const claimB = `${token}-${ALIAS_CLAIM.replace(".", "-")}`;
        expect(claimA).not.toBe(claimB);
        expect(slugifyTenant(claimA)).toBe(slugifyTenant(claimB));
        const plainSlug = slugifyTenant(claimB);

        const resultA = await withBypassRls(
          ctx.su.prisma,
          (tx) => findOrCreateTenantForClaim(claimA, tx),
          BYPASS_PURPOSE.AUTH_FLOW,
        );
        if (resultA.kind !== "tenant") throw new Error(`claimA returned ${resultA.kind}`);
        ctx.trackTenant(resultA.id);

        const resultB = await withBypassRls(
          ctx.su.prisma,
          (tx) => findOrCreateTenantForClaim(claimB, tx),
          BYPASS_PURPOSE.AUTH_FLOW,
        );
        if (resultB.kind !== "tenant") throw new Error(`claimB returned ${resultB.kind}`);
        ctx.trackTenant(resultB.id);

        try {
          // RT4 lower bound: without this, "exactly one event" below would
          // also pass for an implementation that never enters the retry arm
          // at all (e.g. one where the collision never actually occurred).
          const tenantB = await ctx.su.prisma.tenant.findUniqueOrThrow({ where: { id: resultB.id } });
          expect(tenantB.slug).not.toBe(plainSlug);
          expect(tenantB.slug).toMatch(/-[0-9a-f]{8}$/);

          const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim: claimB } });
          expect(events).toHaveLength(1);
          const event = events[0];
          expect(event.operation).toBe(TENANT_CLAIM_EVENT_OPERATION.REGISTER);
          expect(event.oldTenantId).toBeNull();
          expect(event.newTenantId).toBe(resultB.id);
          expect(event.oldRevokedAt).toBeNull();
          expect(event.newRevokedAt).toBeNull();
          expect(event.actorLabel).toBe(SIGNIN_ACTOR_LABEL);
          expect(event.dbUser).toBe(dbUser);
        } finally {
          await ctx.deleteTestData(resultA.id);
          await ctx.deleteTestData(resultB.id);
        }
      },
    );

    it.skipIf(SKIP)(
      "NF1: a sign-in resolving an already-registered claim leaves the event count for that claim unchanged",
      async () => {
        const tenantId = await ctx.createTenant();
        const claim = `${runToken()}.${ALIAS_CLAIM}`;
        await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "seed" } });

        const before = await ctx.su.prisma.tenantClaimEvent.count({ where: { claim } });

        const result = await withBypassRls(
          ctx.su.prisma,
          (tx) => findOrCreateTenantForClaim(claim, tx),
          BYPASS_PURPOSE.AUTH_FLOW,
        );
        expect(result).toEqual({ kind: "tenant", id: tenantId });

        const after = await ctx.su.prisma.tenantClaimEvent.count({ where: { claim } });
        expect(after).toBe(before);

        await ctx.deleteTestData(tenantId);
      },
    );

    it.skipIf(SKIP)(
      "atomicity, both directions: an abort issued AFTER the mutation and the event are both in the transaction rolls back both; an ordinary commit keeps both",
      async () => {
        const token = runToken();
        const abortedClaim = `${token}-abort.${ALIAS_CLAIM}`;
        const committedClaim = `${token}-commit.${ALIAS_CLAIM}`;

        // Direction 1 — abort AFTER both writes are issued. Not a JS throw
        // placed before either statement runs (which would make "neither
        // row" trivially true and prove nothing about whether the event
        // write is really inside the mutation's own transaction): the abort
        // here is a real statement, issued only once findOrCreateTenantForClaim
        // has already returned successfully — i.e. after the tenant/claim
        // write AND the recordTenantClaimEvent INSERT have both been sent.
        let caught: unknown;
        try {
          await ctx.su.prisma.$transaction(async (tx) => {
            await setBypassRlsGucs(tx);
            const result = await findOrCreateTenantForClaim(abortedClaim, tx);
            if (result.kind !== "tenant") throw new Error(`unexpected ${result.kind}`);
            await tx.$executeRawUnsafe(`SELECT 1/0`);
          });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeDefined();
        expect(
          await ctx.su.prisma.tenant.findMany({ where: { externalId: abortedClaim } }),
        ).toHaveLength(0);
        expect(
          await ctx.su.prisma.tenantClaim.findMany({ where: { claim: abortedClaim } }),
        ).toHaveLength(0);
        expect(
          await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim: abortedClaim } }),
        ).toHaveLength(0);

        // Direction 2 (paired happy path) — the SAME code, no forced abort:
        // both the claim row and its event commit together.
        const result = await withBypassRls(
          ctx.su.prisma,
          (tx) => findOrCreateTenantForClaim(committedClaim, tx),
          BYPASS_PURPOSE.AUTH_FLOW,
        );
        if (result.kind !== "tenant") throw new Error(`unexpected ${result.kind}`);
        ctx.trackTenant(result.id);
        try {
          expect(
            await ctx.su.prisma.tenantClaim.findUnique({ where: { claim: committedClaim } }),
          ).not.toBeNull();
          expect(
            await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim: committedClaim } }),
          ).toHaveLength(1);
        } finally {
          await ctx.deleteTestData(result.id);
        }
      },
    );

    // RT10's deny side is only meaningful against a role shaped like
    // passwd_app: the harness's superuser connection bypasses ACL checks
    // entirely (VE3/VE5), so it can only ever prove the allow side, and a
    // freshly created role with NO grants at all fails on the first missing
    // privilege (SELECT/INSERT on tenants/tenant_claims) — before the
    // tenant_claim_events INSERT is ever reached — which would make "sign-in
    // fails, no tenant row survives" true for a reason unrelated to this
    // table. `TestRole` in helpers.ts is a closed union, so this
    // legitimately builds its own pool/client rather than going through
    // createPrismaForRole.
    describe("fail-closed: a passwd_app-shaped role without INSERT on tenant_claim_events (RT10)", () => {
      it.skipIf(SKIP)(
        "allow arm succeeds with both rows present; deny arm fails 42501 naming tenant_claim_events, with no tenant row surviving",
        async () => {
          const roleName = `probe_tce_${randomBytes(4).toString("hex")}`;
          const password = randomBytes(16).toString("hex");
          const base = process.env.DATABASE_URL;
          if (!base) throw new Error("DATABASE_URL is not set");

          let pool: pg.Pool | undefined;
          let probePrisma: PrismaClient | undefined;

          try {
            // Least-privilege role, matching passwd_app's shape (NOSUPERUSER,
            // NOBYPASSRLS — RLS is satisfied via the app.bypass_rls GUC
            // withBypassRls sets, the same convention passwd_app relies on).
            // CREATE ROLE's PASSWORD clause is a grammar-level string literal,
            // not an expression slot — it does not accept a bind parameter, so
            // this interpolates directly. Safe here only because both the role
            // name and the password are generated by this test from
            // node:crypto randomBytes().toString("hex") — [0-9a-f] only,
            // never operator or IdP input.
            await ctx.su.prisma.$executeRawUnsafe(
              `CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
            );
            await ctx.su.prisma.$executeRawUnsafe(
              `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO "${roleName}"', current_database()); END $$`,
            );
            await ctx.su.prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
            // passwd_app's prerequisite privileges — everything the writer
            // path needs before it ever reaches tenant_claim_events.
            await ctx.su.prisma.$executeRawUnsafe(
              `GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, tenant_claims TO "${roleName}"`,
            );

            const url = new URL(base);
            url.username = roleName;
            url.password = password;
            pool = new pg.Pool({
              connectionString: url.toString(),
              max: 2,
              idleTimeoutMillis: 10_000,
              statement_timeout: 30_000,
            });
            probePrisma = new PrismaClient({ adapter: new PrismaPg(pool) });

            const token = runToken();

            // Allow arm — the grant set is self-proving: this reds if any
            // prerequisite privilege above is missing, and it is the RT10
            // allow side the criterion needs anyway.
            await ctx.su.prisma.$executeRawUnsafe(
              `GRANT INSERT ON tenant_claim_events TO "${roleName}"`,
            );
            const allowClaim = `${token}-allow.${ALIAS_CLAIM}`;
            const allowResult = await withBypassRls(
              probePrisma,
              (tx) => findOrCreateTenantForClaim(allowClaim, tx),
              BYPASS_PURPOSE.AUTH_FLOW,
            );
            if (allowResult.kind !== "tenant") {
              throw new Error(`allow arm: unexpected ${allowResult.kind}`);
            }
            ctx.trackTenant(allowResult.id);
            expect(
              await ctx.su.prisma.tenantClaim.findUnique({ where: { claim: allowClaim } }),
            ).not.toBeNull();
            expect(
              await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim: allowClaim } }),
            ).toHaveLength(1);

            // Deny arm — same role, same connection, INSERT revoked.
            await ctx.su.prisma.$executeRawUnsafe(
              `REVOKE INSERT ON tenant_claim_events FROM "${roleName}"`,
            );
            const denyClaim = `${token}-deny.${ALIAS_CLAIM}`;
            let caught: unknown;
            try {
              await withBypassRls(
                probePrisma,
                (tx) => findOrCreateTenantForClaim(denyClaim, tx),
                BYPASS_PURPOSE.AUTH_FLOW,
              );
            } catch (e) {
              caught = e;
            }
            expect(caught).toBeDefined();
            expect(sqlStateOf(caught)).toBe("42501");
            expect(caught instanceof Error ? caught.message : String(caught)).toContain(
              "tenant_claim_events",
            );
            expect(
              await ctx.su.prisma.tenant.findMany({ where: { externalId: denyClaim } }),
            ).toHaveLength(0);
            expect(
              await ctx.su.prisma.tenantClaim.findMany({ where: { claim: denyClaim } }),
            ).toHaveLength(0);
          } finally {
            if (probePrisma) await probePrisma.$disconnect();
            if (pool) await pool.end();
            // dropProbeRoles precedent (bootstrap-rds-roles.integration.test.ts):
            // REVOKE ALL ON DATABASE -> DROP OWNED BY -> DROP ROLE, in one
            // finally. A role still holding grants cannot be dropped, and a
            // leaked pool keeps the forked vitest worker alive.
            await ctx.su.prisma.$executeRawUnsafe(
              `DO $$ BEGIN
                 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN
                   EXECUTE format('REVOKE ALL ON DATABASE %I FROM "${roleName}"', current_database());
                   EXECUTE 'DROP OWNED BY "${roleName}"';
                   EXECUTE 'DROP ROLE "${roleName}"';
                 END IF;
               END $$`,
            );
          }
        },
      );
    });
  });
});
