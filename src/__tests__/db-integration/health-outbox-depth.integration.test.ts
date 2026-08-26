/**
 * Round-1 F-M6. `src/lib/health.ts:checkAuditOutbox` had the same defect
 * `audit-outbox-depth-check.integration.test.ts` was written for — a read of
 * `audit_outbox` on a bare pooled connection — and shipped its fix with
 * mock-only coverage. Both health suites `vi.mock("@/lib/tenant-rls")`, so
 * `withBypassRls` never executes there: no `$transaction`, no `set_config`, no
 * pooled connection. Those suites pass identically against the bypassed and the
 * un-bypassed form, which is precisely the property the fix is about.
 *
 * The defect is connection-scoped runtime state. `SET LOCAL` on a custom GUC
 * reverts at transaction end to the SESSION DEFAULT — which is '' once the GUC
 * has been touched at all — not to unset. So after the first bypass transaction
 * on a pooled connection, `current_setting('app.tenant_id', true)` returns ''
 * for the rest of that connection's life, and the tenant_isolation policy's
 * `''::uuid` raises 22P02 before the OR-bypass clause can short-circuit.
 *
 * Run as `passwd_app`, not as the worker role: that is the role the health
 * probe actually connects as, and it is NOBYPASSRLS, so the policy really is
 * evaluated. `max: 1` makes "both statements hit the same backend" an explicit
 * invariant rather than an accident of pg's LIFO idle stack — a second
 * connection with a virgin GUC would make this file pass against the unfixed
 * code.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import {
  createPrismaForRole,
  createTestContext,
  setBypassRlsGucs,
  sqlStateOf,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import { readAuditOutboxDepth } from "@/lib/health";

describe("health audit_outbox depth on a pooled connection", () => {
  let wp: PrismaWithPool;
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    wp = createPrismaForRole("app", { max: 1 });
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await wp.prisma.$disconnect();
    await wp.pool.end();
    await ctx.cleanup();
  });

  // Probe rows go on a tracked throwaway tenant, never on a pre-existing one:
  // ctx.cleanup() sweeps it even if the process dies before afterEach, so a hard
  // kill cannot leave a PENDING row for a live worker to drain into a real
  // tenant's audit log.
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  /** Put the single pooled connection into the state a prior bypass tx leaves. */
  async function poisonGuc(): Promise<void> {
    await wp.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
    });
  }

  it("leaves app.tenant_id as empty string, not unset, after a bypass transaction", async () => {
    // Precondition asserted, not inferred: if this ever returns null the two
    // cases below stop testing anything and would silently pass.
    await poisonGuc();
    const [row] = await wp.prisma.$queryRawUnsafe<
      Array<{ tenant_id: string | null }>
    >(`SELECT current_setting('app.tenant_id', true) AS tenant_id`);
    expect(row.tenant_id).toBe("");
  });

  it("rejects with 22P02 when the depth query runs outside a bypass transaction", async () => {
    // The control clause: the pre-fix shape. It proves the poisoning is real,
    // so the passing case below cannot be passing for a stale reason.
    await poisonGuc();
    let sqlState: string | null = null;
    try {
      await wp.prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::bigint AS pending FROM audit_outbox WHERE status = 'PENDING'`,
      );
    } catch (err) {
      sqlState = sqlStateOf(err);
    }
    expect(sqlState).toBe("22P02");
  });

  it("returns a correct depth on that same connection via readAuditOutboxDepth", async () => {
    await poisonGuc();

    const before = await readAuditOutboxDepth(wp.prisma);
    expect(Number.isInteger(before.pending)).toBe(true);

    // Delta, not an absolute count: the dev DB is shared, so `>= 0` would pass
    // no matter what the query returned.
    //
    // Two rows, only one PENDING. The SENT row pins the query's own
    // `WHERE status = 'PENDING'` predicate: drop it and the delta becomes 2, so
    // this fails for a reason a single-PENDING-row fixture would miss.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox
           (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES
           (gen_random_uuid(), $1::uuid, '{"probe":"health-depth-pending"}'::jsonb,
            'PENDING', 0, 5, now(), now()),
           (gen_random_uuid(), $1::uuid, '{"probe":"health-depth-sent"}'::jsonb,
            'SENT', 0, 5, now(), now())`,
        tenantId,
      );
    });

    const after = await readAuditOutboxDepth(wp.prisma);
    expect(after.pending - before.pending).toBe(1);
    // The PENDING row was just inserted, so the oldest pending age is a real
    // number rather than the `?? 0` fallback that an empty result yields.
    expect(after.oldestAgeSecs).toBeGreaterThanOrEqual(0);
  });
});
