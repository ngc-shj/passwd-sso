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
import { Prisma } from "@prisma/client";
import {
  createTestContext,
  setBypassRlsGucs,
  createPrismaForRole,
  raceTwoClients,
  type TestContext,
  type PrismaWithPool,
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
  PRIMARY_CLAIM,
  ALIAS_CLAIM,
  NON_DOMAIN_CLAIM,
} from "@/__tests__/helpers/tenant-claim-fixtures";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BACKFILL_SQL_PATH = resolve(REPO_ROOT, "scripts/lib/tenant-claim-backfill.sql");
const MIGRATION_SQL_PATH = resolve(
  REPO_ROOT,
  "prisma/migrations/20260729110000_add_tenant_claims/migration.sql",
);

const SKIP = !process.env.DATABASE_URL;

/** Per-run token so claim/external_id literals never collide across concurrent runs. */
function runToken(): string {
  return randomBytes(4).toString("hex");
}

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
  const meta = err.meta;
  if (!meta || typeof meta !== "object") return false;
  if ("code" in meta && meta.code === "23514") return true;
  const driverAdapterError = "driverAdapterError" in meta ? meta.driverAdapterError : undefined;
  if (driverAdapterError && typeof driverAdapterError === "object" && "cause" in driverAdapterError) {
    const cause = driverAdapterError.cause;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "23514") {
      return true;
    }
  }
  return false;
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
              // Byte identity, not merely "equivalent": a re-fold on either
              // side would surface here as a differing code unit.
              expect(stored?.claim, testCase.label).toBe(normalised);
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
        expect(resolvedMixedCase?.id).toBe(tenantMixedCase);
        expect(resolvedPaddedLower?.id).toBe(tenantPaddedLower);

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

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
    second = createPrismaForRole("app");
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
        expect(resultA.id).not.toBe(resultB.id);
        created.push({ id: resultA.id });
        created.push({ id: resultB.id });
      });

      const tenants = await ctx.su.prisma.tenant.findMany({
        where: { id: { in: created.map((c) => c.id) } },
      });
      expect(tenants).toHaveLength(2);
      expect(tenants[0].slug).not.toBe(tenants[1].slug);

      for (const c of created) {
        await ctx.deleteTestData(c.id);
      }
    },
  );
});
