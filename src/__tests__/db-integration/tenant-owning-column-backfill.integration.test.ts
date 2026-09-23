/**
 * Real-DB integration tests for C4/#838 — `scripts/tenant-domain.ts`'s
 * `measure` and `backfill-owning-column` verbs.
 *
 * Placed here, not `scripts/__tests__/*.test.ts` (round-2 T6 on the sibling
 * `tenant-claim-cli.integration.test.ts`), so it runs under
 * `vitest.integration.config.ts` against a real database rather than the unit
 * suite's dummy `DATABASE_URL`.
 *
 * ISOLATION (T-F5 / A-C4-2d). `measure`'s three counts and
 * `backfill-owning-column`'s candidate list are read over the WHOLE
 * `users`/`tenant_members` tables — system-wide, not tenant-scoped — so every
 * assertion here is a DELTA around a fixture this file created (or a lookup
 * of one specific id inside the returned list), never an absolute or
 * "non-zero" count. `measure`'s baseline is read BEFORE each fixture is
 * seeded for exactly this reason.
 *
 * A divergent fixture's `users.tenantId` column and its active membership
 * disagree by construction, so a cleanup call scoped to only one of the two
 * tenants can miss half the rows (`deleteTestData(tenantId)` deletes
 * `tenant_members`/`users` BY tenant_id — whichever tenant currently owns the
 * column decides which call reaches the `users` row at all, and that owner
 * flips the moment `--apply` runs). `cleanupDivergent` below re-reads the
 * column to decide which tenant to delete first, rather than assuming it —
 * see `audit-tenant-adjudicator.integration.test.ts`'s afterEach for the
 * same discipline stated the other way (fixed creation order there, because
 * that file never applies a move mid-test).
 *
 * Must run with the compose workers stopped (CLAUDE.md's audit-outbox-worker
 * note): a live worker drains `audit_outbox` rows this file reads back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, type TestContext } from "./helpers";
import {
  cmdMeasure,
  cmdBackfillOwningColumn,
  candidateFromRow,
  migrationClientFactory,
} from "../../../scripts/tenant-domain";

const SKIP = !process.env.DATABASE_URL;

type Candidate = {
  userId: string;
  from: string;
  to: string;
  activeMembershipCount: number;
  multiActive: boolean;
};
type Outcome = { userId: string; moved: boolean; from?: string; to?: string; reason?: string };
type MeasureCounts = { multiActive: number; divergent: number; zeroActive: number };

describe("tenant-domain measure / backfill-owning-column (C4/#838)", () => {
  let ctx: TestContext;

  // Same convention as tenant-claim-cli.integration.test.ts: the CLI reads
  // MIGRATION_DATABASE_URL per call, and this harness's superuser connects
  // through the same variable, so a runner that exported only DATABASE_URL
  // needs it mirrored — per test, so the missing-URL-shaped cells elsewhere
  // in this suite are never contaminated by a leaked stub.
  beforeEach(() => {
    if (SKIP) return;
    if (!process.env.MIGRATION_DATABASE_URL) {
      vi.stubEnv("MIGRATION_DATABASE_URL", process.env.DATABASE_URL as string);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeAll(async () => {
    if (SKIP) return;
    ctx = await createTestContext();
  });
  afterAll(async () => {
    if (SKIP) return;
    await ctx.cleanup();
  });

  const columnOf = async (userId: string): Promise<string> =>
    (await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } })).tenantId;

  const realignRows = (tenantIds: string[]) =>
    ctx.su.prisma.auditOutbox.findMany({
      where: { tenantId: { in: tenantIds }, payload: { path: ["action"], equals: "USER_TENANT_REALIGNED" } },
      select: { tenantId: true, payload: true },
    });

  /**
   * A user whose column stays at `homeTenant` while their only active
   * membership moves to `toTenant` — design-note query (1)'s population,
   * same shape as `audit-tenant-adjudicator.integration.test.ts`'s
   * `repointActiveMembership`.
   */
  async function seedDivergent(): Promise<{ homeTenant: string; toTenant: string; userId: string }> {
    const homeTenant = await ctx.createTenant();
    const toTenant = await ctx.createTenant();
    const userId = await ctx.createUser(homeTenant);
    await ctx.su.prisma.$executeRawUnsafe(
      `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      homeTenant,
      userId,
    );
    await ctx.su.prisma.$executeRawUnsafe(
      `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
      randomUUID(),
      toTenant,
      userId,
    );
    return { homeTenant, toTenant, userId };
  }

  /** See the file header's ISOLATION note: deletes the non-owning tenant first, the owning one last. */
  async function cleanupDivergent(userId: string, tenantA: string, tenantB: string): Promise<void> {
    const owning = await columnOf(userId);
    const other = owning === tenantA ? tenantB : tenantA;
    await ctx.deleteTestData(other);
    await ctx.deleteTestData(owning);
  }

  describe("backfill-owning-column", () => {
    it.skipIf(SKIP)(
      "lists a divergent user by dry-run with zero writes, and --apply --yes moves exactly that user (A-C4-2)",
      async () => {
        const { homeTenant, toTenant, userId } = await seedDivergent();
        try {
          const before = await realignRows([homeTenant, toTenant]);

          const dryRun = await cmdBackfillOwningColumn({ by: "test-op" });
          expect(dryRun.ok, dryRun.message).toBe(true);
          const listed = (dryRun.rows as Candidate[]).find((c) => c.userId === userId);
          expect(listed).toMatchObject({ from: homeTenant, to: toTenant, activeMembershipCount: 1, multiActive: false });
          expect(await columnOf(userId)).toBe(homeTenant);
          expect(await realignRows([homeTenant, toTenant])).toEqual(before);

          const applied = await cmdBackfillOwningColumn({ by: "test-op", apply: true, yes: true });
          expect(applied.ok, applied.message).toBe(true);
          const outcome = (applied.rows as Outcome[]).find((o) => o.userId === userId);
          expect(outcome).toMatchObject({ moved: true, from: homeTenant, to: toTenant });
          expect(await columnOf(userId)).toBe(toTenant);

          const after = await realignRows([homeTenant, toTenant]);
          expect(after.length).toBe(before.length + 2); // one USER_TENANT_REALIGNED row per tenant
          for (const row of after.filter((r) => !before.some((b) => b.payload === r.payload))) {
            expect(row.payload).toMatchObject({ metadata: expect.objectContaining({ source: "operator", by: "test-op" }) });
          }
        } finally {
          await cleanupDivergent(userId, homeTenant, toTenant);
        }
      },
    );

    it.skipIf(SKIP)(
      "skips a user whose membership is deactivated between listing and apply, writing nothing for them (A-C4-2)",
      async () => {
        const { homeTenant, toTenant, userId } = await seedDivergent();
        try {
          const before = await realignRows([homeTenant, toTenant]);

          const result = await cmdBackfillOwningColumn({
            by: "test-op",
            apply: true,
            // Lands between the candidate listing and this user's own apply
            // transaction — exactly the re-check `applyOneCandidate` exists for.
            confirm: async () => {
              await ctx.su.prisma.$executeRawUnsafe(
                `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
                toTenant,
                userId,
              );
              return true;
            },
          });

          expect(result.ok, result.message).toBe(true);
          const outcome = (result.rows as Outcome[]).find((o) => o.userId === userId);
          expect(outcome).toMatchObject({ moved: false, reason: "no longer divergent" });
          expect(await columnOf(userId)).toBe(homeTenant);
          expect(await realignRows([homeTenant, toTenant])).toEqual(before);
        } finally {
          await cleanupDivergent(userId, homeTenant, toTenant);
        }
      },
    );

    it.skipIf(SKIP)("never touches a non-divergent user", async () => {
      const tenantId = await ctx.createTenant();
      const userId = await ctx.createUser(tenantId);
      try {
        const result = await cmdBackfillOwningColumn({ by: "test-op", apply: true, yes: true, limit: 10_000 });
        expect(result.ok, result.message).toBe(true);
        expect((result.rows as Outcome[]).some((o) => o.userId === userId)).toBe(false);
        expect(await columnOf(userId)).toBe(tenantId);
      } finally {
        await ctx.deleteTestData(tenantId);
      }
    });

    it.skipIf(SKIP)("--limit 1 moves exactly one of three divergent users (A-C4-2b)", async () => {
      const seeded = [await seedDivergent(), await seedDivergent(), await seedDivergent()];
      try {
        const result = await cmdBackfillOwningColumn({ by: "test-op", apply: true, yes: true, limit: 1 });
        expect(result.ok, result.message).toBe(true);
        const outcomes = result.rows as Outcome[];
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0].moved).toBe(true);

        const moved = seeded.find((s) => s.userId === outcomes[0].userId);
        expect(moved, "the moved user must be one of this test's own fixtures").toBeDefined();
        expect(await columnOf(moved!.userId)).toBe(moved!.toTenant);
        for (const s of seeded) {
          if (s.userId !== moved!.userId) expect(await columnOf(s.userId)).toBe(s.homeTenant);
        }
      } finally {
        for (const s of seeded) await cleanupDivergent(s.userId, s.homeTenant, s.toTenant);
      }
    });

    it.skipIf(SKIP)(
      "cannot construct a multi-active fixture at all — tenant_members_one_active_per_user (#830) already forecloses it",
      async () => {
        // A-C4-2b asks for a dry-run cell that flags a two-active-membership
        // user `multiActive`, targeting the OLDER tenant. That fixture is no
        // longer constructible against this schema: PR #830
        // (prisma/migrations/20260909120000_one_active_membership_per_user,
        // already merged to main — design-note Q11 / the plan's own SC5,
        // listed there as still deferred) added a partial UNIQUE INDEX on
        // `tenant_members(user_id) WHERE deactivated_at IS NULL`, so a second
        // active row for one user is now a constraint violation, not a state
        // `backfill-owning-column` could ever observe. This cell proves that
        // rather than assuming it (a changed migration file is exactly the
        // kind of thing that silently stops being true); `candidateFromRow`'s
        // unit cells below pin the `multiActive` FLAG's own logic — the code
        // path this index made unreachable end-to-end, not dead.
        const tenantId = await ctx.createTenant();
        const otherTenant = await ctx.createTenant();
        const userId = await ctx.createUser(tenantId); // one active membership, in tenantId
        try {
          await expect(
            ctx.su.prisma.$executeRawUnsafe(
              `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
              randomUUID(),
              otherTenant,
              userId,
            ),
          ).rejects.toThrow(/tenant_members_one_active_per_user/);
        } finally {
          await ctx.deleteTestData(otherTenant);
          await ctx.deleteTestData(tenantId);
        }
      },
    );

    it.skipIf(SKIP)("rejects an invalid --by before building a client", async () => {
      const createSpy = vi.spyOn(migrationClientFactory, "create");
      try {
        const result = await cmdBackfillOwningColumn({
          by: `ops${String.fromCodePoint(0x202e)}admin`,
          apply: true,
          yes: true,
        });
        expect(result.ok).toBe(false);
        expect(createSpy).not.toHaveBeenCalled();
      } finally {
        createSpy.mockRestore();
      }
    });
  });

  describe("measure", () => {
    it.skipIf(SKIP)(
      // A-C4-3 asks for a fixture that makes each of the three counts
      // non-zero; query (2)'s (multi-active) population is no longer
      // constructible at all — see the "cannot construct a multi-active
      // fixture" cell above — so this seeds the two that still are, and
      // asserts query (2) as a zero DELTA (T-F5 / A-C4-2d: still relative to
      // the baseline, never an absolute "it's 0" claim).
      "counts (1) and (3) as a delta around a seeded fixture, and (2) as an unmoved delta (A-C4-3, A-C4-2d)",
      async () => {
        const baseline = (await cmdMeasure()).rows?.[0] as MeasureCounts;

        const { homeTenant, toTenant, userId: divergentUser } = await seedDivergent();

        const zeroActiveTenant = await ctx.createTenant();
        const zeroActiveUser = await ctx.createUser(zeroActiveTenant);
        await ctx.su.prisma.$executeRawUnsafe(
          `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
          zeroActiveTenant,
          zeroActiveUser,
        );

        try {
          const result = await cmdMeasure();
          expect(result.ok, result.message).toBe(true);
          const counts = result.rows?.[0] as MeasureCounts;
          expect(counts.divergent).toBe(baseline.divergent + 1);
          expect(counts.zeroActive).toBe(baseline.zeroActive + 1);
          expect(counts.multiActive).toBe(baseline.multiActive);
        } finally {
          await cleanupDivergent(divergentUser, homeTenant, toTenant);
          await ctx.deleteTestData(zeroActiveTenant);
        }
      },
    );
  });

  // A-C4-2b's `multiActive` flag, pinned at the unit level (no DB — see the
  // "cannot construct a multi-active fixture" cell above for why this can no
  // longer be driven through a real row).
  describe("candidateFromRow (pure, no DB dependency)", () => {
    it("flags multiActive when active_count is greater than 1", () => {
      const candidate = candidateFromRow({
        user_id: "user-1",
        column_tenant_id: "column-tenant",
        target_tenant_id: "older-tenant",
        active_count: 2,
      });
      expect(candidate).toEqual({
        userId: "user-1",
        from: "column-tenant",
        to: "older-tenant",
        activeMembershipCount: 2,
        multiActive: true,
      });
    });

    it("does not flag multiActive for exactly one active membership", () => {
      const candidate = candidateFromRow({
        user_id: "user-1",
        column_tenant_id: "column-tenant",
        target_tenant_id: "member-tenant",
        active_count: 1,
      });
      expect(candidate.multiActive).toBe(false);
    });
  });
});
