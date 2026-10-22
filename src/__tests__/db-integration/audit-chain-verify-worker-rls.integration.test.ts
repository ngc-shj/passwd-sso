/**
 * Regression: the audit-chain verify worker read `audit_logs` and
 * `audit_chain_anchors` through a bare client as `passwd_app`, which is
 * NOBYPASSRLS, with no `app.tenant_id` ever set. Both tables are FORCE ROW
 * LEVEL SECURITY with
 *   `bypass_rls='on' OR tenant_id = current_setting('app.tenant_id',true)::uuid`
 * so the predicate evaluated to NULL and every read returned ZERO ROWS WITH NO
 * ERROR. Every tenant then walked an empty chain, found nothing wrong, and was
 * reported healthy — while the heartbeat fired normally.
 *
 * This is the silent half of the RLS-read class. The `audit_outbox` case
 * raised 22P02 once a GUC had been touched on the connection and so was
 * eventually noticed; this one cannot raise anything, which is why the fix
 * carries a precondition assertion rather than relying on an error surfacing,
 * and reports what a tick covered as counts on the heartbeat line.
 *
 * The role matters: these cases MUST run as `passwd_app`. A superuser client
 * bypasses RLS outright and passes against the unfixed code.
 *
 * The `__system__` sentinel cannot be opened as a tenant context, so its chain
 * is read under the AUDIT_CHAIN_VERIFY_SENTINEL_READ bypass instead. That path
 * is exercised on throwaway tenant A while tenant B also has a chain: the grant
 * admits every tenant's rows, so B is what a lost `WHERE tenant_id` would pull
 * into A's walk. No case here writes rows for the real sentinel or touches its
 * audit_chain_enabled — on a shared DB the outbox worker and the anchor
 * publisher would act on that irreversibly.
 */

import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import {
  buildChainInput,
  computeCanonicalBytes,
  computeEventHash,
} from "@/lib/audit/audit-chain";
import {
  runTick,
  verifyChainUnderSentinelGrant,
  verifyTenantChain,
} from "@/../scripts/audit-chain-verify-worker";

const CHAIN_LENGTH = 3;
// The worker's own default; the sentinel's walk is capped at it.
const MAX_ROWS_PER_TENANT = Number(
  process.env.AUDIT_CHAIN_VERIFY_MAX_ROWS ?? 100_000,
);

