/**
 * End-to-end sweep test for sweepOnce against real Postgres.
 * Seeds 9 rows covering all boundary combinations plus a now() boundary row.
 * Asserts exactly one deletion (the expired, unclaimed DCR row), strict-shape
 * audit_outbox row, and drives the audit-chain-anchor assertion in-process.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, createPrismaForRole, setBypassRlsGucs, type TestContext } from "./helpers";
import { sweepOnce } from "@/workers/dcr-cleanup-worker";
import {
  deliverRowWithChain,
  type AuditOutboxRow,
  type AuditOutboxPayload,
} from "@/workers/audit-outbox-worker";
import { AUDIT_SCOPE, AUDIT_ACTION, ACTOR_TYPE, AUDIT_METADATA_KEY } from "@/lib/constants/audit/audit";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { MAX_UNCLAIMED_DCR_CLIENTS } from "@/lib/constants/auth/mcp";

describe("dcr-cleanup-worker sweepOnce (real DB)", () => {
  let ctx: TestContext;
  let tenantId: string;
  // IDs of mcp_clients rows seeded by each test
  let seededClientIds: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    seededClientIds = [];
    // Remove all pre-existing unclaimed DCR rows (any expiry) so sweepOnce only
    // targets rows seeded by this test run and returns an exact count.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_clients WHERE is_dcr = true AND tenant_id IS NULL`,
      );
    });
  });
  afterEach(async () => {
    // Remove seeded mcp_clients rows
    if (seededClientIds.length > 0) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const id of seededClientIds) {
          await tx.$executeRawUnsafe(
            `DELETE FROM mcp_clients WHERE id = $1::uuid`,
            id,
          );
        }
      });
    }
    // Remove SYSTEM_TENANT_ID audit_outbox and chain anchors
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
         WHERE tenant_id = $1::uuid AND status IN ('PENDING', 'PROCESSING')`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_outbox WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  async function insertMcpClient(opts: {
    isDcr: boolean;
    tenantId: string | null;
    expiresAt: string; // SQL expression like 'now() - interval \'1 hour\''
  }): Promise<string> {
    const id = randomUUID();
    const clientIdStr = `test-cl-${id.slice(0, 12)}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      if (opts.tenantId !== null) {
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at)
           VALUES ($1::uuid, $2, 'hash', $3, '{}', 'credentials:list', $4, $5::uuid, ${opts.expiresAt}, now(), now())`,
          id,
          clientIdStr,
          `client-${id.slice(0, 8)}`,
          opts.isDcr,
          opts.tenantId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at)
           VALUES ($1::uuid, $2, 'hash', $3, '{}', 'credentials:list', $4, NULL, ${opts.expiresAt}, now(), now())`,
          id,
          clientIdStr,
          `client-${id.slice(0, 8)}`,
          opts.isDcr,
        );
      }
    });
    seededClientIds.push(id);
    return id;
  }

  it("deletes only the expired unclaimed DCR row and emits correct audit_outbox row", async () => {
    // Seed 8 boundary combinations of (is_dcr × tenant_id × expires_at)
    // Row 1: target — is_dcr=true, tenant_id=null, expired (-1h)
    const targetId = await insertMcpClient({ isDcr: true, tenantId: null, expiresAt: "now() - interval '1 hour'" });
    // Row 2: is_dcr=true, tenant_id=null, future (+1h) — keep
    await insertMcpClient({ isDcr: true, tenantId: null, expiresAt: "now() + interval '1 hour'" });
    // Row 3: is_dcr=true, tenant_id=real, expired (-1h) — keep
    await insertMcpClient({ isDcr: true, tenantId: tenantId, expiresAt: "now() - interval '1 hour'" });
    // Row 4: is_dcr=true, tenant_id=real, future (+1h) — keep
    await insertMcpClient({ isDcr: true, tenantId: tenantId, expiresAt: "now() + interval '1 hour'" });
    // Row 5: is_dcr=false, tenant_id=null, expired (-1h) — keep
    await insertMcpClient({ isDcr: false, tenantId: null, expiresAt: "now() - interval '1 hour'" });
    // Row 6: is_dcr=false, tenant_id=null, future (+1h) — keep
    await insertMcpClient({ isDcr: false, tenantId: null, expiresAt: "now() + interval '1 hour'" });
    // Row 7: is_dcr=false, tenant_id=real, expired (-1h) — keep
    await insertMcpClient({ isDcr: false, tenantId: tenantId, expiresAt: "now() - interval '1 hour'" });
    // Row 8: is_dcr=false, tenant_id=real, future (+1h) — keep
    await insertMcpClient({ isDcr: false, tenantId: tenantId, expiresAt: "now() + interval '1 hour'" });
    // Row 9: boundary — is_dcr=true, tenant_id=null, dcr_expires_at=now()+10s.
    // This row expires in the near future and is NOT deleted by this sweep (strict < predicate).
    // It demonstrates that only past-expiry rows (not current/future) are swept.
    await insertMcpClient({ isDcr: true, tenantId: null, expiresAt: "now() + interval '10 seconds'" });

    // Run sweepOnce using the dcrWorker prisma client
    const deleted = await sweepOnce(ctx.dcrWorker.prisma, 20, {
      intervalMs: 3_600_000,
      emitHeartbeatAudit: false,
    });

    // Assert exactly 1 row deleted (the target)
    expect(deleted).toBe(1);

    // Target row is gone
    const targetRemaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM mcp_clients WHERE id = $1::uuid`,
        targetId,
      );
    });
    expect(targetRemaining).toHaveLength(0);

    // All other 8 rows remain
    const otherRemaining = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM mcp_clients WHERE id = ANY($1::uuid[])`,
        seededClientIds.filter((id) => id !== targetId),
      );
    });
    expect(otherRemaining).toHaveLength(8);

    // audit_outbox has exactly 1 new PENDING row for SYSTEM_TENANT_ID
    const outboxRows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{
        id: string;
        tenant_id: string;
        payload: unknown;
        status: string;
      }[]>(
        `SELECT id, tenant_id, payload, status::text AS status
         FROM audit_outbox
         WHERE tenant_id = $1::uuid
         ORDER BY created_at DESC`,
        SYSTEM_TENANT_ID,
      );
    });
    expect(outboxRows).toHaveLength(1);
    const outboxRow = outboxRows[0];
    expect(outboxRow.tenant_id).toBe(SYSTEM_TENANT_ID);
    expect(outboxRow.status).toBe("PENDING");

    // Strict-shape assertion on audit payload
    const p = outboxRow.payload as Record<string, unknown>;
    expect(p.scope).toBe(AUDIT_SCOPE.TENANT);
    expect(p.action).toBe(AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP);
    expect(p.actorType).toBe(ACTOR_TYPE.SYSTEM);
    const metadata = p.metadata as Record<string, unknown>;
    expect(metadata[AUDIT_METADATA_KEY.PURGED_COUNT]).toBe(1);
    expect(metadata.triggeredBy).toBe("dcr-cleanup-worker");
    // Strict absence of forbidden fields
    expect(p.operatorId).toBeUndefined();
    expect(p.tokenSubjectUserId).toBeUndefined();
    expect(metadata.systemWide).toBeUndefined();

    // Drive chain-anchor assertion in-process via deliverRowWithChain
    const fullRow: AuditOutboxRow = {
      id: outboxRow.id,
      tenant_id: outboxRow.tenant_id,
      payload: outboxRow.payload,
      status: outboxRow.status,
      attempt_count: 0,
      max_attempts: 8,
      created_at: new Date(),
      next_retry_at: new Date(),
      processing_started_at: null,
      sent_at: null,
      last_error: null,
    };
    // deliverRowWithChain uses the outbox-worker's own prisma client (superuser)
    // to deliver the row and write the chain anchor.
    const workerPrisma = createPrismaForRole("superuser");
    try {
      const parsedPayload: AuditOutboxPayload = {
        scope: String(p.scope ?? ""),
        action: String(p.action ?? ""),
        userId: String(p.userId ?? ""),
        actorType: String(p.actorType ?? "HUMAN"),
        serviceAccountId: typeof p.serviceAccountId === "string" ? p.serviceAccountId : null,
        teamId: typeof p.teamId === "string" ? p.teamId : null,
        targetType: typeof p.targetType === "string" ? p.targetType : null,
        targetId: typeof p.targetId === "string" ? p.targetId : null,
        metadata: metadata,
        ip: typeof p.ip === "string" ? p.ip : null,
        userAgent: typeof p.userAgent === "string" ? p.userAgent : null,
      };
      await deliverRowWithChain(workerPrisma.prisma, fullRow, parsedPayload);
    } finally {
      await workerPrisma.prisma.$disconnect();
      await workerPrisma.pool.end();
    }

    // Assert audit_chain_anchors has a row for SYSTEM_TENANT_ID with chain_seq >= 1
    const anchors = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ chain_seq: bigint }[]>(
        `SELECT chain_seq FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        SYSTEM_TENANT_ID,
      );
    });
    expect(anchors).toHaveLength(1);
    expect(Number(anchors[0].chain_seq)).toBeGreaterThanOrEqual(1);
  });
});

// NOTE: This describe intentionally lives in this file because both suites
// mutate the global unclaimed-DCR namespace (mcp_clients WHERE is_dcr AND
// tenant_id IS NULL). File co-location guarantees serial execution under
// vitest file-parallelism — running them in separate files causes them to
// clobber each other's beforeEach seed/clear in parallel workers.
describe("DCR register lazy cleanup (real DB)", () => {
  let ctx: TestContext;
  let seededClientIds: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    seededClientIds = [];
    // Clear all pre-existing unclaimed DCR rows so counts are deterministic.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM mcp_clients WHERE is_dcr = true AND tenant_id IS NULL`,
      );
    });
  });
  afterEach(async () => {
    if (seededClientIds.length > 0) {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        for (const id of seededClientIds) {
          await tx.$executeRawUnsafe(
            `DELETE FROM mcp_clients WHERE id = $1::uuid`,
            id,
          );
        }
      });
    }
  });

  async function insertUnclaimedDcrClient(expiresAt: string): Promise<string> {
    const id = randomUUID();
    const clientIdStr = `test-cl-${id.slice(0, 12)}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at)
         VALUES ($1::uuid, $2, '', $3, '{}', 'credentials:list', true, NULL, ${expiresAt}, now(), now())`,
        id,
        clientIdStr,
        `client-${id.slice(0, 8)}`,
      );
    });
    seededClientIds.push(id);
    return id;
  }

  /**
   * Executes the same deleteMany-then-count transaction that register/route.ts
   * runs, using the production Prisma query shapes from that route.
   */
  async function runRegisterTx(): Promise<{ countAfterCleanup: number; deletedCount: number }> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      // Exact Prisma shapes from register/route.ts C6 lazy cleanup
      const deleteResult = await tx.mcpClient.deleteMany({
        where: { isDcr: true, tenantId: null, dcrExpiresAt: { lt: new Date() } },
      });
      const deletedCount = deleteResult.count;

      const countAfterCleanup = await tx.mcpClient.count({
        where: { isDcr: true, tenantId: null },
      });
      return { countAfterCleanup, deletedCount };
    });
  }

  it("expired unclaimed rows are removed by lazy cleanup, count falls below cap", async () => {
    // Seed MAX_UNCLAIMED_DCR_CLIENTS expired unclaimed rows via a single bulk INSERT
    // so the seed cost is constant regardless of the cap value (T2).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const valuePlaceholders = Array.from({ length: MAX_UNCLAIMED_DCR_CLIENTS }, (_, i) => {
        const base = i * 3 + 1;
        return `($${base}::uuid, $${base + 1}, 'hash', $${base + 2}, '{}', 'credentials:list', true, NULL, now() - interval '1 hour', now(), now())`;
      }).join(", ");
      const values: string[] = [];
      for (let i = 0; i < MAX_UNCLAIMED_DCR_CLIENTS; i++) {
        const id = randomUUID();
        seededClientIds.push(id);
        values.push(id, `test-bulk-exp-${id.slice(0, 8)}`, `client-bulk-exp-${i}`);
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at) VALUES ${valuePlaceholders}`,
        ...values,
      );
    });

    // Sanity: MAX rows exist before cleanup
    const beforeCount = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM mcp_clients WHERE is_dcr = true AND tenant_id IS NULL`,
      );
      return Number(rows[0]?.cnt ?? 0);
    });
    expect(beforeCount).toBe(MAX_UNCLAIMED_DCR_CLIENTS);

    const { countAfterCleanup, deletedCount } = await runRegisterTx();

    // All expired rows deleted
    expect(deletedCount).toBe(MAX_UNCLAIMED_DCR_CLIENTS);
    // Count is now below cap — a new registration would succeed
    expect(countAfterCleanup).toBe(0);
    expect(countAfterCleanup).toBeLessThan(MAX_UNCLAIMED_DCR_CLIENTS);
  });

  it("fresh (non-expired) unclaimed rows survive cleanup and reach cap, blocking registration", async () => {
    // Seed MAX_UNCLAIMED_DCR_CLIENTS fresh unclaimed rows via a single bulk INSERT (T2).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const valuePlaceholders = Array.from({ length: MAX_UNCLAIMED_DCR_CLIENTS }, (_, i) => {
        const base = i * 3 + 1;
        return `($${base}::uuid, $${base + 1}, 'hash', $${base + 2}, '{}', 'credentials:list', true, NULL, now() + interval '1 hour', now(), now())`;
      }).join(", ");
      const values: string[] = [];
      for (let i = 0; i < MAX_UNCLAIMED_DCR_CLIENTS; i++) {
        const id = randomUUID();
        seededClientIds.push(id);
        values.push(id, `test-bulk-fresh-${id.slice(0, 8)}`, `client-bulk-fresh-${i}`);
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO mcp_clients (id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_dcr, tenant_id, dcr_expires_at, created_at, updated_at) VALUES ${valuePlaceholders}`,
        ...values,
      );
    });

    const { countAfterCleanup, deletedCount } = await runRegisterTx();

    // No expired rows — nothing deleted
    expect(deletedCount).toBe(0);
    // All rows survive — count equals cap, registration would return 503
    expect(countAfterCleanup).toBe(MAX_UNCLAIMED_DCR_CLIENTS);
    expect(countAfterCleanup).toBeGreaterThanOrEqual(MAX_UNCLAIMED_DCR_CLIENTS);
  });
});
