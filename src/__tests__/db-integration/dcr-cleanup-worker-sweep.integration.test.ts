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