describe("audit-chain verify worker RLS context", () => {
  let ctx: TestContext;
  let tenantId: string;
  let otherTenantId: string;
  const logger = { error: () => {}, info: () => {} };

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    otherTenantId = await ctx.createTenant();
    await insertChainedRows(tenantId, CHAIN_LENGTH);
    await insertChainedRows(otherTenantId, CHAIN_LENGTH);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
    await ctx.deleteTestData(otherTenantId);
  });

  /** Seed a valid chain of `count` rows for `tenantId` plus a matching anchor. */
  async function insertChainedRows(tenantId: string, count: number): Promise<string[]> {
    const userId = await ctx.createUser(tenantId);
    const ids: string[] = [];
    let prevHash: Buffer = Buffer.from([0x00]);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
         VALUES ($1::uuid, 0, '\\x00'::bytea, now())
         ON CONFLICT (tenant_id) DO NOTHING`,
        tenantId,
      );

      for (let i = 1; i <= count; i++) {
        const id = randomUUID();
        const outboxId = randomUUID();
        const createdAt = new Date(Date.now() + i * 1000);
        const seq = BigInt(i);
        const metadata = { index: i, verify: true };

        const chainInput = buildChainInput({
          id,
          createdAt,
          chainSeq: seq,
          prevHash,
          payload: metadata,
        });
        const eventHash = computeEventHash(
          prevHash,
          computeCanonicalBytes(chainInput),
        );

        await tx.$executeRawUnsafe(
          `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
           VALUES ($1::uuid, $2::uuid, '{}', 'SENT', now())`,
          outboxId,
          tenantId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_logs (
            id, tenant_id, scope, action, user_id, actor_type,
            metadata, created_at, outbox_id,
            chain_seq, event_hash, chain_prev_hash
          ) VALUES (
            $1::uuid, $2::uuid, 'PERSONAL'::"AuditScope", 'ENTRY_CREATE'::"AuditAction",
            $3::uuid, 'HUMAN'::"ActorType",
            $4::jsonb, $5::timestamptz, $6::uuid,
            $7, $8, $9
          )`,
          id,
          tenantId,
          userId,
          JSON.stringify(metadata),
          createdAt.toISOString(),
          outboxId,
          seq,
          eventHash,
          prevHash,
        );

        ids.push(id);
        prevHash = eventHash;
      }

      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors
         SET chain_seq = $1, prev_hash = $2, updated_at = now()
         WHERE tenant_id = $3::uuid`,
        BigInt(count),
        prevHash,
        tenantId,
      );
    });

    return ids;
  }

  it("bare reads as passwd_app see zero rows and raise nothing — the silent failure", async () => {
    // The control clause, and the reason this defect survived: "the boundary
    // is working" and "there is nothing here" are indistinguishable to the
    // caller. If this ever starts throwing, the two cases below stop proving
    // what they claim and must be revisited.
    const [anchors, rows] = await Promise.all([
      ctx.app.prisma.$queryRawUnsafe<unknown[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1`,
        tenantId,
      ),
      ctx.app.prisma.$queryRawUnsafe<unknown[]>(
        `SELECT id FROM audit_logs WHERE tenant_id = $1 AND chain_seq IS NOT NULL`,
        tenantId,
      ),
    ]);
    expect(anchors).toHaveLength(0);
    expect(rows).toHaveLength(0);

    // Ground truth for BOTH clauses. Without the anchor half, a fixture whose
    // `ON CONFLICT DO NOTHING` anchor insert never landed would satisfy
    // `anchors).toHaveLength(0)` for the wrong reason.
    const [truth] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ rows: bigint; anchors: bigint }>>(
        `SELECT
           (SELECT COUNT(*) FROM audit_logs
             WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL) AS rows,
           (SELECT COUNT(*) FROM audit_chain_anchors
             WHERE tenant_id = $1::uuid) AS anchors`,
        tenantId,
      );
    });
    expect(Number(truth.rows)).toBe(CHAIN_LENGTH);
    expect(Number(truth.anchors)).toBe(1);
  });

  it("verifies a healthy chain as passwd_app, with the anchor actually compared", async () => {
    // Allow side. anchorChecked is the discriminator that matters: before the
    // fix this returned ok:true with anchorChecked:false and totalVerified:0,
    // i.e. "clean" for a chain it could not see. A fix asserting only `ok`
    // would still pass against the broken code.
    const result = await verifyTenantChain(tenantId, {
      prisma: ctx.app.prisma,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.anchorChecked).toBe(true);
    expect(result.totalVerified).toBe(CHAIN_LENGTH);
  });

  it("detects a tampered row as passwd_app", async () => {
    // Deny side. This is the whole purpose of the worker, and it was
    // unreachable: with zero rows visible there was nothing to find.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_logs SET metadata = '{"tampered":true}'::jsonb
         WHERE tenant_id = $1::uuid AND chain_seq = 2`,
        tenantId,
      );
    });

    const result = await verifyTenantChain(tenantId, {
      prisma: ctx.app.prisma,
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.firstTamperedSeq).toBe(2);
    // walkedThrough is what separates "detected tampering" from "saw nothing":
    // before the fix the walk covered 0 rows. anchorChecked is deliberately not
    // asserted here — the walk bails at the first tampered row, so the anchor
    // head-hash comparison never runs.
    expect(result.walkedThrough).toBeGreaterThan(0);
  });

  it("verifies tenant A's chain under the sentinel-read grant as passwd_app, with B's chain present", async () => {
    // Visibility on the bypass path: the grant is what makes A's rows visible
    // to passwd_app, and a clean walk of exactly CHAIN_LENGTH rows shows B's
    // rows, which the grant admits just as well, stayed out of it (joined in,
    // they would interleave by chain_seq and break the walk at seq 1).
    const result = await verifyChainUnderSentinelGrant(tenantId, {
      prisma: ctx.app.prisma,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(result.anchorChecked).toBe(true);
    expect(result.totalVerified).toBe(CHAIN_LENGTH);
  });

  it("detects a tampered row of tenant A under the sentinel-read grant", async () => {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_logs SET metadata = '{"tampered":true}'::jsonb
         WHERE tenant_id = $1::uuid AND chain_seq = 2`,
        tenantId,
      );
    });

    const result = await verifyChainUnderSentinelGrant(tenantId, {
      prisma: ctx.app.prisma,
      logger,
    });

    expect(result.ok).toBe(false);
    expect(result.firstTamperedSeq).toBe(2);
    expect(result.walkedThrough).toBeGreaterThan(0);
  });

  it("verifies the sentinel as passwd_app without throwing, matching what a superuser reads of it", async () => {
    // On a clean DB the sentinel has no chain, so this proves the routing
    // (withTenantRls would throw RlsSentinelContextRefused) and that the
    // bypass precondition holds on a real database — not visibility, which
    // the tenant-A cases above prove. Read-only: nothing is written for the
    // sentinel.
    const result = await verifyTenantChain(SYSTEM_TENANT_ID, {
      prisma: ctx.app.prisma,
      logger,
    });

    const [truth] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<
        Array<{ anchor_seq: bigint | null; chained: bigint; walkable: bigint }>
      >(
        `SELECT
           (SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid) AS anchor_seq,
           (SELECT COUNT(*) FROM audit_logs
             WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL) AS chained,
           (SELECT COUNT(*) FROM audit_logs
             WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL
               AND chain_seq <= (SELECT chain_seq FROM audit_chain_anchors
                                  WHERE tenant_id = $1::uuid)) AS walkable`,
        SYSTEM_TENANT_ID,
      );
    });

    if (truth.anchor_seq === null) {
      expect(result.totalVerified).toBe(0);
      expect(result.ok).toBe(Number(truth.chained) === 0);
    } else {
      // Assumes the sentinel's chain is intact: a broken one (e.g. rows purged
      // by its retention) stops the walk early and fails this, as it should.
      // The head hash is compared only when the walk reached the anchor, so a
      // walk the row cap cut short has anchorChecked false.
      expect(result.anchorChecked).toBe(
        Number(truth.anchor_seq) >= 1 &&
          Number(truth.walkable) <= MAX_ROWS_PER_TENANT,
      );
      expect(result.totalVerified).toBe(
        Math.min(Number(truth.walkable), MAX_ROWS_PER_TENANT),
      );
    }
  });

  it("C3: runTick enumerates tenants under bypass as passwd_app, matching the superuser count of all tenants (sentinel included) with no coverage shortfall", async () => {
    // `tenants` now carries RLS too (C1): a bare `prisma.tenant.findMany` as
    // passwd_app would see zero rows and every tenant would walk an empty
    // chain — the same silent failure this file's other cells exist to catch,
    // one layer up. runTick must instead enumerate under the named
    // SYSTEM_MAINTENANCE_TENANT_LOOKUP bypass grant.
    const logLines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logLines.push(String(line));
    });
    try {
      await runTick(ctx.app.prisma, new Map());
    } finally {
      logSpy.mockRestore();
    }

    const heartbeatLine = logLines.find((line) =>
      line.includes("audit-chain-verify-heartbeat"),
    );
    expect(heartbeatLine).toBeDefined();
    const heartbeat = JSON.parse(heartbeatLine!);

    const [{ count: superuserTenantCount }] = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        // Every tenant is verified, the sentinel included (under its own
        // bypass grant), so tenantCount is the count of all tenants.
        `SELECT COUNT(*) AS count FROM tenants`,
      );
    });
    expect(heartbeat.tenantCount).toBe(Number(superuserTenantCount));
    expect(heartbeat.verifiedTenantCount + heartbeat.erroredTenantCount).toBe(heartbeat.tenantCount);
    expect(heartbeat.erroredTenantCount).toBe(0);
  });
});
