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
import { findOrCreateTenantForClaim } from "@/lib/tenant/tenant-management";
import { slugifyTenant } from "@/lib/tenant/tenant-claim";
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
     */
    async function runBackfillFile(): Promise<void> {
      const raw = readFileSync(BACKFILL_SQL_PATH, "utf8");
      const sql = raw
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      await ctx.su.prisma.$executeRawUnsafe(sql);
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
      "backfills external_id into tenant_claims, skips a normalisation collision without error, and skips a non-ASCII value entirely (SC9)",
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

        await runBackfillFile();

        // Exactly one of the two colliding tenants won the claim (ON CONFLICT
        // DO NOTHING), and no error was thrown getting here.
        const collisionRows = await ctx.su.prisma.tenantClaim.findMany({
          where: { claim: normalised },
        });
        expect(collisionRows).toHaveLength(1);
        expect([tenantMixedCase, tenantPaddedLower]).toContain(collisionRows[0].tenantId);
        expect(collisionRows[0].createdBy).toBe("backfill");

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
      const claim = `${runToken()}.${ALIAS_CLAIM}`;

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

      expect(resultA).not.toBeNull();
      expect(resultB).not.toBeNull();
      expect(resultA?.id).toBe(resultB?.id);

      const claimRows = await ctx.su.prisma.tenantClaim.findMany({ where: { claim } });
      expect(claimRows).toHaveLength(1);
      expect(claimRows[0].tenantId).toBe(resultA?.id);

      const tenantRows = await ctx.su.prisma.tenant.findMany({ where: { externalId: claim } });
      expect(tenantRows).toHaveLength(1);

      if (resultA) await ctx.deleteTestData(resultA.id);
    },
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
        expect(resultA).not.toBeNull();
        expect(resultB).not.toBeNull();
        expect(resultA?.id).not.toBe(resultB?.id);
        if (resultA) created.push(resultA);
        if (resultB) created.push(resultB);
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
