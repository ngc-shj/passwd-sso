/**
 * Tests concurrent chain insert ordering through the REAL deliverRowWithChain
 * (T2 — no hand-rolled chain SQL, no setTimeout barrier). The function's own
 * SELECT ... FOR UPDATE on the anchor row serializes two concurrent deliveries
 * deterministically, producing gap-free, monotonically increasing chain_seq.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestContext,
  createPrismaForRole,
  setBypassRlsGucs,
  raceTwoClients,
  type TestContext,
  type PrismaWithPool,
} from "./helpers";
import { deliverRowWithChain } from "@/workers/audit-outbox-worker";
import type { AuditOutboxRow, AuditOutboxPayload } from "@/workers/audit-outbox-worker";

describe("audit-chain-ordering (concurrent inserts)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let clientA: PrismaWithPool;
  let clientB: PrismaWithPool;

  beforeAll(async () => {
    ctx = await createTestContext();
    clientA = createPrismaForRole("superuser");
    clientB = createPrismaForRole("superuser");
  });

  afterAll(async () => {
    await Promise.all([
      clientA.prisma.$disconnect().then(() => clientA.pool.end()),
      clientB.prisma.$disconnect().then(() => clientB.pool.end()),
    ]);
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);

    // Enable audit chain for the tenant — deliverRowWithChain is the export
    // under test and only chains when the tenant has chain mode enabled.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantId,
      );
    });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  function makePayload(): AuditOutboxPayload {
    return {
      scope: "PERSONAL",
      action: "ENTRY_CREATE",
      userId,
      actorType: "HUMAN",
    } as AuditOutboxPayload;
  }

  // Insert a PROCESSING outbox row and claim it as the real worker would, so
  // deliverRowWithChain receives a genuine AuditOutboxRow.
  async function insertAndClaim(payload: AuditOutboxPayload): Promise<AuditOutboxRow> {
    const outboxId = randomUUID();
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<AuditOutboxRow[]>(
        `INSERT INTO audit_outbox
           (id, tenant_id, payload, status, attempt_count, max_attempts, created_at, next_retry_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'PROCESSING', 0, 5, now(), now())
         RETURNING *`,
        outboxId,
        tenantId,
        JSON.stringify(payload),
      );
      return rows[0]!;
    });
  }

  it("produces gap-free sequential chain_seq values under concurrent deliverRowWithChain", async () => {
    const payloadA = makePayload();
    const payloadB = makePayload();
    const rowA = await insertAndClaim(payloadA);
    const rowB = await insertAndClaim(payloadB);

    // Race both deliveries on distinct connections. deliverRowWithChain's own
    // FOR UPDATE anchor lock serializes them — no external barrier/sleep.
    const [deliveredA, deliveredB] = await raceTwoClients(
      clientA.prisma,
      clientB.prisma,
      (c) => deliverRowWithChain(c, rowA, payloadA),
      (c) => deliverRowWithChain(c, rowB, payloadB),
    );

    expect(deliveredA.delivered).toBe(true);
    expect(deliveredB.delivered).toBe(true);

    // Both audit_logs rows landed with gap-free sequential chain_seq {1,2},
    // in either race order. (created_at ordering is deliberately NOT asserted:
    // chain_seq is assigned by anchor-lock acquisition order, which under a
    // genuine race can differ from the rows' own created_at — the hash chain
    // links by chain_seq, not timestamp, so seq gap-freeness is the invariant.)
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_logs
         WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL
         ORDER BY chain_seq ASC`,
        tenantId,
      );
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.chain_seq))).toEqual([1, 2]);
  });
});
