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
 * carries a precondition assertion and heartbeat suppression rather than
 * relying on an error surfacing.
 *
 * The role matters: these cases MUST run as `passwd_app`. A superuser client
 * bypasses RLS outright and passes against the unfixed code.
 */

import {
  describe,
  it,
  expect,
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
import { verifyTenantChain } from "@/../scripts/audit-chain-verify-worker";

const CHAIN_LENGTH = 3;

describe("audit-chain verify worker RLS context", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  const logger = { error: () => {}, info: () => {} };

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    await insertChainedRows(CHAIN_LENGTH);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  /** Seed a valid chain of `count` rows plus a matching anchor. */
  async function insertChainedRows(count: number): Promise<string[]> {
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

    // Ground truth: the rows really are there.
    const truth = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*) AS count FROM audit_logs
         WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL`,
        tenantId,
      );
    });
    expect(Number(truth[0].count)).toBe(CHAIN_LENGTH);
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
});
